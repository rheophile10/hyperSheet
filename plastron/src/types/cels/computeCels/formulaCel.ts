import type { Key } from "../../index.js";
import type { FormulaCelMetadata } from "../../甲骨/index.js";
import type { Range } from "../rangeCel.js";
import type { ComputeCel } from "./computeCel.js";

/** DATA plane × fireable. A formula's f (source) IS its content — the
 *  spreadsheet gesture; setValue writes it, the cascade computes v. */
export interface FormulaCel extends ComputeCel {
  celType: "FormulaCel";
  metadata: FormulaCelMetadata;
}

/** AST node for a range in a formula — produced by the parser when a
 *  bare atom is range notation ("Seg!A1:B3", "1,1:2,2") or when a
 *  symbol resolves to a RangeCel (a named range; `source` carries its
 *  key). `keys` is the row-major member enumeration, baked at parse
 *  time. Guard: kernel/卜/formula.ts isRangeNode. */
export interface RangeNode {
  range: Range;
  keys: Key[];
  source?: Key;
}

export type SExp = number | string | RangeNode | SExp[];
