import type { BaseCelMetadata, CelType } from "../甲骨/index.js";
import type { Schema } from "./schemaCel.js";

// INSTRUMENTAL lineage — the root every concrete cel extends. Never
// exported from the cels barrel: nothing should accept "a BaseCel";
// use the Cel union, a plane union (DataCel/DefinitionCel), the
// execution union (FireableCel), or a concrete type.

export interface BaseCel {
  celType: CelType;
  metadata: BaseCelMetadata;
  v: unknown;
  locked?: boolean;
  schema?: Schema;
  /** Definition generation — stamped (from State.defGeneration) every
   *  time this cel's DEFINITION changes: a lambda's fn/source, a
   *  schema/compiler/channel/range cel's v, or wholesale replacement.
   *  Consumers compiled against an older generation detect staleness
   *  at fire time and recompile. Runtime-only; never dehydrated. */
  _defGen?: number;
}
