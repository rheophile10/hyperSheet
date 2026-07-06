import type { 甲骨, Cel, DehydratedCel, Fn, Key } from "../../../types/index.js";
import { inflateCel } from "../../../kernel/index.js";
import schemaSegment from "./甲骨.json" with { type: "json" };

// ============================================================================
// buffer-schema — a SchemaCel that round-trips a BUFFER STRUCT: a plain object
// whose values may be TYPED ARRAYS (Float32Array/Uint16Array/Uint32Array/…)
// alongside JSON-native scalars/arrays (dims, counters, RNG state). The default
// dehydrate is JSON-only, so a cel holding sim/mesh/gpu buffers can't snapshot
// without this. Bind it on a cel via metadata.schema:"buffers".
//
//   dehydrate: { cells: Uint16Array, gen: 42, rng: [1,2,3] }
//           →  { cells: {__ta:"Uint16Array", b64:"…"}, gen: 42, rng: [1,2,3] }
//   hydrate:   the inverse — reconstructs each typed array from its dtype + b64.
//
// This is the snapshot half of the CPU-resident-SoA / dense-ECS interior: one
// native-fn cel holds the columns; this schema persists them. Stash RNG state
// as plain fields to keep a sim's deterministic replay. Generalises the base
// uint8array schema (js-common-schema) to every numeric dtype + the struct.
// ============================================================================

// base64 ⇄ bytes (atob/btoa via globalThis so a no-DOM lib build type-checks)
const _btoa = (globalThis as { btoa?: (s: string) => string }).btoa
  ?? ((s: string) => { throw new Error(`btoa unavailable: cannot encode ${s.length} bytes`); });
const _atob = (globalThis as { atob?: (s: string) => string }).atob
  ?? ((s: string) => { throw new Error(`atob unavailable: cannot decode ${s.length} chars`); });
const toBase64 = (bytes: Uint8Array): string => { let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!); return _btoa(s); };
const fromBase64 = (b64: string): Uint8Array => { const s = _atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };

type TACtor = { new (buf: ArrayBuffer): ArrayBufferView };
const CTORS: Record<string, TACtor> = {
  Float32Array, Float64Array,
  Int8Array, Uint8Array, Uint8ClampedArray,
  Int16Array, Uint16Array, Int32Array, Uint32Array,
} as unknown as Record<string, TACtor>;

type TAView = ArrayBufferView & { buffer: ArrayBuffer; byteOffset: number; byteLength: number; constructor: { name: string } };
const isTypedArray = (v: unknown): v is TAView => ArrayBuffer.isView(v) && !(v instanceof DataView);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v);
const isEncoded = (v: unknown): v is { __ta: string; b64: string } =>
  isPlainObject(v) && typeof (v as { __ta?: unknown }).__ta === "string" && typeof (v as { b64?: unknown }).b64 === "string";

/** dehydrate: typed-array fields → {__ta, b64}; everything else passes through. */
export const buffers_dehydrate: Fn = (v) => {
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (isTypedArray(x)) {
      const bytes = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
      out[k] = { __ta: x.constructor.name, b64: toBase64(bytes) };
    } else out[k] = x;
  }
  return out;
};

/** hydrate: {__ta, b64} → the live typed array of that dtype; rest passes through. */
export const buffers_hydrate: Fn = (v) => {
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (isEncoded(x)) {
      const Ctor = CTORS[x.__ta];
      if (!Ctor) { out[k] = x; continue; }       // unknown dtype → leave encoded (defensive)
      out[k] = new Ctor(fromBase64(x.b64).buffer as ArrayBuffer);
    } else out[k] = x;
  }
  return out;
};

/** isChanged: the host mutates the struct in place and signals materiality via a
 *  SEPARATE generation cel (two-level reactivity), so ref-eq is the right test. */
export const buffers_isChanged: Fn = (a, b) => a !== b;

export const name = (schemaSegment as unknown as 甲骨).name;

const fns: ReadonlyMap<Key, Fn> = new Map<Key, Fn>([
  ["buffers_isChanged", buffers_isChanged],
  ["buffers_hydrate", buffers_hydrate],
  ["buffers_dehydrate", buffers_dehydrate],
]);

export const cels: Cel[] = ((schemaSegment as unknown as 甲骨).cels).map((dc: DehydratedCel) => {
  const cel = inflateCel(dc);
  if (cel.celType === "LockedLambdaCel" || cel.celType === "EditableLambdaCel") {
    const fn = fns.get(cel.metadata.key);
    if (fn) cel._fn = fn;
  }
  return cel;
});
