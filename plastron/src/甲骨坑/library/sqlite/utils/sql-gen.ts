// Pure SQL generation + schema shaping for the sqlite segment. No engine, no
// IO — these are the parts of the seed / schema / verb plumbing that are
// unit-testable under Bun (the OPFS-backed engine itself is browser-only).

/** Quote a JS value as a SQLite literal. Strings double their single quotes;
 *  objects/arrays serialize to JSON text; non-finite numbers become NULL. */
export const sqlLiteral = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "bigint") return String(v);
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return `'${s.replace(/'/g, "''")}'`;
};

/** Quote an identifier (table / column) with double quotes. */
export const ident = (name: string): string => `"${String(name).replace(/"/g, '""')}"`;

/** Build a bulk INSERT from a JSON array of row objects. Columns are the
 *  union of keys across all rows, in first-seen order. Returns "" for an
 *  empty array (caller treats that as a no-op). Values are inlined (escaped)
 *  rather than bound — the seed source is the user's own local JSON, and
 *  inlining keeps the op engine-agnostic (works through a plain exec). */
export const buildInsert = (
  table: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): string => {
  if (!rows.length) return "";
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  const colList = cols.map(ident).join(", ");
  const valuesSql = rows
    .map((r) => `(${cols.map((c) => sqlLiteral(r[c])).join(", ")})`)
    .join(",\n  ");
  return `INSERT INTO ${ident(table)} (${colList}) VALUES\n  ${valuesSql};`;
};

// ── schema introspection shaping ─────────────────────────────────────────────
// PRAGMA table_info(<t>)       rows: { cid, name, type, notnull, dflt_value, pk }
// PRAGMA foreign_key_list(<t>) rows: { id, seq, table, from, to, … }

export interface ColumnInfo { name: string; type: string; pk: boolean; notnull: boolean }
export interface FkInfo { from: string; table: string; to: string }
export interface TableSchema { name: string; columns: ColumnInfo[]; fks: FkInfo[] }

/** Shape one table's raw PRAGMA rows into a TableSchema. PK/FK are surfaced
 *  as first-class data — groundwork for the future drag-tables/draw-links
 *  visual query designer (forcegraph substrate). */
export const shapeTable = (
  name: string,
  tableInfo: ReadonlyArray<Record<string, unknown>>,
  fkList: ReadonlyArray<Record<string, unknown>>,
): TableSchema => ({
  name,
  columns: tableInfo.map((r) => ({
    name: String(r.name ?? ""),
    type: String(r.type ?? ""),
    pk: Number(r.pk ?? 0) > 0,
    notnull: Number(r.notnull ?? 0) > 0,
  })),
  fks: fkList.map((r) => ({
    from: String(r.from ?? ""),
    table: String(r.table ?? ""),
    to: String(r.to ?? ""),
  })),
});

/** Cap a result set to the first N rows (the "top 100" client view). Returns
 *  the rows plus whether the set was truncated. */
export const capRows = <T>(rows: ReadonlyArray<T>, limit = 100): { rows: T[]; truncated: boolean } =>
  ({ rows: rows.slice(0, limit), truncated: rows.length > limit });
