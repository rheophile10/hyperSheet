import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import { buildInsert, shapeTable, ident } from "./utils/sql-gen.js";
import { fsOps } from "../file-store/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// sqlite — in-browser SQLite via @sqlite.org/sqlite-wasm over the opfs-sahpool
// VFS, running in a Worker. Persistent + incremental (writes touch changed pages,
// not the whole file) and needs no COOP/COEP headers, so it works on static
// Pages. STATEFUL (library state is allowed): one worker + per-db handles live
// in the worker; the main thread holds only the promiser plumbing.
//
// Browser-only: the sync OPFS handles the VFS needs exist only in a Worker. The
// worker file + sqlite3.mjs + sqlite3.wasm are shipped next to index.html by the
// host bundle; its URL is globalThis.__sqliteWorkerUrl (default ./sqlite-worker.mjs).
//
// The worker is a generic exec engine (raw SQL → rows); the seed / schema LOGIC
// stays here (reusing utils/sql-gen.ts). Host verbs (=db/=sql/=tables/=dbseed/
// =schema/=dbexport/=dbimport) emit a descriptor whose drain delegates to
// sqlite.command.
//
// import/export are the bridge to file-store: the SAH pool stores opaque
// capacity files, not a browsable `<name>.db`, so a portable .db only exists by
// asking the engine to serialize one (export) or by handing it bytes (import).
// =dbexport(db, path) serializes the db and writes the blob to a file-store path
// (browsable / downloadable); =dbimport(db, path) reads such a file and loads it
// into the pool. The live VFS still bypasses file-store — only the blob crosses.
// ============================================================================

const WRITE_SQL = /^\s*(insert|update|delete|create|drop|alter|replace|begin|commit|vacuum)\b/i;

// ── worker harness (promiser + pending-map, the py-worker shape) ──────────────
interface WorkerLike {
  postMessage: (m: unknown) => void;
  addEventListener: (t: "message" | "error", h: (e: { data?: unknown; message?: string }) => void) => void;
  terminate: () => void;
}
interface WorkerCtor { new (url: URL | string, opts?: { type?: "module" }): WorkerLike }

interface WorkerMsg { id?: number; ok?: boolean; rows?: Record<string, unknown>[]; bytes?: Uint8Array; error?: string }

let _worker: WorkerLike | undefined;
let _nextId = 1;
const _pending = new Map<number, { resolve: (v: WorkerMsg) => void; reject: (e: unknown) => void }>();

const workerUrl = (): string =>
  (globalThis as { __sqliteWorkerUrl?: string }).__sqliteWorkerUrl ?? "./sqlite-worker.mjs";

const getWorker = (): WorkerLike => {
  if (_worker) return _worker;
  const g = globalThis as { Worker?: WorkerCtor; location?: { href?: string } };
  if (!g.Worker) {
    throw new Error(
      "sqlite: browser-only — the opfs-sahpool engine needs a Worker + OPFS, " +
      "which this environment doesn't provide.",
    );
  }
  const base = g.location?.href;
  const url = base ? new URL(workerUrl(), base) : workerUrl();
  const w = new g.Worker(url, { type: "module" });
  w.addEventListener("message", (e) => {
    const msg = (e.data ?? {}) as WorkerMsg;
    if (msg.id === undefined) return;
    const slot = _pending.get(msg.id); if (!slot) return;
    _pending.delete(msg.id);
    if (msg.ok) slot.resolve(msg);
    else slot.reject(new Error(msg.error ?? "sqlite worker error"));
  });
  w.addEventListener("error", (e) => {
    const err = new Error("sqlite worker crashed: " + (e.message ?? "unknown"));
    for (const s of _pending.values()) s.reject(err);
    _pending.clear();
  });
  _worker = w;
  return w;
};

/** Post one message to the worker and resolve with its reply (rejects on a
 *  worker-side error). The single seam every db operation rides. */
const request = (msg: Record<string, unknown>): Promise<WorkerMsg> => {
  const w = getWorker();
  const id = _nextId++;
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    w.postMessage({ id, ...msg });
  });
};

/** Run one SQL string against db `name` in the worker; resolve with row objects
 *  (empty for non-SELECT). Persistence is automatic (the sahpool VFS). */
const exec = async (name: string, sql: string): Promise<Record<string, unknown>[]> =>
  (await request({ name, sql })).rows ?? [];

/** Serialize db `name` from the pool to a portable .db byte blob. */
const exportBytes = async (name: string): Promise<Uint8Array> =>
  (await request({ op: "export", name })).bytes ?? new Uint8Array();

/** Load a .db byte blob into the pool AS db `name` (replacing its contents). */
const importBytes = async (name: string, bytes: Uint8Array): Promise<void> => {
  await request({ op: "import", name, bytes });
};

