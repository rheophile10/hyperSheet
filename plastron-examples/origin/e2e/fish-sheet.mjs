// e2e: the FORMULA-FIRST 2D fish doc (apps/docs/boids.json) through the Sheets-app
// document flow — the target UX: a worksheet whose GRID CELLS carry the whole
// simulation (params B2:B9, tables D1/D2, =sysmap/=wrap systems D3/D4, pump
// config D5, and the render pane grown by the =view() formula in A1), opened
// from the Sheets app's 📂 picker, swimming in the DOM, steered by cell edits.
//
// Everything here is the REAL click path (the former GAP A/B/C shims are now
// kernel behavior: the 📂 sheetapp.open picker, renderWorkbook's settle loop
// landing =view panes on open, and the pump's per-frame house repaint cycle).
// Run:  cd plastron-examples/origin && bun e2e/fish-sheet.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT ?? 5178);
const origin = "/home/ian/projects/plastron/plastron-examples/origin";
const srv = spawn("bun", [`${origin}/serve.ts`], { stdio: "ignore", env: { ...process.env, PORT: String(PORT) } });
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://localhost:${PORT}/index.html`); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0, last;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); if (!c) console.log("      last:", JSON.stringify(last)?.slice(0, 220)); };

await page.goto(`http://localhost:${PORT}/`, { timeout: 60000 });
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });
await page.waitForTimeout(1500);

// ── the doc is DISCOVERABLE: baked → installed → listed as a document ─────────
last = await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  return (await resolveFn(state, "store.list")(state)).filter((e) => e.name === "boids");
});
ok(last?.length === 1 && !!last[0].app, `boids doc installed in the OPFS segment store on fresh boot (${JSON.stringify(last)})`);

// ── the REAL flow: 田 Sheet → 📂 Open → pick boids ────────────────────────────
last = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button.pl-desk-icon")].find((b) => /Sheet/.test(b.textContent ?? ""));
  if (!btn) return false;
  btn.click();
  return true;
});
ok(last === true, "clicked the 田 Sheet desktop icon (blank Sheets app)");
await page.waitForTimeout(1000);
await page.click('.pl-workbook .pl-wb-tool[title="Open a stored document"]');
await page.waitForTimeout(700);
last = await page.evaluate(() => [...document.querySelectorAll('[data-win="win.sheetopen.state"] button')].map((b) => b.textContent?.trim()));
ok(last?.some((t) => /^📄 boids$/.test(t ?? "")), `the 📂 picker lists the boids doc (${JSON.stringify(last)?.slice(0, 120)})`);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[data-win="win.sheetopen.state"] button')].find((b) => /^📄 boids$/.test(b.textContent?.trim() ?? ""));
  btn?.click();
});
await page.waitForTimeout(1200);

last = await page.evaluate(() => globalThis.plastron.state.cels.get("win.boids.state")?.v ?? null);
ok(!!last && last.closed !== 1, "picking 📄 boids opened the workbook");
ok(last?.views?.some((t) => t.title === "fish"), `the =view() formula in A1 grew the fish pane on open (views: ${JSON.stringify(last?.views?.map((t) => t.title))})`);

// ── the grid IS the program: formulas visible + editable in cells ─────────────
last = await page.evaluate(() => document.querySelector(".pl-wb-left")?.textContent ?? "");
ok(/cohesion/.test(last) && /separation/.test(last), "params labels render in the worksheet grid");
await page.click('.pl-wb-left .cell-value[data-key="boids.B14"]');
await page.waitForTimeout(400);
last = await page.evaluate(() => document.querySelector(".pl-wb-left textarea.fx-input")?.value);
ok(String(last ?? "").startsWith("=sysmap("), `clicking D3 loads its formula into the bar (${JSON.stringify(last)?.slice(0, 40)}…)`);
await page.click('.pl-wb-left .cell-value[data-key="boids.B15"]');
await page.waitForTimeout(300);
last = await page.evaluate(() => document.querySelector(".pl-wb-left textarea.fx-input")?.value);
ok(String(last ?? "").startsWith("=wrap("), "clicking D4 loads =wrap(integrate(…)) into the bar");

