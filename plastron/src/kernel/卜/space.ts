import type {
  Address, Cel, Coordinate, Key, NeighborOptions, NeighborSample, Range, State,
} from "../../types/index.js";
import { isDataCel } from "../cels.js";

// ── notation parsers (moved from types — types/ is type-only) ──────────────
//
//   A1 form      "A1", "B3", "AA10"     → [row, col], BOTH 1-based;
//                bijective base-26 columns (A=1 … Z=26, AA=27).
//   comma form   "1,1"  "3,-2,7"  "5"   → the integers verbatim.
//   address      "Seg!A1", "Seg!1,2", "A1", "1,2"
//   range        "Seg!A1:B3", "1,1:2,2" — corners normalize (B3:A1 ≡ A1:B3).

const SEGMENT_RE = /^[\w.-]+$/;
const A1_RE = /^([A-Za-z]+)([0-9]+)$/;
const COMMA_RE = /^-?\d+(?:,-?\d+)*$/;

/** Bijective base-26 column letters → 1-based index (A=1, Z=26, AA=27). */
const colIndex = (letters: string): number => {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
};

/** Parse Excel A1 notation → [row, col] (both 1-based), or undefined. */
export const parseA1 = (s: string): Coordinate[] | undefined => {
  const m = A1_RE.exec(s);
  if (!m) return undefined;
  const row = Number(m[2]);
  if (row < 1) return undefined; // Excel has no row 0
  return [row, colIndex(m[1]!)];
};

/** Parse a bare coordinate vector — A1 form or comma form ("5" is a
 *  valid 1-dim vector here, unlike coordinatesFromKey which requires a
 *  comma so bare-integer keys stay ordinary keys). */
export const parseCoordinates = (s: string): Coordinate[] | undefined => {
  const a1 = parseA1(s);
  if (a1) return a1;
  if (!COMMA_RE.test(s)) return undefined;
  return s.split(",").map(Number);
};

/** Parse "[Seg!]<coords>" → Address. */
export const parseAddress = (s: string): Address | undefined => {
  const bang = s.indexOf("!");
  let segment: Key | undefined;
  let rest = s;
  if (bang >= 0) {
    segment = s.slice(0, bang);
    if (!SEGMENT_RE.test(segment)) return undefined;
    rest = s.slice(bang + 1);
  }
  const coordinates = parseCoordinates(rest);
  if (!coordinates) return undefined;
  return segment === undefined ? { coordinates } : { segment, coordinates };
};

/** Parse "[Seg!]<corner>:<corner>" → Range. Corners normalize; the
 *  dimension counts must agree. */
export const parseRange = (s: string): Range | undefined => {
  const bang = s.indexOf("!");
  let segment: Key | undefined;
  let rest = s;
  if (bang >= 0) {
    segment = s.slice(0, bang);
    if (!SEGMENT_RE.test(segment)) return undefined;
    rest = s.slice(bang + 1);
  }
  const colon = rest.indexOf(":");
  if (colon < 0) return undefined;
  const from = parseCoordinates(rest.slice(0, colon));
  const to   = parseCoordinates(rest.slice(colon + 1));
  if (!from || !to || from.length !== to.length) return undefined;
  const at: Coordinate[] = [];
  const shape: number[] = [];
  for (let i = 0; i < from.length; i++) {
    const lo = Math.min(from[i]!, to[i]!);
    const hi = Math.max(from[i]!, to[i]!);
    at.push(lo);
    shape.push(hi - lo + 1);
  }
  const address: Address = segment === undefined
    ? { coordinates: at } : { segment, coordinates: at };
  return { at: address, shape };
};

/** Cheap predicate: could this token be range notation? */
export const isRangeNotation = (s: string): boolean =>
  s.includes(":") && parseRange(s) !== undefined;

/** Address → cel key: comma form, segment-qualified when present. */
export const addressToKey = (a: Address): Key =>
  (a.segment !== undefined ? `${a.segment}!` : "") + a.coordinates.join(",");

/** Tolerate authored RangeCel.v that is still a notation string. */
export const toRange = (v: unknown): Range | undefined => {
  if (typeof v === "string") return parseRange(v);
  const r = v as Range | undefined;
  if (r && Array.isArray(r.shape) && r.at && Array.isArray(r.at.coordinates)) return r;
  return undefined;
};

/** Enumerate a Range's member cel keys, row-major (last dimension
 *  varies fastest) — exactly the Key[] shape inputMap accepts. */
