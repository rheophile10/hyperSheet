// SQLite engine worker — runs @sqlite.org/sqlite-wasm over the opfs-sahpool VFS
// (persistent, incremental, no COOP/COEP). Generic: the main thread sends raw
// SQL; this just execs it and returns rows. One pool, one db handle per name.
//
// Message protocol ({ id, ... }, replies carry the same id):
//   { sql }            → exec; reply { rows }            (op absent = the default)
//   { op:"export" }    → serialize db `name` from the pool; reply { bytes }
//   { op:"import", bytes } → write `bytes` into the pool AS db `name`; reply { ok }
// import/export move a portable .db blob in/out of the opaque SAH pool — the only
// way, since the pool stores capacity files, not a browsable `<name>.db`.
//
// Loaded by the kernel's sqlite segment via globalThis.__sqliteWorkerUrl (the
// origin bundle drops this file + sqlite3.mjs + sqlite3.wasm next to index.html).
import sqlite3InitModule from "./sqlite3.mjs";

let _initP;
let _pool;
const _dbs = new Map();

const init = () => (_initP ??= (async () => {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  _pool = await sqlite3.installOpfsSAHPoolVfs({ name: "plastron-sqlite", directory: ".plastron-sqlite" });
  return sqlite3;
})());

const pathFor = (name) => "/" + name + ".db";

const dbFor = (name) => {
  let db = _dbs.get(name);
  if (!db) { db = new _pool.OpfsSAHPoolDb(pathFor(name)); _dbs.set(name, db); }
  return db;
};

self.onmessage = async (ev) => {
  const { id, name, sql, op, bytes } = ev.data || {};
  const nm = String(name ?? "main");
  try {
    await init();

    if (op === "export") {
      // exportFile reads the pool's main db file bytes — a portable SQLite blob.
      // Touch dbFor first so the file exists even if nothing has opened it yet.
      dbFor(nm);
      const data = await _pool.exportFile(pathFor(nm));
      // Copy out of any pooled view so the transfer hands over a standalone buffer.
      const out = data.slice();
      self.postMessage({ id, ok: true, bytes: out }, [out.buffer]);
      return;
    }

    if (op === "import") {
      // importDb overwrites the pool file; evict any open handle so the next
      // query reopens against the imported contents.
      const open = _dbs.get(nm);
      if (open) { try { open.close(); } catch {} _dbs.delete(nm); }
      await _pool.importDb(pathFor(nm), bytes);
      self.postMessage({ id, ok: true, rows: [] });
      return;
    }

    const db = dbFor(nm);
    const rows = [];
    db.exec({ sql: String(sql ?? ""), rowMode: "object", resultRows: rows });
    self.postMessage({ id, ok: true, rows });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};
