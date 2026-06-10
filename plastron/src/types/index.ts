// ============================================================================
// Type barrel — the canonical TYPE surface. PURE `export type`: types/
// carries no runtime code. Guards/parsers/accessors live in the kernel
// (kernel/cels.ts, kernel/wit.ts, kernel/卜/space.ts, kernel/卜/graph.ts,
// kernel/segments/load.ts).
// ============================================================================

export type Key = string;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

// 甲骨 — the dehydrated world: 譜 + metadata lineage, DehydratedCel,
// manifests. (Pipeline: 契 → 兆 → 卜 → 甲骨.)
export type * from "./甲骨/index.js";

// The cel taxonomy (lore name 兆) — concrete cels, plane/execution
// unions, and their companion code types.
export type * from "./cels/index.js";

// VNode / RenderSpec — the view layer's value contract (see types/vnode.ts).
export type * from "./vnode.js";

// Wasm — WIT type model and handles.
export type { WitType, WitPrimitive, WitComposite, WasmHandle } from "./wit.js";

// Execution hooks & memo.
export type { MemoConfig, MemoCache, ExecutionAccumulator, HookFn } from "./hooks.js";

// State & lifecycle.
export type {
  State, Hydrate, Dehydrate, DehydrateOptions, CelSpec,
  PrecomputedIndexes, SegmentLoader,
} from "./state.js";

// SecretHandle — graph-safe reference to a secret (name only; never the value).
export type { SecretHandle, SecretHandleRef } from "./secret.js";

// Kernel operation options/results.
export type {
  CompileCelBodyOpts, TopoLevelsOptions,
  NeighborSample, NeighborOptions, CreateInitialStateOptions,
} from "./operations.js";
