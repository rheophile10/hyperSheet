import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, makeCelError } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// nanosteg — the marshalling glue between the JS/canvas world and the
// NanoSteg WAT module's linear memory. MECHANISM ONLY: the whole steg
// algorithm (FNV-1a seed, splitmix64 PRNG, collision-avoided carrier probe,
// LSB read/write, the "NS" header) lives in the WAT SOURCE on the sheet
// (kind:"wat", captured through nanosteg.host). These verbs only copy bytes
// in and out at fixed protocol offsets and call the module's exports.
//
//   nanosteg.host                                    → imports-provider that
//       captures the WAT module's live instance (memory + exports) per State.
//   nanosteg.embed(rgba, w, h, payload, pass, core)  → RGBA8 with the payload
//       hidden in the R/G/B LSBs; a capacity CelError when it does not fit.
//   nanosteg.decode(rgba, w, h, pass, core)          → recovered UTF-8 text,
//       or a readable "wrong password" string on a magic miss (blind: no cover).
//
// The `core` argument is the WAT cel itself — passed so the embed/decode
// formula takes a dependency edge on it (edit the WAT source → recompile →
// re-instantiate → these verbs re-fire; R4/R7-clean). Its captured instance
// is looked up per State below.

// Fixed memory layout — protocol constants shared with the WAT source (R2
// permits protocol constants). Must stay in lock-step with the WAT module.
const RGBA_OFF = 0x000000;    // RGBA8 pixel buffer, 4·W·H bytes (alpha never touched)
const BITSET_OFF = 0x800000;  // used-carrier bitset, ⌈3·W·H/8⌉ bytes
const PW_OFF = 0xA00000;      // password bytes
const PAYLOAD_OFF = 0xA10000; // payload bytes (in on embed, out on decode)
const HDR_TOP = 0xB00008;     // header scratch top (7 bytes at 0xB00000 + slack)

type WasmMemory = { buffer: ArrayBuffer; grow: (pages: number) => number };
type WasmInstance = {
  exports: {
    mem: WasmMemory;
    hash_password: (ptr: number, len: number) => void;
    embed: (w: number, h: number, len: number) => number;
    decode: (w: number, h: number) => number;
  } & Record<string, unknown>;
};

// R3-sanctioned pattern: per-State registry of captured instances. onInstantiate
// (fired by the wat compiler's host-instance hook) writes here; embed/decode read.
const hostStore = new WeakMap<State, WasmInstance>();

// nanosteg.host — the imports provider named on the WAT cel's metadata.imports.
// The module imports nothing, so `imports` is empty; the hook exists purely to
// capture the live instance after WebAssembly.instantiate.
const host: Fn = ((_state?: State) => ({
  imports: {},
  onInstantiate: (instance: WasmInstance, state: State): void => { hostStore.set(state, instance); },
})) as Fn;

// Formula verbs receive evaluated args, not the kernel State (see doom/index.ts).
// Recover the live State the host publishes on globalThis.plastron.state (set in
// origin-main.ts; the e2e reads it the same way). Direct callers/tests can also
// publish it there.
const recoverState = (): State | undefined =>
  (globalThis as { plastron?: { state?: State } }).plastron?.state;

const enc = new TextEncoder();
const dec = new TextDecoder();

