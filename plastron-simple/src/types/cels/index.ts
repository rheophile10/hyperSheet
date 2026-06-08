// ============================================================================
// The cel taxonomy — folder structure mirrors lineage. The kanji 兆
// names a cel; the lifecycle is 契 → 兆 → 卜 → 甲骨.
//
//   baseCel.ts                INSTRUMENTAL — never leaves this folder
//   ├── valueCel.ts           DATA
//   ├── computeCels/          the fireable branch
//   │   ├── computeCel.ts     INSTRUMENTAL — never leaves this folder
//   │   ├── formulaCel.ts     DATA × fireable
//   │   ├── editableLambdaCel.ts  DEFINITION × fireable
//   │   └── lockedLambdaCel.ts    DEFINITION × fireable
//   ├── schemaCel.ts          DEFINITION
//   ├── compilerCel.ts        DEFINITION
//   ├── channelCel.ts         DEFINITION
//   ├── rangeCel.ts           DEFINITION
//   └── segmentCel.ts         DEFINITION — a segment manifest (冊) as a cel
//
// Metadata lineage lives in ../甲骨/ (it is what dehydrates). Runtime
// guards/parsers live in the kernel (kernel/cels.ts, kernel/卜/space.ts).
// ============================================================================

export type { Cel, DataCel, DefinitionCel, FireableCel, LambdaCel } from "./cel.js";
export type { ValueCel } from "./valueCel.js";
export type { FormulaCel, SExp, RangeNode } from "./computeCels/formulaCel.js";
export type { EditableLambdaCel } from "./computeCels/editableLambdaCel.js";
export type { LockedLambdaCel } from "./computeCels/lockedLambdaCel.js";
export type {
  Fn, Compiler, CompileContext, CompiledLambda, CompiledEnvelope,
  ResolvedInputs, Recompile,
} from "./computeCels/lambda.js";
export type { Schema, SchemaCel, ZodToJsonSchema, JsonSchemaToZod } from "./schemaCel.js";
export type { CompilerCel } from "./compilerCel.js";
export type {
  Channel, ChannelKey, ChannelEnqueue, ChannelCel, FlushSpec, SetOpts,
} from "./channelCel.js";
export type { Address, Range, RangeCel } from "./rangeCel.js";
export type { SegmentCel } from "./segmentCel.js";
