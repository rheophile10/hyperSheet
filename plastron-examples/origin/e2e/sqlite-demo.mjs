// e2e: the =sqlitedemo() example (Step D) in real headless chromium.
// Commits the demo genesis, settles origin's loop, and checks the ordered chain
// (create → seed → reads) produced data and the client window opened.
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 8791;
const dist = "/home/ian/projects/plastron/plastron-examples/origin/dist";
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); };
const cellV = (k) => page.evaluate((key) => globalThis.plastron.state.cels.get(key)?.v, k);

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
await page.waitForTimeout(400);

// commit the =sqlitedemo() genesis and settle (the chain needs several rounds:
// create → seed → reads, each an async effect)
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  const g = resolveFn(state, "sqlitedemo")("demo");
  const batch = {};
  for (const [k, spec] of Object.entries(g.cels)) batch[k] = { ...spec, metadata: { ...(spec.metadata || {}), key: k, segment: "demo" } };
  await resolveFn(state, "setCelBatch")(state, batch);
  for (let i = 0; i < 16; i++) {
    await resolveFn(state, "runCycle")(state);
    if (state.cels.get("genesis.commit")) await resolveFn(state, "drain")(state, "genesis.commit");
    if (state.cels.get("origin.effects")) await resolveFn(state, "drain")(state, "origin.effects");
  }
  await resolveFn(state, "drain")(state, "dom.paint");
});
await page.waitForTimeout(500);

// the example cels exist
ok(await page.evaluate(() => globalThis.plastron.state.cels.has("demo.schema")), `demo cels committed`);

// the ordered chain produced data: demo.all = 4 rows
const all = await cellV("demo.all");
ok(Array.isArray(all) && all.length === 4, `demo.all = 4 rows (create→seed ran in order) — got ${Array.isArray(all) ? all.length : JSON.stringify(all)}`);

// the aggregate read: speed >= 5 → Crush(9), Speedy(8), Shelly(5)
const fast = await cellV("demo.fast");
ok(Array.isArray(fast) && fast.length === 3 && fast[0]?.name === "Crush", `demo.fast = 3 fast turtles, Crush first — got ${JSON.stringify(fast)?.slice(0, 80)}`);

// the client window opened on the demo db
ok(await page.evaluate(() => globalThis.plastron.state.cels.has("sqlc.demo.query")), `client window opened (=sqlclient committed)`);

ok(errs.length === 0, `no page errors${errs.length ? ": " + errs.slice(0, 2).join(" | ") : ""}`);
console.log(`\n${fail ? "✘" : "✔"} sqlite demo: ${pass} pass, ${fail} fail`);
await browser.close(); srv.kill();
process.exit(fail ? 1 : 0);
