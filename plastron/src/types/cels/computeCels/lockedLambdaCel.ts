import type { LambdaCelMetadata } from "../../甲骨/index.js";
import type { ComputeCel } from "./computeCel.js";

/** DEFINITION plane × fireable. A native/locked lambda — kernel fns
 *  and compiler-built runtimes land here; locked is part of the type. */
export interface LockedLambdaCel extends ComputeCel {
  celType: "LockedLambdaCel";
  metadata: LambdaCelMetadata;
  locked: true;
}
