import type { Key } from "../index.js";
import type { CelMetadata } from "./譜.js";

// The dehydrated cel — what a .甲 archive carries. celType is part of
// this contract (it is serialized), so it lives here; the live shapes
// in ../cels/ discriminate on it.

export type CelType =
  | "ValueCel"
  | "EditableLambdaCel"
  | "LockedLambdaCel"
  | "SchemaCel"
  | "FormulaCel"
  | "CompilerCel"
  | "ChannelCel"
  | "RangeCel"
  | "SegmentCel";

export interface DehydratedCel {
  key: Key;
  celType: CelType;
  metadata: CelMetadata;
  wave?: number;
  locked?: boolean;
  dynamic?: boolean;
  /** Source body for fireable cels. Accepts string OR string[]; the
   *  array form is a hand-authoring convenience that inflateCel always
   *  collapses into a single \n-joined string. On dehydrate, opt-in via
   *  `cel.schema.protocols.sourceDehydrate` can split it back out.
   *  Live ComputeCel.f is always a single string. */
  f?: string | string[];
}

/** Dehydrated channel — round-trippable. drain/dispose are Keys naming
 *  cels in state.cels (resolved through resolveFn); the kernel supplies
 *  default enqueue/hasPending at hydrate. */
export interface DehydratedChannel {
  drain: Key;
  dispose?: Key;
}