export const rangeToKeys = (range: Range | string): Key[] => {
  const r = toRange(range);
  if (!r) return [];
  const { coordinates } = r.at;
  const dims = coordinates.length;
  const out: Key[] = [];
  const cursor = [...coordinates];
  const walk = (d: number): void => {
    if (d === dims) {
      out.push(addressToKey({ ...r.at, coordinates: [...cursor] }));
      return;
    }
    for (let i = 0; i < r.shape[d]!; i++) {
      cursor[d] = coordinates[d]! + i;
      walk(d + 1);
    }
  };
  walk(0);
  return out;
};

// ============================================================================
// Coordinate space — conveniences for treating data cels as positioned
// values. Only DataCels (Value/Formula) carry coordinates; everything
// here resolves positions to keys via addressToKey ("seg!1,2" / "1,2")
// and reads through state.cels. These are READS — writes stay on the
// 契 tiers (setValue for member cels, setCel for named ranges).
// ============================================================================


const toAddress = (a: Address | Coordinate[] | string): Address | undefined => {
  if (typeof a === "string") return parseAddress(a);
  if (Array.isArray(a)) return { coordinates: a };
  return a;
};

/** Cel at a position — Address struct, bare coordinates, or notation
 *  ("grid!1,2", "B3"). */
export const celAt = (
  state: State, at: Address | Coordinate[] | string,
): Cel | undefined => {
  const addr = toAddress(at);
  return addr ? state.cels.get(addressToKey(addr)) : undefined;
};

/** Value at a position; undefined when no cel lives there. */
export const valueAt = (
  state: State, at: Address | Coordinate[] | string,
): unknown => celAt(state, at)?.v;

/** A range's member values as nested arrays, row-major — same shape a
 *  range literal evaluates to inside a formula. Accepts a Range struct
 *  or notation ("grid!A1:B3"). */
export const valuesInRange = (
  state: State, range: Range | string,
): unknown => {
  const r = toRange(range);
  if (!r) return undefined;
  const keys = rangeToKeys(r);
  let i = 0;
  const build = (d: number): unknown => {
    if (d === r.shape.length) return state.cels.get(keys[i++]!)?.v;
    const out = new Array<unknown>(r.shape[d]!);
    for (let j = 0; j < r.shape[d]!; j++) out[j] = build(d + 1);
    return out;
  };
  return build(0);
};


/** The values around a positioned cel, n-dimensionally. Accepts a cel,
 *  its key, or a position. The cel itself is never included. */
export const neighborsOf = (
  state: State,
  of: Cel | Key | Address | Coordinate[],
  opts?: NeighborOptions,
): NeighborSample[] => {
  let origin: Address | undefined;
  if (typeof of === "string") {
    const cel = state.cels.get(of);
    if (cel && isDataCel(cel) && cel.metadata.coordinates) {
      origin = { segment: keySegment(of), coordinates: cel.metadata.coordinates };
    } else {
      origin = toAddress(of);
    }
  } else if (Array.isArray(of)) {
    origin = { coordinates: of };
  } else if ("celType" in of) {
    const coords = of.metadata.coordinates;
    if (!coords) return [];
    origin = { segment: keySegment(of.metadata.key), coordinates: coords };
  } else {
    origin = of;
  }
  if (!origin) return [];

  const radius = opts?.radius ?? 1;
  const diagonal = opts?.diagonal ?? true;
  const includeEmpty = opts?.includeEmpty ?? false;
  const dims = origin.coordinates.length;
  const out: NeighborSample[] = [];
  const offset = new Array<number>(dims).fill(-radius);

  const visit = (): void => {
    if (offset.every((o) => o === 0)) return;
    const manhattan = offset.reduce((a, o) => a + Math.abs(o), 0);
    if (!diagonal && manhattan > radius) return;
    const coordinates = origin!.coordinates.map((c, i) => c + offset[i]!);
    const key = addressToKey({ ...origin!, coordinates });
    const cel = state.cels.get(key);
    if (cel === undefined && !includeEmpty) return;
    out.push({ coordinates, key, value: cel?.v });
  };

  // Odometer over the (2r+1)^dims hypercube.
  const walk = (d: number): void => {
    if (d === dims) { visit(); return; }
    for (let o = -radius; o <= radius; o++) {
      offset[d] = o;
      walk(d + 1);
    }
  };
  walk(0);
  return out;
};

/** Segment qualifier of a coordinate key ("grid!1,2" → "grid"). */
const keySegment = (key: Key): Key | undefined => {
  const bang = key.indexOf("!");
  return bang >= 0 ? key.slice(0, bang) : undefined;
};
