import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns, makeCelError } from "../../../kernel/index.js";
import { el, text } from "../dom/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// collections — the boundary verbs of the collections doctrine
// (docs/1-design/1-under-consideration/collections-doctrine.md): converters
// and views that move tabular data BETWEEN forms, so tables are views over
// plain JSON-shaped values, not a new storage shape. The hub form is the
// LIST OF DICTS — what =sql/supabase already return, what dbseed consumes,
// what broadcast dot access (=D1:D9.age) reads.
// ============================================================================

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const blank = (v: unknown): boolean => v === null || v === undefined || v === "";

/** Nested row arrays (first row = headers) → list of dicts. */
const fromNested = (rowsIn: unknown[][], headers?: string[]): Dict[] => {
  const [head, ...body] = headers ? [headers, ...rowsIn] : rowsIn;
  const keys = (head ?? []).map((h) => String(h));
  return body
    .filter((r) => Array.isArray(r) && !r.every(blank))
    .map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i]])));
};

/** rows(data, headers?) — see the seed description for the accepted shapes. */
export const rowsOf: Fn = (data: unknown, headers?: unknown): unknown => {
  if (!Array.isArray(data)) return blank(data) ? [] : [data];
  if (data.every(isDict)) return data;                       // already the hub form
  const hdr = Array.isArray(headers) ? headers.map((h) => String(h)) : undefined;
  if (data.every(Array.isArray)) return fromNested(data as unknown[][], hdr);
  // Flat value list (the infix range shape): headers give the column count.
  if (!hdr || hdr.length === 0) {
    return makeCelError([], "value", "rows: flat data needs a headers range/list — =rows(A2:C4, A1:C1)");
  }
  const out: unknown[][] = [];
  for (let i = 0; i < data.length; i += hdr.length) out.push(data.slice(i, i + hdr.length));
  return fromNested(out, hdr);
};

const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/** table(rowsOrData, opts?) — list of dicts → an HTML table vnode. */
const tableFn: Fn = (data: unknown, opts?: unknown): unknown => {
  const rows = rowsOf(data);
  if (!Array.isArray(rows)) return rows;                     // conversion error propagates
  const o = isDict(opts) ? opts : {};
  const limit = typeof o.limit === "number" ? Math.max(0, Math.trunc(o.limit)) : undefined;
  const dicts = rows.filter(isDict);
  const cols: string[] = Array.isArray(o.cols)
    ? (o.cols as unknown[]).map((c) => String(c))
    : [...new Set(dicts.flatMap((r) => Object.keys(r)))];    // union, first-seen order
  const shown = limit !== undefined ? dicts.slice(0, limit) : dicts;
  const body = shown.map((r) =>
    el("tr", null, cols.map((c) => el("td", null, [text(cellText(r[c]))]))));
  if (limit !== undefined && dicts.length > limit) {
    body.push(el("tr", { class: "pl-table-more" }, [
      el("td", { colspan: String(cols.length) }, [text(`… ${dicts.length - limit} more`)]),
    ]));
  }
  return el("table", { class: "pl-table" }, [
    el("thead", null, [el("tr", null, cols.map((c) => el("th", null, [text(c)])))]),
    el("tbody", null, body),
  ]);
};

/** unique(list) — order-preserving structural dedupe. */
const uniqueFn: Fn = (list: unknown): unknown => {
  if (!Array.isArray(list)) return blank(list) ? [] : [list];
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const v of list) {
    const k = typeof v === "object" && v !== null ? `j:${JSON.stringify(v)}` : `${typeof v}:${String(v)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
};

/** jsonparse(s) — the runtime twin of `{…}`/`[…]` data entry. */
const jsonParseFn: Fn = (s: unknown): unknown => {
  if (typeof s !== "string") return s;                       // already a value
  try { return JSON.parse(s); }
  catch (e) { return makeCelError([], "value", e); }
};

export const name = "collections" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["rows",      rowsOf],
  ["table",     tableFn],
  ["unique",    uniqueFn],
  ["jsonparse", jsonParseFn],
]));
