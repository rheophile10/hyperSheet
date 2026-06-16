import type { Key } from "../../index.js";
import type { Cel } from "../cel.js";
import type { WitType } from "../../wit.js";

// Runtime-fn companion types shared by the lambda cels (and by
// FormulaCel through CompiledEnvelope). These describe CODE, not cels.

export type ResolvedInputs = Record<string, Cel | undefined | Array<Cel | undefined>>;

export interface Fn<_I = unknown, O = unknown> {
  (...args: any[]): O | Promise<O>;
  extractDeps?: (source: string, state?: import("../../state.js").State) => Key[];
}

export interface CompiledEnvelope {
  fn: Fn;
  dispose?: () => void;
  buildEvaluate?: (
    inputs: ResolvedInputs,
    cspEvalAvailable: boolean,
  ) => (() => unknown) | Promise<() => unknown>;
  /** Optional wasm bytes produced by the compiler (wat today; javy/rust
   *  later). Stored on cel._wasm at hydrate for diagnostics and future
   *  worker dispatch. */
  wasm?: Uint8Array;
  /** Channels the compiled body participates in. compileCelBody merges
   *  these into cel.metadata.channel — a compiler can declare that its
   *  output is an EFFECT REQUEST committed by a drain (the binder form
   *  of named-function-cels declares ["defn.commit"] this way). */
  channels?: Key[];
}

export type CompiledLambda = Fn | CompiledEnvelope;

/** Per-compile context — cel-level hints the compiler needs to produce
 *  a per-cel-customized wrapper Fn. */
export interface CompileContext {
  outputSchema?: WitType;
  /** kind:"wasm" — the named export the cel exposes. */
  wasmExport?: string;
  /** kind:"wasm" — cel key of an imports-provider fn. */
  imports?: Key;
  /** The key of the cel being compiled. Lets a parser resolve references
   *  RELATIVE TO THE CEL'S OWN LOCATION — e.g. the infix parser resolves a
   *  bare A1 to `<self-segment>.A1` instead of a hardcoded prefix, so a sheet
   *  opened into a fresh segment re-evaluates its relative formulas. */
  selfKey?: Key;
}

export interface Compiler extends Fn {
  (
    source: string,
    state?: import("../../state.js").State,
    context?: CompileContext,
  ): CompiledLambda | Promise<CompiledLambda>;
  extractDeps?: (
    source: string,
    state?: import("../../state.js").State,
    context?: CompileContext,
  ) => Key[];
}

export type Recompile = (source: string) => Fn;