// ── write-revision trigger ───────────────────────────────────────────────────
// A `sqlite.<name>.rev` ValueCel is ensured on open and bumped on every write;
// SELECT formulas that reference it re-fire after a write (inputMap + runCycle —
// no side channel). Best-effort: a failure here never fails the query.
const revKey = (nm: string): string => `sqlite.${nm}.rev`;
const ensureRev = async (state: State, nm: string): Promise<void> => {
  const k = revKey(nm);
  if (state.cels.get(k)) return;
  try {
    await (resolveFn(state, "setCel") as Fn)(state, k, {
      celType: "ValueCel", v: 0,
      metadata: {
        key: k, segment: "sqlite", schema: "number",
        description: `Write-revision counter for db "${nm}". A SELECT formula that references it re-fires after a write.`,
      },
    });
  } catch { /* best-effort */ }
};
const bumpRev = async (state: State, nm: string): Promise<void> => {
  const cur = Number(state.cels.get(revKey(nm))?.v ?? 0);
  try { await (resolveFn(state, "setValue") as Fn)(state, revKey(nm), cur + 1); } catch { /* best-effort */ }
};

// sqlite.command(state, op, name, query) — the db vocabulary's logic. Returns a
// handle ({__db}), a row array, a { tables } schema, "ok", or an error string.
//   op=open    → ensure db + rev cel; returns { __db }
//   op=sql     → run a query; SELECT → rows, a write → "ok" (+ bump rev)
//   op=seed    → query is JSON { table, rows }; bulk-INSERT (+ bump rev)
//   op=schema  → introspect tables/columns/PK/FK; returns { tables: [...] }
//   op=export  → query is a file-store path; serialize db → write blob there
//   op=import  → query is a file-store path; read blob → load into db (+ bump rev)
const sqliteCommand: Fn = (async (state: State, op: unknown, name: unknown, query: unknown): Promise<unknown> => {
  const o = String(op ?? ""); const nm = String(name ?? "main");
  if (o === "open") { await exec(nm, "SELECT 1"); await ensureRev(state, nm); return { __db: nm }; }
  if (o === "sql") {
    const q = String(query ?? "");
    const rows = await exec(nm, q);
    if (WRITE_SQL.test(q)) { await bumpRev(state, nm); return "ok"; }
    return rows;
  }
  if (o === "seed") {
    let spec: { table?: string; rows?: Record<string, unknown>[] } = {};
    try { spec = JSON.parse(String(query ?? "{}")); } catch { return "(seed: bad JSON payload)"; }
    const table = String(spec.table ?? "");
    const rows = Array.isArray(spec.rows) ? spec.rows : [];
    if (!table) return "(seed: missing table)";
    const sql = buildInsert(table, rows);
    if (!sql) return "ok";                         // empty seed — no-op
    await exec(nm, sql);
    await bumpRev(state, nm);
    return "ok";
  }
  if (o === "schema") {
    const names = (await exec(nm,
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )).map((r) => String(r.name));
    const tables: unknown[] = [];
    for (const t of names) {
      tables.push(shapeTable(
        t,
        await exec(nm, `PRAGMA table_info(${ident(t)})`),
        await exec(nm, `PRAGMA foreign_key_list(${ident(t)})`),
      ));
    }
    return { tables };
  }
  if (o === "export") {
    const path = String(query ?? "");
    if (!path) return `(export: pass a destination path, e.g. =dbexport(db, "/exports/${nm}.db"))`;
    const bytes = await exportBytes(nm);
    if (!bytes.byteLength) return `(export: db "${nm}" is empty — nothing to write)`;
    try { await fsOps.write(path, bytes); }
    catch (e) { return `(export: ${(e as Error)?.message ?? e})`; }
    return `ok (${bytes.byteLength} bytes → ${path})`;
  }
  if (o === "import") {
    const path = String(query ?? "");
    if (!path) return `(import: pass a source path, e.g. =dbimport(db, "/exports/${nm}.db"))`;
    let bytes: unknown;
    try { bytes = await fsOps.read(path); }
    catch { return `(import: no readable file at ${path})`; }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return `(import: empty or unreadable file at ${path})`;
    try { await importBytes(nm, bytes); }
    catch (e) { return `(import: ${(e as Error)?.message ?? e} — is "${path}" a valid SQLite file?)`; }
    await ensureRev(state, nm);
    await bumpRev(state, nm);
    return `ok (imported ${bytes.byteLength} bytes into "${nm}")`;
  }
  return `(unknown db op: ${o})`;
}) as Fn;

export const name = "sqlite" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sqlite.command", sqliteCommand],
]));
