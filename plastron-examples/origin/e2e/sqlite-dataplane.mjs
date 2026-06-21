// e2e: verify the SQLite data plane (Step B) end-to-end in real headless
// chromium — sqlite-wasm engine + the new seed / schema / write-rev ops. Drives
// sqlite.command directly via globalThis.plastron (the proven e2e pattern).
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 8794;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory",
  "/home/ian/projects/plastron/plastron-examples/origin/dist"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); };

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
await page.waitForTimeout(300);

// call sqlite.command(state, op, name, query) directly in the page.
const cmd = (op, name, query) => page.evaluate(([o, n, q]) => {
  const { state, resolveFn } = globalThis.plastron;
  return resolveFn(state, "sqlite.command")(state, o, n, q ?? "");
}, [op, name, query]);
const celV = (k) => page.evaluate((key) => globalThis.plastron.state.cels.get(key)?.v, k);

ok(errs.length === 0, `page launched clean — ${errs.length} errors${errs.length ? ": " + errs[0] : ""}`);

// open
const handle = await cmd("open", "tdb");
ok(handle && handle.__db === "tdb", `open → handle ${JSON.stringify(handle)}`);
ok(await celV("sqlite.tdb.rev") === 0, `rev cel seeded at 0 on open (got ${await celV("sqlite.tdb.rev")})`);

// create table
const created = await cmd("sql", "tdb", "CREATE TABLE turtles (id INTEGER PRIMARY KEY, name TEXT, speed INTEGER)");
ok(created === "ok", `CREATE TABLE → "${created}"`);
ok(await celV("sqlite.tdb.rev") === 1, `rev bumped to 1 after CREATE (got ${await celV("sqlite.tdb.rev")})`);

// seed from JSON (the new op): query is JSON { table, rows }
const seedPayload = JSON.stringify({ table: "turtles", rows: [
  { id: 1, name: "Speedy", speed: 8 },
  { id: 2, name: "O'Brien", speed: 5 },   // tests quote-escaping through the engine
  { id: 3, name: "Shelly" },               // missing speed → NULL
] });
const seeded = await cmd("seed", "tdb", seedPayload);
ok(seeded === "ok", `seed 3 rows → "${seeded}"`);
ok(await celV("sqlite.tdb.rev") === 2, `rev bumped to 2 after seed (got ${await celV("sqlite.tdb.rev")})`);

// select back
const rows = await cmd("sql", "tdb", "SELECT id, name, speed FROM turtles ORDER BY id");
ok(Array.isArray(rows) && rows.length === 3, `SELECT → ${Array.isArray(rows) ? rows.length : "?"} rows`);
ok(rows && rows[1] && rows[1].name === "O'Brien", `escaped value round-trips ("${rows?.[1]?.name}")`);
ok(rows && rows[2] && rows[2].speed === null, `missing column → NULL ("${rows?.[2]?.speed}")`);

// schema introspection (the new op): tables/columns/PK
const schema = await cmd("schema", "tdb");
const turtles = schema?.tables?.find((t) => t.name === "turtles");
ok(!!turtles, `schema lists "turtles" (${schema?.tables?.map((t) => t.name).join(",")})`);
ok(turtles?.columns?.length === 3, `turtles has 3 columns (${turtles?.columns?.map((c) => c.name).join(",")})`);
ok(turtles?.columns?.find((c) => c.name === "id")?.pk === true, `id is flagged PK`);

console.log(`\n${fail ? "✘" : "✔"} sqlite data plane: ${pass} pass, ${fail} fail`);
await browser.close(); srv.kill();
process.exit(fail ? 1 : 0);
