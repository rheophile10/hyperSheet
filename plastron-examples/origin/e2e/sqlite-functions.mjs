// e2e: comprehensive coverage of the SQLite vocabulary in real headless chromium
// (sqlite-wasm + opfs-sahpool, in a Worker). Two surfaces:
//   1. the engine — sqlite.command(state, op, name, query) driven directly:
//      open / sql / seed / schema(PK+FK) / update+delete rev / multi-db / errors
//   2. import/export round-trip — serialize a db to a file-store .db blob and
//      load it back into a DIFFERENT db, then read a row out (the user's ask)
//   3. the formula surface — =db/=sql/=dbexport/=dbimport through the 元 grid
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 8796;
const dist = "/home/ian/projects/plastron/plastron-examples/origin/dist";
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0, last;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); if (!c) console.log("      last:", JSON.stringify(last)?.slice(0, 160)); };

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
await page.waitForTimeout(300);

// ── surface 1: drive sqlite.command directly, capturing rejections as {err} ──
const cmd = async (op, name, query) => {
  last = await page.evaluate(([o, n, q]) => {
    const { state, resolveFn } = globalThis.plastron;
    return Promise.resolve(resolveFn(state, "sqlite.command")(state, o, n, q ?? ""))
      .then((v) => ({ v })).catch((e) => ({ err: String((e && e.message) || e) }));
  }, [op, name, query]);
  return last;
};
const val = async (op, name, query) => (await cmd(op, name, query)).v;
const celV = (k) => page.evaluate((key) => globalThis.plastron.state.cels.get(key)?.v, k);

console.log("\nsqlite engine — sqlite.command ops");
ok(errs.length === 0, `page launched clean${errs.length ? ": " + errs[0] : ""}`);

// open + rev cel
ok((await val("open", "fdb")).__db === "fdb", "open → {__db}");
ok(await celV("sqlite.fdb.rev") === 0, "rev cel seeded at 0 on open");

// create / write-rev
ok(await val("sql", "fdb", "CREATE TABLE turtles (id INTEGER PRIMARY KEY, name TEXT, speed INTEGER)") === "ok", "CREATE TABLE → ok");
ok(await celV("sqlite.fdb.rev") === 1, "rev → 1 after CREATE");

// seed (quote-escaping + missing column → NULL)
const seedJson = JSON.stringify({ table: "turtles", rows: [
  { id: 1, name: "Speedy", speed: 8 },
  { id: 2, name: "O'Brien", speed: 5 },
  { id: 3, name: "Shelly" },
] });
ok(await val("seed", "fdb", seedJson) === "ok", "seed 3 rows → ok");
ok(await celV("sqlite.fdb.rev") === 2, "rev → 2 after seed");

// select
let rows = await val("sql", "fdb", "SELECT id, name, speed FROM turtles ORDER BY id");
ok(Array.isArray(rows) && rows.length === 3, "SELECT → 3 rows");
ok(rows?.[1]?.name === "O'Brien", "quote-escaped value round-trips");
ok(rows?.[2]?.speed === null, "missing column → NULL");

// update / delete bump the rev
ok(await val("sql", "fdb", "UPDATE turtles SET speed = 10 WHERE id = 1") === "ok", "UPDATE → ok");
ok(await celV("sqlite.fdb.rev") === 3, "rev → 3 after UPDATE");
ok(await val("sql", "fdb", "DELETE FROM turtles WHERE id = 3") === "ok", "DELETE → ok");
ok(await celV("sqlite.fdb.rev") === 4, "rev → 4 after DELETE");
rows = await val("sql", "fdb", "SELECT COUNT(*) c FROM turtles");
ok(Number(rows?.[0]?.c) === 2, "after delete → 2 rows");

// schema: PK + FK introspection
await val("sql", "fdb", "CREATE TABLE rides (id INTEGER PRIMARY KEY, turtle_id INTEGER REFERENCES turtles(id), miles INTEGER)");
const schema = await val("schema", "fdb");
const turtles = schema?.tables?.find((t) => t.name === "turtles");
const ridesT  = schema?.tables?.find((t) => t.name === "rides");
ok(turtles?.columns?.length === 3, "schema: turtles has 3 columns");
ok(turtles?.columns?.find((c) => c.name === "id")?.pk === true, "schema: id flagged PK");
ok(Array.isArray(ridesT?.fks) && ridesT.fks.some((f) => f.table === "turtles" && f.from === "turtle_id" && f.to === "id"),
   `schema: FK rides.turtle_id → turtles.id (${JSON.stringify(ridesT?.fks)})`);