const toU8 = (v: unknown): Uint8Array => {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return enc.encode(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (v && ArrayBuffer.isView(v as ArrayBufferView)) {
    const view = v as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return enc.encode(String(v ?? ""));
};

const getInstance = (): WasmInstance => {
  const state = recoverState();
  const inst = state ? hostStore.get(state) : undefined;
  if (!inst) {
    throw new Error(
      "nanosteg: the WAT core is not instantiated — the nanosteg.core cell (kind:\"wat\", " +
      "imports:\"nanosteg.host\") must be compiled first.",
    );
  }
  return inst;
};

// Grow the module memory so [0, top) is addressable, then return a fresh view
// (memory.grow can detach the old ArrayBuffer).
const ensure = (inst: WasmInstance, top: number): Uint8Array => {
  const have = inst.exports.mem.buffer.byteLength;
  if (have < top) inst.exports.mem.grow(Math.ceil((top - have) / 65536));
  return new Uint8Array(inst.exports.mem.buffer);
};

// nanosteg.embed(rgba, w, h, payload, password, core) → RGBA8 Uint8Array.
const embed: Fn = ((rgba: unknown, w: unknown, h: unknown, payload: unknown, password: unknown, _core?: unknown) => {
  try {
    const inst = getInstance();
    const W = Number(w), H = Number(h);
    const src = toU8(rgba), pay = toU8(payload), pw = toU8(password);
    if (!Number.isInteger(W) || !Number.isInteger(H) || W <= 0 || H <= 0) throw new Error("nanosteg.embed: w and h must be positive integers.");
    if (src.length < 4 * W * H) throw new Error(`nanosteg.embed: rgba too small (${src.length} bytes for ${W}×${H}).`);
    const C = 3 * W * H;
    if (56 + 8 * pay.length > C) {
      return makeCelError(["nanosteg.embed"], "CapacityError",
        new Error(`payload does not fit: needs ${56 + 8 * pay.length} bits of ${C} carriers (${W}×${H}). Use a larger cover or a shorter message.`));
    }
    const top = Math.max(4 * W * H, BITSET_OFF + Math.ceil(C / 8), PW_OFF + pw.length, PAYLOAD_OFF + pay.length, HDR_TOP);
    const view = ensure(inst, top);
    view.set(src.subarray(0, 4 * W * H), RGBA_OFF);
    view.set(pw, PW_OFF);
    view.set(pay, PAYLOAD_OFF);
    inst.exports.hash_password(PW_OFF, pw.length);
    const status = inst.exports.embed(W, H, pay.length);
    if (status < 0) {
      return makeCelError(["nanosteg.embed"], "CapacityError", new Error(`embed rejected the payload (status ${status}).`));
    }
    // Fresh view — the embed call cannot grow memory, but stay defensive.
    return new Uint8Array(inst.exports.mem.buffer).slice(RGBA_OFF, RGBA_OFF + 4 * W * H);
  } catch (e) { return makeCelError(["nanosteg.embed"], "NanoStegError", e); }
}) as Fn;

const WRONG_PW = "⚠ wrong password / no NanoSteg payload in this image";

// nanosteg.decode(rgba, w, h, password, core) → recovered text (blind: no cover).
const decode: Fn = ((rgba: unknown, w: unknown, h: unknown, password: unknown, _core?: unknown) => {
  try {
    const inst = getInstance();
    const W = Number(w), H = Number(h);
    const src = toU8(rgba), pw = toU8(password);
    if (!Number.isInteger(W) || !Number.isInteger(H) || W <= 0 || H <= 0) throw new Error("nanosteg.decode: w and h must be positive integers.");
    if (src.length < 4 * W * H) throw new Error(`nanosteg.decode: rgba too small (${src.length} bytes for ${W}×${H}).`);
    const C = 3 * W * H;
    const top = Math.max(4 * W * H, BITSET_OFF + Math.ceil(C / 8), PW_OFF + pw.length, PAYLOAD_OFF, HDR_TOP);
    const view = ensure(inst, top);
    view.set(src.subarray(0, 4 * W * H), RGBA_OFF);
    view.set(pw, PW_OFF);
    inst.exports.hash_password(PW_OFF, pw.length);
    const len = inst.exports.decode(W, H);
    if (len === -1) return WRONG_PW;                       // magic miss ⇒ wrong password (blind auth check)
    if (len < 0) return WRONG_PW;                          // insane length ⇒ same clean message
    const out = new Uint8Array(inst.exports.mem.buffer).slice(PAYLOAD_OFF, PAYLOAD_OFF + len);
    return dec.decode(out);
  } catch (e) { return makeCelError(["nanosteg.decode"], "NanoStegError", e); }
}) as Fn;

export const name = "nanosteg" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["nanosteg.host",   host],
  ["nanosteg.embed",  embed],
  ["nanosteg.decode", decode],
]));
