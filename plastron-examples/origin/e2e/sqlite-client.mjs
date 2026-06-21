// e2e: the SQLite client WINDOW (Step C) in real headless chromium.
// Normal (unlocked) boot, construct the window via the =sqlclient genesis verb,
// commit + settle through origin's loop, then drive a query through the window's
// handlers. Checks: panel renders, results show, rows become real sqlres.* cels,
// sidebar reacts to a CREATE via the rev trigger.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { join } from "node:path";

const PORT = 8795;
const dist = "/home/ian/projects/plastron/plastron-examples/origin/dist";
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); };
const call = (k, ...a) => page.evaluate(([key, args]) => {
  const { state, resolveFn } = globalThis.plastron; return resolveFn(state, key)(state, ...args);
}, [k, a]);
const cellV = (k) => page.evaluate((key) => globalThis.plastron.state.cels.get(key)?.v, k);

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
await page.waitForTimeout(400);

// a database that already has a table (the natural flow: open the client on it)
await call("sqlite.command", "sql", "demo", "CREATE TABLE turtles (id INTEGER PRIMARY KEY, name TEXT, speed INTEGER)");
await call("sqlite.command", "seed", "demo", JSON.stringify({ table: "turtles", rows: [
  { id: 1, name: "Speedy", speed: 8 }, { id: 2, name: "Pokey", speed: 3 },
] }));

// construct the window via the genesis verb, commit its cels, settle origin's loop
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  const g = resolveFn(state, "sqlclient")("demo");          // pure verb → genesis spec
  const batch = {};
  for (const [k, spec] of Object.entries(g.cels)) batch[k] = { ...spec, metadata: { ...(spec.metadata || {}), key: k, segment: g.layer } };
  await resolveFn(state, "setCelBatch")(state, batch);
  const drain = (ch) => resolveFn(state, "drain")(state, ch);
  for (let i = 0; i < 8; i++) {
    await resolveFn(state, "runCycle")(state);
    if (state.cels.get("origin.effects")) await drain("origin.effects");
  }
  await drain("dom.paint");
});
await page.waitForTimeout(400);

ok(await page.evaluate(() => globalThis.plastron.state.cels.has("sqlc.demo.query")), `window cels committed (sqlc.demo.query exists)`);

// run a SELECT through the window handler — this also refreshes the sidebar
// and forces the full window paint
await call("setValue", "sqlc.demo.query", "SELECT * FROM turtles ORDER BY id");
await call("sqlc.run", "demo");
await page.waitForTimeout(400);

// the window is fully rendered: editor, Run button, sidebar, results grid
const dom = await page.evaluate(() => ({
  hasEditor: [...document.querySelectorAll("textarea")].some((t) => /SELECT \* FROM/.test(t.placeholder || "")),
  runBtn: [...document.querySelectorAll("button")].some((b) => /▶ Run/.test(b.textContent || "")),
  sidebarHasTurtles: document.body.innerText.includes("▦ turtles"),
  hasSpeedy: document.body.innerText.includes("Speedy"),
}));
ok(dom.hasEditor, `query editor rendered (placeholder present)`);
ok(dom.runBtn, `Run button rendered`);
ok(dom.sidebarHasTurtles, `sidebar lists "turtles"`);
ok(dom.hasSpeedy, `result rows render in the window`);

// results materialized into real, addressable sqlres.* cels
ok(await cellV("sqlres.A1") === "id" && await cellV("sqlres.B1") === "name", `header row materialized (sqlres.A1=${JSON.stringify(await cellV("sqlres.A1"))})`);
ok(await cellV("sqlres.B2") === "Speedy", `row cell is a real cel (sqlres.B2=${JSON.stringify(await cellV("sqlres.B2"))})`);
const results = await cellV("sqlc.demo.results");
ok(results && results.rows && results.rows.length === 2, `sqlc.demo.results holds 2 rows`);

// the sidebar reacts to an in-client CREATE (sqlc.run refreshes it)
await call("setValue", "sqlc.demo.query", "CREATE TABLE hares (id INTEGER PRIMARY KEY, name TEXT)");
await call("sqlc.run", "demo");
await page.waitForTimeout(300);
const tables = await cellV("sqlc.demo.tables");
ok(tables && tables.tables && tables.tables.some((t) => t.name === "hares"), `sidebar updates after an in-client CREATE (${JSON.stringify(tables?.tables?.map((t) => t.name))})`);

await page.screenshot({ path: join(dist, "..", "e2e", "sqlite-client.png") });
ok(errs.length === 0, `no page errors${errs.length ? ": " + errs.slice(0, 2).join(" | ") : ""}`);
console.log(`\n${fail ? "✘" : "✔"} sqlite client window: ${pass} pass, ${fail} fail  (shot: e2e/sqlite-client.png)`);
await browser.close(); srv.kill();
process.exit(fail ? 1 : 0);
