import type { WasmHandle, WitPrimitive, WitType } from "../types/index.js";

// Runtime companions to types/wit — the guards the type folder is not
// allowed to carry (types/ is `export type` only).

/** Discriminator predicate for primitives. Useful in bridge cels and
 *  precompute layers that route scalars (inline JS numbers / BigInts /
 *  booleans) differently from composites (handles into worker tables). */
export const isWitPrimitive = (t: WitType): t is WitPrimitive => {
  switch (t.kind) {
    case "bool": case "u32": case "s32": case "u64": case "s64":
    case "f32":  case "f64": case "char": case "string": return true;
    default: return false;
  }
};

export const isWasmHandle = (v: unknown): v is WasmHandle => {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.kind === "string"
    && typeof o.ref === "number"
    && typeof o.type === "object" && o.type !== null;
};
