import type { Key } from "../index.js";
import type { Coordinate } from "../甲骨/index.js";
import type { BaseCel } from "./baseCel.js";

// Addresses & ranges — spatial references over coordinate-keyed cels.
// TYPES only; the notation parsers (parseA1, parseRange, rangeToKeys…)
// live in kernel/卜/space.ts.

/** One position: optional segment qualifier + n-dim coordinates. */
export interface Address {
  segment?: Key;
  coordinates: Coordinate[];
}

/** A rectangular n-dim region: anchor + per-dimension extent (each ≥ 1).
 *  shape.length === at.coordinates.length. A single cel is shape [1,…,1];
 *  "A1:B3" is { at: [1,1], shape: [3,2] }. */
export interface Range {
  at: Address;
  shape: number[];
}

/** DEFINITION plane. A named range — v is the Range struct (authoring
 *  may write notation; inflateCel parses it). Referencing one in a
 *  formula expands to member values with member keys wired as edges. */
export interface RangeCel extends BaseCel {
  celType: "RangeCel";
  v: Range;
}
