import type { BaseCelMetadata } from "../甲骨/index.js";
import type { BaseCel } from "./baseCel.js";

/** DATA plane. A plain value — the simplest cel there is. */
export interface ValueCel extends BaseCel {
  celType: "ValueCel";
  metadata: BaseCelMetadata;
  wave?: number;
}