// multi-db isolation — a table in fdb is not visible in a second db
await val("open", "otherdb");
await val("sql", "otherdb", "CREATE TABLE only_here (x)");
const otherTables = await val("sql", "otherdb", "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
ok(Array.isArray(otherTables) && otherTables.length === 1 && otherTables[0].name === "only_here",
   `multi-db isolation: otherdb sees only its own table (${JSON.stringify(otherTables?.map((t) => t.name))})`);

// error surfacing — a bad query rejects with the engine message
const bad = await cmd("sql", "fdb", "SELECT * FROM does_not_exist");
ok(bad.err && /no such table/i.test(bad.err), `bad SQL surfaces engine error (${bad.err})`);

// ── surface 2: import/export round-trip (the headline) ───────────────────────
console.log("\nimport / export round-trip");
await val("open", "exsrc");
await val("sql", "exsrc", "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
await val("seed", "exsrc", JSON.stringify({ table: "notes", rows: [
  { id: 1, body: "first" }, { id: 2, body: "second" }, { id: 3, body: "third" },
] }));

const exMsg = await val("export", "exsrc", "/exports/exsrc.db");
ok(typeof exMsg === "string" && /bytes → \/exports\/exsrc\.db/.test(exMsg), `export → "${exMsg}"`);

// the exported blob is a real, browsable file-store file
const fileBytes = await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  const b = await resolveFn(state, "fs.read")("/exports/exsrc.db");   // fs.read(path) — no state arg
  // SQLite files start with the ASCII magic "SQLite format 3\0"
  return { len: b?.byteLength ?? 0, magic: new TextDecoder().decode(b.slice(0, 15)) };
});
ok(fileBytes.len > 0 && fileBytes.magic === "SQLite format 3", `exported file is a real SQLite blob (${fileBytes.len}b, "${fileBytes.magic}")`);

// import that known .db into a DIFFERENT, never-seeded db and read a row out
const imMsg = await val("import", "exdst", "/exports/exsrc.db");
ok(typeof imMsg === "string" && /imported \d+ bytes into "exdst"/.test(imMsg), `import → "${imMsg}"`);
ok(await celV("sqlite.exdst.rev") >= 1, "import bumps the write-rev (SELECTs re-fire)");
rows = await val("sql", "exdst", "SELECT id, body FROM notes ORDER BY id");
ok(Array.isArray(rows) && rows.length === 3 && rows[1].body === "second",
   `imported db reads back its rows (${JSON.stringify(rows?.map((r) => r.body))})`);

// importing a missing path fails gracefully (no throw)
const imMiss = await val("import", "exdst", "/exports/nope.db");
ok(typeof imMiss === "string" && imMiss.startsWith("(import:"), `missing-file import → graceful "${imMiss}"`);

// ── surface 3: the formula vocabulary (=db/=sql/=dbexport/=dbimport) ─────────
console.log("\nformula surface — origin verbs");
const put = (src, key) => page.evaluate(async ([s, k]) => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "origin.edit")(state, k);
  await resolveFn(state, "setValue")(state, "元.draft", s);
  await resolveFn(state, "origin.run")(state, k);
  await new Promise((r) => setTimeout(r, 100));
  return state.cels.get(k)?.v ?? null;
}, [src, key]);
const drained = (v) => !(v && typeof v === "object" && (v.originDb || v.originFs || v.originSeg));
const run = async (src, key) => { await put(src, key); const t0 = Date.now(); while (Date.now() - t0 < 15000) { last = await celV(key); if (drained(last)) return last; await page.waitForTimeout(150); } return await celV(key); };

await put("=cels(8, 1)", "元");
await run('=db("frmsrc")', "g8x1.A1");
ok(/ok/.test(String(await run('=sql(g8x1!A1, "create table k(id, v)")', "g8x1.A2"))), "=sql create (formula)");
await run('=sql(g8x1!A1, "insert into k values (1, \'x\'), (2, \'y\')")', "g8x1.A3");
last = await run('=dbexport(g8x1!A1, "/exports/frmsrc.db")', "g8x1.A4");
ok(typeof last === "string" && /bytes →/.test(last), `=dbexport (formula) → "${last}"`);
await run('=db("frmdst")', "g8x1.A5");
last = await run('=dbimport(g8x1!A5, "/exports/frmsrc.db")', "g8x1.A6");
ok(typeof last === "string" && /imported/.test(last), `=dbimport (formula) → "${last}"`);
last = await run('=sql(g8x1!A5, "select v from k order by id")', "g8x1.A7");
ok(Array.isArray(last) && last.length === 2 && last[0].v === "x" && last[1].v === "y",
   `formula round-trip: imported db reads back (${JSON.stringify(last)})`);

ok(errs.length === 0, `no console/page errors${errs.length ? ": " + errs.slice(0, 2).join(" | ") : ""}`);

console.log(`\n${fail ? "✘" : "✔"} sqlite functions: ${pass} pass, ${fail} fail`);
await browser.close(); srv.kill();
process.exit(fail ? 1 : 0);
