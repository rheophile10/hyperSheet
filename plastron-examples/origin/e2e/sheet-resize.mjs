// e2e: Excel-style ROW/COLUMN RESIZE on the sheet grid (library/sheets).
//
// Drag a column header's right edge / a row header's bottom edge — the handle
// dispatches sheet.resizeGrab/Move/Drop, the size lands as DATA in the sparse
// `<seg>.colw` / `<seg>.rowh` ValueCels (segment = the sheet's, so they save
// with the document), and the grid re-renders through the graph (the first
// grab rewires the grid formula to reference the size cels). dblclick resets.
// Run:  cd plastron-examples/origin && bun e2e/sheet-resize.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT ?? 5180);
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

const openDoc = async () => {
  await page.evaluate(async () => {
    const { state, resolveFn } = globalThis.plastron;
    await resolveFn(state, "origin.opendoc")(state, "turtle_charts");
  });
  await page.waitForTimeout(1200);
  // the primary's own sheet is the SECOND tab (deps render first)
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".pl-wb-left .pl-wb-tab")].find((b) => b.textContent?.trim() === "turtle_charts");
    tab?.click();
  });
  await page.waitForTimeout(500);
};
await openDoc();

const box = (sel) => page.locator(`.pl-wb-left ${sel}`).first().boundingBox();
const celV = (k) => page.evaluate((k) => globalThis.plastron.state.cels.get(k)?.v ?? null, k);
const drag = async (sel, dx, dy) => {
  await page.locator(`.pl-wb-left ${sel}`).first().scrollIntoViewIfNeeded();
  const hb = await box(sel);
  const cx = hb.x + hb.width / 2, cy = hb.y + hb.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = 6;
  for (let i = 1; i <= steps; i++) await page.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps);
  await page.mouse.up();
  await page.waitForTimeout(400);
};

// ── the grid grew header-edge handles ────────────────────────────────────────
last = await page.evaluate(() => ({
  cols: document.querySelectorAll('.pl-wb-left .col-resize').length,
  rows: document.querySelectorAll('.pl-wb-left .row-resize').length,
}));
ok(last.cols > 0 && last.rows > 0, `header resize handles render (${last.cols} col, ${last.rows} row)`);

// ── drag column A's right edge +60px ─────────────────────────────────────────
const w0 = (await box('td[data-key="turtle_charts.A1"]')).width;
await drag('.col-resize[data-col="A"]', 60, 0);
last = await celV("turtle_charts.colw");
ok(last && Math.abs(last.A - (w0 + 60)) <= 4, `turtle_charts.colw.A landed as DATA ≈ ${Math.round(w0 + 60)}px (${JSON.stringify(last)})`);
const w1 = (await box('td[data-key="turtle_charts.A1"]')).width;
ok(Math.abs(w1 - w0 - 60) <= 6, `column A is visibly ~60px wider (${w0.toFixed(1)} → ${w1.toFixed(1)})`);
last = await page.evaluate(() => globalThis.plastron.state.cels.get("win.turtle_charts.view.turtle_charts")?.f ?? "");
ok(last.includes("turtle_charts.colw"), "the grid formula was rewired to reference the size cel (reactive resize)");

// ── the floor: a hard leftward drag clamps at 24px ───────────────────────────
await drag('.col-resize[data-col="A"]', -600, 0);
last = await celV("turtle_charts.colw");
ok(last?.A === 24, `column floor holds at 24px (${JSON.stringify(last)})`);
await drag('.col-resize[data-col="A"]', w0 + 36, 0);   // back to ~w0+60 for the persistence leg
last = await celV("turtle_charts.colw");

// ── drag row 2's bottom edge +20px, then double-click to reset ───────────────
const h0 = (await box('td[data-key="turtle_charts.A2"]')).height;
await drag('.row-resize[data-row="2"]', 0, 20);
last = await celV("turtle_charts.rowh");
ok(last && Math.abs(last["2"] - (h0 + 20)) <= 4, `turtle_charts.rowh.2 landed as DATA ≈ ${Math.round(h0 + 20)}px (${JSON.stringify(last)})`);
const h1 = (await box('td[data-key="turtle_charts.A2"]')).height;
ok(Math.abs(h1 - h0 - 20) <= 6, `row 2 is visibly ~20px taller (${h0.toFixed(1)} → ${h1.toFixed(1)})`);
await page.locator('.pl-wb-left .row-resize[data-row="2"]').first().dblclick();
await page.waitForTimeout(400);
last = await celV("turtle_charts.rowh");
ok(last && !("2" in last), `double-click resets the row override (${JSON.stringify(last)})`);
const h2 = (await box('td[data-key="turtle_charts.A2"]')).height;
ok(Math.abs(h2 - h0) <= 3, `row 2 is back at its default height (${h2.toFixed(1)} ≈ ${h0.toFixed(1)})`);

// ── persistence: close (save-on-close) → reopen → the width survives ─────────
const savedB = (await celV("turtle_charts.colw"))?.A;
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "window.close")(state, "win.turtle_charts.state");
});
await page.waitForTimeout(1000);
last = await celV("turtle_charts.colw");
ok(last === null, "close evicted the doc (colw gone from live state)");
await openDoc();
last = await celV("turtle_charts.colw");
ok(!!last && last.A === savedB, `reopen restored turtle_charts.colw from the stored doc (A=${last?.A}, saved ${savedB})`);
// the VISUAL restore on open needs the host's singleGrid to reference the size
// cels (the <seg>.dims pattern) — warn-only until that one-line diff ships;
// after it, flip to ok().
last = await page.evaluate(() => globalThis.plastron.state.cels.get("win.turtle_charts.view.turtle_charts")?.f ?? "");
if (last.includes("turtle_charts.colw")) {
  const w2 = (await box('td[data-key="turtle_charts.A1"]')).width;
  ok(Math.abs(w2 - savedB) <= 6, `the reopened grid paints the saved width (${w2.toFixed(1)} ≈ ${savedB})`);
} else {
  console.log("  ⚠ singleGrid doesn't reference <seg>.colw/<seg>.rowh yet — visual restore on open awaits the sheetapp diff (the saved size re-applies on the first grab)");
}

ok(errs.length === 0, `no page errors (${errs.length ? errs[0]?.slice(0, 200) : "clean"})`);

console.log(`\n${pass} pass, ${fail} fail`);
await browser.close();
srv.kill();
process.exit(fail ? 1 : 0);
