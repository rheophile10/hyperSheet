import type { ValueCel } from "./valueCel.js";
import type { FormulaCel } from "./computeCels/formulaCel.js";
import type { EditableLambdaCel } from "./computeCels/editableLambdaCel.js";
import type { LockedLambdaCel } from "./computeCels/lockedLambdaCel.js";
import type { SchemaCel } from "./schemaCel.js";
import type { CompilerCel } from "./compilerCel.js";
import type { ChannelCel } from "./channelCel.js";
import type { RangeCel } from "./rangeCel.js";
import type { SegmentCel } from "./segmentCel.js";

// The unions ARE the public vocabulary. Runtime guards (isDataCel,
// isDefinitionCel, isFireable, kindOf) live in kernel/cels.ts.

export type Cel =
  | ValueCel
  | EditableLambdaCel
  | LockedLambdaCel
  | FormulaCel
  | SchemaCel
  | CompilerCel
  | ChannelCel
  | RangeCel
  | SegmentCel;

/** The DATA plane: cels that hold the application's values — what
 *  setValue writes (ValueCel.v / FormulaCel.f), the only cels allowed
 *  coordinates. Nothing compiles AGAINST a data cel, so data writes
 *  only ever trigger recalculation. */
export type DataCel = ValueCel | FormulaCel;

/** The DEFINITION plane: cels other cels compile against. Replaced
 *  wholesale via setCel (which bumps _defGen); never value-written,
 *  never positioned. */
export type DefinitionCel =
  | EditableLambdaCel | LockedLambdaCel | SchemaCel | CompilerCel
  | ChannelCel | RangeCel | SegmentCel;

/** The execution axis (orthogonal to the planes): cels whose body the
 *  cascade fires. FormulaCel is data×fireable; the lambdas are
 *  definition×fireable. */
export type FireableCel = FormulaCel | EditableLambdaCel | LockedLambdaCel;

export type LambdaCel = EditableLambdaCel | LockedLambdaCel;
