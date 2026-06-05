import type { LambdaCelMetadata } from "../../甲骨/index.js";
import type { ComputeCel } from "./computeCel.js";
import type { Recompile } from "./lambda.js";

/** DEFINITION plane × fireable. A lambda whose source can be replaced
 *  (via setCel whole-cel replacement); `_compiler` is an optional bound
 *  Recompile an editor surface installs to skip registry lookups. */
export interface EditableLambdaCel extends ComputeCel {
  celType: "EditableLambdaCel";
  metadata: LambdaCelMetadata;
  _compiler?: Recompile;
}
