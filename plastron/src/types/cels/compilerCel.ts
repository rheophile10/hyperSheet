import type { Key } from "../index.js";
import type { CompilerCelMetadata } from "../甲骨/index.js";
import type { BaseCel } from "./baseCel.js";
import type { Compiler } from "./computeCels/lambda.js";

/** DEFINITION plane. v is the Compiler fn; locked by design. */
export interface CompilerCel extends BaseCel {
  celType: "CompilerCel";
  metadata: CompilerCelMetadata;
  v: Compiler;
  locked: true;
  f?: string;
  _key?: Key;
}
