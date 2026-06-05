import type { Cel, Coordinate, DataCel, DefinitionCel, FireableCel, Key } from "../types/index.js";

// ============================================================================
// Runtime companions to types/cels — the guards and key parsing the
// type folder is not allowed to carry (types/ is `export type` only).
// ============================================================================

export const isDataCel = (c: Cel): c is DataCel =>
  c.celType === "ValueCel" || c.celType === "FormulaCel";

export const isDefinitionCel = (c: Cel): c is DefinitionCel =>
  !isDataCel(c);

/** True when the cel's kind has an fn body the cascade fires. Narrows
 *  to FireableCel so the kernel can read `_fn`, `_evaluate`, etc. */
export const isFireable = (c: Cel): c is FireableCel =>
  c.celType === "FormulaCel"
  || c.celType === "EditableLambdaCel"
  || c.celType === "LockedLambdaCel";

/** Execution-domain tag for a fireable cel — "js" for formulas, the
 *  lambda's metadata.kind otherwise (defaulting "js"). */
export const kindOf = (c: FireableCel): Key => {
  if (c.celType === "FormulaCel") return "js";
  return c.metadata.kind ?? "js";
};

/** Derive a coordinate vector from a cel key of comma-separated
 *  integers ("3,1", "0,-2,7"), optionally segment-qualified
 *  ("grid!3,1"). Cheap comma check first; anything else (including a
 *  bare "5") returns undefined. Called at cel creation to
 *  auto-populate metadata.coordinates on DATA cels. */
const COORD_KEY = /^(?:[\w.-]+!)?-?\d+(?:,-?\d+)+$/;
export const coordinatesFromKey = (key: Key): Coordinate[] | undefined => {
  if (!key.includes(",")) return undefined;
  if (!COORD_KEY.test(key)) return undefined;
  const bang = key.indexOf("!");
  const coords = bang >= 0 ? key.slice(bang + 1) : key;
  return coords.split(",").map(Number);
};