// ── the view pane rendered FROM the cells ────────────────────────────────────
last = await page.evaluate(() => [...document.querySelectorAll(".pl-wb-vbody canvas[data-ops]")].map((c) => JSON.parse(c.getAttribute("data-ops") ?? "[]").length));
ok(last?.[0] === 61, `fish canvas painted from A1's formula (61 ops = bg + 60 fish), got ${JSON.stringify(last)}`);

// ── ▶ run: the D5 pump advances the tables AND the DOM animates ──────────────
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".pl-wb-vbody button")].find((b) => /run/.test(b.textContent ?? ""));
  btn?.click();
});
await page.waitForTimeout(600);
const p0 = await page.evaluate(() => JSON.stringify(globalThis.plastron.state.cels.get("boids.B12")?.v?.[0]));
await page.waitForTimeout(500);
const p1 = await page.evaluate(() => JSON.stringify(globalThis.plastron.state.cels.get("boids.B12")?.v?.[0]));
ok(p0 !== p1, `▶ run: the pump advances D1 (fish[0] ${p0} → ${p1})`);
const opsX = () => page.evaluate(() => {
  const ops = document.querySelector(".pl-wb-vbody canvas[data-ops]")?.getAttribute("data-ops");
  return ops ? JSON.parse(ops).find((o) => o.op === "circle")?.x : null;
});
const x0 = await opsX();
await page.waitForTimeout(600);
const x1 = await opsX();
ok(typeof x0 === "number" && x0 !== x1, `the DOM canvas animates per pump frame (fish[0].x ${x0?.toFixed?.(1)} → ${x1?.toFixed?.(1)})`);
const box = await page.evaluate(() => {
  const r = document.querySelector(".pl-wb-vbody canvas")?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
});
const shot0 = await page.screenshot({ clip: box });
await page.waitForTimeout(500);
const shot1 = await page.screenshot({ clip: box });
ok(!shot0.equals(shot1), "pixels change across frames (the flock is visibly swimming)");

// ── edit a param CELL mid-swim → the systems re-derive ───────────────────────
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "setValue")(state, "boids.B4", 0.2);   // separation (the grid's commit path)
});
await page.waitForTimeout(400);
last = await page.evaluate(() => ({
  b4: globalThis.plastron.state.cels.get("boids.B4")?.v,
  d3len: globalThis.plastron.state.cels.get("boids.B14")?.v?.length,
}));
ok(last?.b4 === 0.2 && last?.d3len === 60, `B4 (separation) edited mid-swim; D3 still deriving 60 velocities (${JSON.stringify(last)})`);
const q0 = await page.evaluate(() => JSON.stringify(globalThis.plastron.state.cels.get("boids.B12")?.v?.[0]));
await page.waitForTimeout(400);
const q1 = await page.evaluate(() => JSON.stringify(globalThis.plastron.state.cels.get("boids.B12")?.v?.[0]));
ok(q0 !== q1, "sim still advancing after the mid-swim edit");

// ── close → the D5 while-gate stops the pump ─────────────────────────────────
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "window.close")(state, "win.boids.state");
});
await page.waitForTimeout(400);
const r0 = await page.evaluate(() => JSON.stringify(globalThis.plastron.state.cels.get("boids.B12")?.v?.[0]));
await page.waitForTimeout(500);
const r1 = await page.evaluate(() => JSON.stringify(globalThis.plastron.state.cels.get("boids.B12")?.v?.[0]));
ok(r0 === r1, "closing the workbook stops the pump (D1 stable — the while gate)");

ok(errs.length === 0, `no page errors (${errs.length ? errs[0]?.slice(0, 200) : "clean"})`);

console.log(`\n${pass} pass, ${fail} fail`);
await browser.close();
srv.kill();
process.exit(fail ? 1 : 0);
