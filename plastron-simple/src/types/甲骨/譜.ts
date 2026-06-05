import type { JsonValue, Key } from "../index.js";
import type { MemoConfig } from "../hooks.js";

// ============================================================================
// 譜 + the metadata lineage — the dehydrated identity of every cel.
// Metadata is exactly what survives dehydration (DehydratedCel carries
// it verbatim), which is why the whole lineage lives here in 甲骨
// rather than beside the live cel shapes.
// ============================================================================

/** The named-record root every metadata shape extends. */
export interface 譜 {
  key?: Key;
  name?: string;
  description?: string;
  [k: string]: unknown;
}

/** One axis of a cel's position — numeric only (grid columns, layers,
 *  continuous space). Labeled axes (sheet names) belong in the key /
 *  segment, not the coordinate vector: coordinates exist for numeric
 *  adjacency math (neighbors, ranges), which strings would poison.
 *  Derivation from keys: kernel/cels.ts coordinatesFromKey. */
export type Coordinate = number;

export interface BaseCelMetadata extends 譜 {
  key: Key;
  segment: Key;
  schema?: Key;
  v?: JsonValue;
  channel?: Key[];
  /** Optional n-length position vector, e.g. [3, 1] or [0, -2, 7].
   *  DATA cels only (Value/Formula) — definition cels are named, never
   *  positioned. Auto-populated from comma-separated-integer keys at
   *  cel creation (kernel/cels.ts coordinatesFromKey); explicit values
   *  win. The kernel does not interpret it beyond that: hydrate/
   *  dehydrate carry it verbatim and the cascade ignores it. */
  coordinates?: Coordinate[];
}

export interface ComputeCelMetadata extends BaseCelMetadata {
  inputMap?: Record<string, Key | Key[]>;
  /** Optional per-input kind declaration. When present, hydrate
   *  validates that the source cel referenced via inputMap[name] has a
   *  matching kindOf — refuses to wire a kind="wat" input from a
   *  kind="js" source without an explicit bridge in between. Absent
   *  entries skip validation. */
  inputKinds?: Record<string, Key>;
  /** Cel keys whose _fn runs as a reducer over an ExecutionAccumulator
   *  before this cel's _fn. A pre-fn may set acc.output to short-circuit
   *  _fn (used by L2 cache strategies). */
  preFns?: Key[];
  /** Cel keys whose _fn runs as a reducer after this cel's _fn (or
   *  after a pre-fn short-circuit). */
  postFns?: Key[];
  /** When present, enables L1 in-memory memoization for this cel.
   *  Eligibility checked at hydrate. */
  memo?: MemoConfig;
}

export interface FormulaCelMetadata extends ComputeCelMetadata {
  parser?: Key;
}

export interface LambdaCelMetadata extends ComputeCelMetadata {
  kind?: string;
  filename?: string;
  inputSchema?: Key;
  outputSchema?: Key;
  /** kind:"wasm" only — which module export to expose as the cel's Fn. */
  wasmExport?: string;
  /** kind:"wasm" only — cel key of an imports-provider fn. */
  imports?: Key;
}

export interface ChannelCelMetadata extends BaseCelMetadata {
  drain: Key;
  dispose?: Key;
}

export interface CompilerCelMetadata extends BaseCelMetadata {
  kind?: string;
}

/** Loose union shape kept for DehydratedCel and inflate-time
 *  intermediates. Live Cels use their kind-specific metadata. */
export interface CelMetadata extends BaseCelMetadata {
  compiler?: Key;
  kind?: string;
  inputMap?: Record<string, Key | Key[]>;
  inputKinds?: Record<string, Key>;
}
