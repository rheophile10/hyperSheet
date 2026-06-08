import type { ComputeCelMetadata } from "../../甲骨/index.js";
import type { MemoCache } from "../../hooks.js";
import type { BaseCel } from "../baseCel.js";
import type { Cel } from "../cel.js";
import type { Channel } from "../channelCel.js";
import type { Fn, ResolvedInputs } from "./lambda.js";

// INSTRUMENTAL lineage — the fireable branch's base: everything with an
// fn body the cascade dispatches. Never exported from the barrel; the
// kernel narrows to FireableCel (the closed union of the three
// concretes below) via isFireable instead.

export interface ComputeCel extends BaseCel {
  metadata: ComputeCelMetadata;
  // Formula source (S-expression for FormulaCel, host-language source
  // for EditableLambdaCel). Absent on native LockedLambdaCels seeded
  // with `_fn` directly.
  f?: string;
  wave?: number;
  dynamic?: boolean;
  /** State.defGeneration at the moment this cel last compiled. The
   *  cascade compares each definition-class input's _defGen against
   *  this; any newer definition forces recompile-then-evaluate. */
  _compiledGen?: number;
  _fn?: Fn;
  _dispose?: () => void;
  _inputEntries?: Array<[string, Cel | undefined | Array<Cel | undefined>]>;
  _channelHandlers?: Channel[];
  /** L1 memo cache. Populated at hydrate when metadata.memo is set and
   *  the eligibility check passes. Implementation: kernel/卜/memo-cache.ts. */
  _memoCache?: MemoCache;
  _buildEvaluate?: (
    inputs: ResolvedInputs,
    cspEvalAvailable: boolean,
  ) => (() => unknown) | Promise<() => unknown>;
  _evaluate?: () => unknown;
  /** Wasm binary produced by the compiler when the source is a wasm
   *  language. Read by wasm-to-wat diagnostics and future worker dispatch. */
  _wasm?: Uint8Array;
}
