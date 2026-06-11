import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn, ensureSegments } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// sqlite — in-browser SQLite (sql.js) as a reusable, OPFS-backed capability,
// extracted from origin (apps-are-cels: a thing you'd write TS for → a
// library). STATEFUL (the doctrine allows library state): the loaded sql.js
// module + open db handles live at module scope. Persists each db to a file
// under /plastron/dbs via the file-store library.
//
// The bundle inlines sql-wasm.js + the wasm bytes (globalThis.initSqlJs /
// __sqliteWasm) for offline use; loadSqlJs uses those and falls back to the
// CDN (via the kernel loadScript) only when not bundled. Host verbs (=db/=sql/
// =tables) emit a descriptor whose drain delegates to sqlite.command here.
// ============================================================================

interface SqlDb { exec(q: string): { columns: string[]; values: unknown[][] }[]; export(): Uint8Array; }
interface SqlJs { Database: new (bytes?: Uint8Array) => SqlDb; }

let _sqlJs: SqlJs | null = null;
const _dbs = new Map<string, SqlDb>();
const sqliteCdn = (): string => (globalThis as { __sqliteCdn?: string }).__sqliteCdn ?? "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.14.1/";
const dbFile = (name: string): string => `/plastron/dbs/${name}.db`;
const WRITE_SQL = /^\s*(insert|update|delete|create|drop|alter|replace|begin|commit|vacuum)\b/i;

const loadSqlJs = async (state: State): Promise<SqlJs> => {
  if (_sqlJs) return _sqlJs;
  const g = globalThis as {
    initSqlJs?: (o: { locateFile?: (f: string) => string; wasmBinary?: Uint8Array }) => Promise<SqlJs>;
    __sqliteWasm?: Uint8Array;
  };
  if (g.initSqlJs && g.__sqliteWasm) { _sqlJs = await g.initSqlJs({ wasmBinary: g.__sqliteWasm }); return _sqlJs; }
  const base = sqliteCdn();
  await (resolveFn(state, "loadScript") as Fn)(state, `${base}sql-wasm.js`);
  if (!g.initSqlJs) throw new Error("sqlite: sql.js failed to load");
  _sqlJs = await g.initSqlJs({ locateFile: (f: string) => base + f });
  return _sqlJs;
};

const openDb = async (state: State, name: string): Promise<SqlDb> => {
  const cached = _dbs.get(name);
  if (cached) return cached;
  const SQL = await loadSqlJs(state);
  await ensureSegments(state, ["file-store"]);
  let bytes: Uint8Array | undefined;
  try { bytes = (await (resolveFn(state, "fs.read") as Fn)(dbFile(name))) as Uint8Array; } catch { /* new db */ }
  const db = bytes && bytes.length ? new SQL.Database(bytes) : new SQL.Database();
  _dbs.set(name, db);
  return db;
};

const persistDb = async (state: State, name: string, db: SqlDb): Promise<void> => {
  await ensureSegments(state, ["file-store"]);
  await (resolveFn(state, "fs.mkdir") as Fn)("/plastron/dbs");
  await (resolveFn(state, "fs.write") as Fn)(dbFile(name), db.export());
};

// sqlite.command(state, op, name, query) — the db vocabulary's logic. Returns a
// handle ({__db}), a row array, "ok", or an error string.
const sqliteCommand: Fn = (async (state: State, op: unknown, name: unknown, query: unknown): Promise<unknown> => {
  const o = String(op ?? ""); const nm = String(name ?? "main");
  if (o === "open") { await openDb(state, nm); return { __db: nm }; }
  if (o === "sql") {
    const db = await openDb(state, nm);
    const q = String(query ?? "");
    const res = db.exec(q);
    if (WRITE_SQL.test(q)) await persistDb(state, nm, db);
    if (res.length && res[0]!.values.length) {
      const { columns, values } = res[0]!;
      return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
    }
    return res.length ? [] : "ok";
  }
  return `(unknown db op: ${o})`;
}) as Fn;

export const name = "sqlite" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sqlite.command", sqliteCommand],
]));
