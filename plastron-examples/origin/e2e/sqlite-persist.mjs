// e2e: SQLite persistence across a page reload, through the real kernel path
// (sqlite-wasm + opfs-sahpool). Page 1 writes; page 2 (same browser context =
// same OPFS) reads it back without re-seeding.
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 8772;
const dist = "/home/ian/projects/plastron/plastron-examples/origin/dist";
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext();        // one context → one persistent OPFS
let pass = 0, fail = 0;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); };

const cmd = (page, op, name, q) => page.evaluate(([o, n, query]) => {
  const { state, resolveFn } = globalThis.plastron;
  return resolveFn(state, "sqlite.command")(state, o, n, query ?? "");
}, [op, name, q]);

// page 1 — write
const p1 = await ctx.newPage();
await p1.goto(`http://localhost:${PORT}/index.html`);
await p1.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
await cmd(p1, "sql", "persist", "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");
await cmd(p1, "sql", "persist", "DELETE FROM notes");
await cmd(p1, "seed", "persist", JSON.stringify({ table: "notes", rows: [{ body: "remember me" }, { body: "and me" }] }));
const before = await cmd(p1, "sql", "persist", "SELECT body FROM notes ORDER BY id");
ok(Array.isArray(before) && before.length === 2, `page 1 wrote 2 rows`);
await p1.close();

// page 2 — fresh reload, same OPFS; read WITHOUT seeding
const p2 = await ctx.newPage();
await p2.goto(`http://localhost:${PORT}/index.html`);
await p2.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
const after = await cmd(p2, "sql", "persist", "SELECT body FROM notes ORDER BY id");
ok(Array.isArray(after) && after.length === 2 && after[0].body === "remember me",
  `page 2 read the SAME data after reload — persistence works (${JSON.stringify(after)})`);

console.log(`\n${fail ? "✘" : "✔"} sqlite persistence: ${pass} pass, ${fail} fail`);
await browser.close(); srv.kill();
process.exit(fail ? 1 : 0);
