// e2e: 📊 Turtles — the DASHBOARD document (apps/docs/turtles.json), the
// collections-doctrine showcase. The desktop icon opens ONE workbook:
// LEFT, the worksheets — turtle_data (editable grid) and turtle_charts, whose
// cells carry the visible pipeline (=rows() hub-form pivot in B1 → the species
// filter cell B2 → =FILTER in B3 → the =view("🐢 dashboard") formula in B4);
// RIGHT, one dashboard VIEW pane holding the species <select> (param.set →
// B2) and ALL THREE charts. Changing the filter through the real select and
// editing data through the real formula bar both re-render every chart.
//
//   bun e2e/turtles.mjs        (spawns its own dev server on :8894)
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 8894;
const originDir = new URL("..", import.meta.url).pathname;
const srv = spawn("bun", ["serve.ts"], { cwd: originDir, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
for (let i = 0; i < 60; i++) {                       // dev server builds on demand — poll it up
  try { const r = await fetch(`http://localhost:${PORT}/index.html`); if (r.ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0, last;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); if (!c) console.log("      last:", JSON.stringify(last)?.slice(0, 260)); };

// bar-rect count of the FIRST dashboard canvas (bg + one rect per bar)
const barRects = () => page.evaluate(() => {
  const c = document.querySelector(".pl-wb-right #dashboard canvas");
  return c ? JSON.parse(c.getAttribute("data-ops") ?? "[]").filter((o) => o.op === "rect").length : null;
});

// (The former param.set landing workaround is gone: param.set drains
// origin.effects after the write, and the landing cascade recomposes the
// root view itself — 元.view's vals carry each frame's content cels.)

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });
await page.waitForSelector('button.pl-desk-icon[data-icon="📊 Turtles"]', { timeout: 15000 });

// 1) open the doc via the REAL desktop icon (dispatches origin.navOpen "doc:turtle_charts")
await page.click('button.pl-desk-icon[data-icon="📊 Turtles"]');
await page.waitForTimeout(1200);

last = await page.evaluate(() => globalThis.plastron.state.cels.get("win.turtle_charts.state")?.v ?? null);
ok(!!last && last.closed !== 1, "the Turtles workbook opened (win.turtle_charts.state live)");
ok(Array.isArray(last?.sheets) && last.sheets.map((t) => t.title).join(",") === "turtle_data,turtle_charts",
  `both segments are worksheet TABS on the left (${last?.sheets?.map((t) => t.title).join(",")})`);
const viewTitles = (last?.views ?? []).map((t) => t.title);
ok(viewTitles.length === 1 && /dashboard/.test(viewTitles[0]),
  `ONE dashboard view tab on the right (${JSON.stringify(viewTitles)})`);
// the emoji TAB TITLE needs the =view title diff in origin/index.ts (cel keys
// are ASCII, so the ref is the sanitized "dashboard"; the tab should show the
// raw "🐢 dashboard"). Warn-only until the diff ships, then flip to ok().
if (/🐢/.test(viewTitles[0] ?? "")) ok(true, "the dashboard TAB carries the 🐢 title");
else console.log(`  ⚠ dashboard tab title is ${JSON.stringify(viewTitles[0])} — apply the =view title diff for the 🐢`);

// 2) the dashboard pane: select + ALL THREE charts in the right pane, none in the grid
last = await page.evaluate(() => ({
  canvases: document.querySelectorAll(".pl-wb-right #dashboard canvas").length,
  select: !!document.querySelector(".pl-wb-right #dashboard select"),
  options: document.querySelectorAll(".pl-wb-right #dashboard select option").length,
  leftCanvases: document.querySelectorAll(".pl-wb-left canvas").length,
}));
ok(last.canvases === 3, `all three charts render in the ONE dashboard pane (${last.canvases})`);
ok(last.select && last.options === 8, `the species <select> renders with 'all' + 7 species (${last.options})`);
ok(last.leftCanvases === 0, "NO canvas renders inside the worksheet grid (left pane)");

// 3) the pipeline cells show their formulas: token in the grid, source in the bar
await page.evaluate(() => {
  const tab = Array.from(document.querySelectorAll(".pl-wb-left .pl-wb-tab")).find((b) => b.textContent?.trim() === "turtle_charts");
  tab?.click();
});
await page.waitForTimeout(400);
last = await page.evaluate(() => ({
  b1: globalThis.plastron.state.cels.get("turtle_charts.B1")?.f ?? "",
  b3: globalThis.plastron.state.cels.get("turtle_charts.B3")?.f ?? "",
  b4cell: document.querySelector('.cell-value[data-key="turtle_charts.B4"]')?.textContent ?? null,
}));
ok(last.b1.startsWith("=rows("), "B1 keeps its =rows() hub-form pivot source");
ok(last.b3.startsWith("=FILTER("), "B3 keeps its =FILTER derivation source");
ok(typeof last.b4cell === "string" && last.b4cell.includes("⧉ dashboard"), `B4 shows the ⧉ token, not the dashboard (${JSON.stringify(last.b4cell)})`);
await page.click('.cell-value[data-key="turtle_charts.B4"]');
await page.waitForTimeout(300);
last = await page.evaluate(() => document.querySelector("textarea.fx-input")?.value ?? "");
ok(last.replace(/\s+/g, " ").includes('=view( "🐢 dashboard"') || last.startsWith('=view("🐢 dashboard"'),
  "selecting B4 shows the GENERATING =view formula in the formula bar");

// 4) the FILTER through the real select UI → B2 → =FILTER → every chart re-renders
const allBars = await barRects();
ok(allBars === 8, `unfiltered barchart: 7 bars + bg (${allBars})`);
await page.selectOption(".pl-wb-right #dashboard select", "Leatherback");
await page.waitForTimeout(500);
last = await page.evaluate(() => ({
  b2: globalThis.plastron.state.cels.get("turtle_charts.B2")?.v,
  b3len: globalThis.plastron.state.cels.get("turtle_charts.B3")?.v?.length,
}));
ok(last.b2 === "Leatherback", `the select wrote the filter cell via param.set (B2=${JSON.stringify(last.b2)})`);
ok(last.b3len === 1, `=FILTER re-derived (B3 holds ${last.b3len} dict)`);
last = await barRects();
ok(last === 2, `the PANE re-rendered: barchart shows the one species (${last} rects)`);
last = await page.evaluate(() => {
  const c = document.querySelectorAll(".pl-wb-right #dashboard canvas")[2];
  return c ? JSON.parse(c.getAttribute("data-ops") ?? "[]").filter((o) => o.op === "wedge").length : null;
});
ok(last === 1, `…and the piechart too (${last} wedge)`);

// back to all — the select round-trips
await page.selectOption(".pl-wb-right #dashboard select", "all");
await page.waitForTimeout(500);
last = await barRects();
ok(last === 8, `selecting 'all' restores every species (${last} rects)`);

// 5) reactivity through the REAL commit path: edit a data cell in the bar → the dashboard re-renders
const opsBefore = await page.evaluate(() => document.querySelector(".pl-wb-right #dashboard canvas")?.getAttribute("data-ops") ?? "");
await page.evaluate(() => {
  const tab = Array.from(document.querySelectorAll(".pl-wb-left .pl-wb-tab")).find((b) => b.textContent?.trim() === "turtle_data");
  tab?.click();
});
await page.waitForTimeout(400);
await page.click('.cell-value[data-key="turtle_data.B2"]');
await page.waitForTimeout(300);
await page.fill("textarea.fx-input", "500");
await page.press("textarea.fx-input", "Enter");
await page.waitForTimeout(700);
last = await page.evaluate(() => ({
  b2: globalThis.plastron.state.cels.get("turtle_data.B2")?.v,
  hub: globalThis.plastron.state.cels.get("turtle_charts.B1")?.v?.[0]?.lifespan,
}));
ok(last.b2 === 500 || last.b2 === "500", `the formula-bar commit landed (turtle_data.B2 = ${JSON.stringify(last.b2)})`);
ok(last.hub === 500 || last.hub === "500", `the edit flowed into the hub-form dataset (B1[0].lifespan = ${JSON.stringify(last.hub)})`);
const opsAfter = await page.evaluate(() => document.querySelector(".pl-wb-right #dashboard canvas")?.getAttribute("data-ops") ?? "");
ok(opsBefore && opsAfter && opsBefore !== opsAfter, "the barchart re-rendered in the dashboard pane from the sheet edit");

// 6) WHOLE-GRAPH VISIBILITY (the point of this card) at 1280×720, no manual resize
// the workbook window fits inside the viewport (above the 46px taskbar band)
last = await page.evaluate(() => {
  const w = document.querySelector('.pl-window[data-win="win.turtle_charts.state"]');
  if (!w) return null;
  const r = w.getBoundingClientRect();
  return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
});
ok(!!last && last.left >= 0 && last.top >= 0 && last.right <= 1280 && last.bottom <= 720,
  `the workbook window fits inside 1280×720 (${JSON.stringify(last)})`);

// each canvas paints at its 480px attribute size — no CSS downscale (offsetWidth == width attr)
last = await page.evaluate(() => [...document.querySelectorAll(".pl-wb-right #dashboard canvas")].map((c) => ({ attr: Number(c.getAttribute("width")), off: c.offsetWidth })));
ok(last.length === 3 && last.every((c) => c.attr === 480 && c.off === c.attr),
  `each canvas paints at its 480px attribute width, no CSS shrink (${JSON.stringify(last)})`);

// the view pane needs NO horizontal scrolling
last = await page.evaluate(() => {
  const vb = document.querySelector(".pl-wb-right .pl-wb-vbody");
  return vb ? { scrollW: vb.scrollWidth, clientW: vb.clientWidth } : null;
});
ok(!!last && last.scrollW <= last.clientW + 1, `no horizontal overflow in the view pane (scrollWidth ${last?.scrollW} ≤ clientWidth ${last?.clientW})`);

// on open (no scrolling): the species select AND the entire FIRST chart are inside the pane's visible box
last = await page.evaluate(() => {
  const vb = document.querySelector(".pl-wb-right .pl-wb-vbody");
  const sel = document.querySelector(".pl-wb-right #dashboard select");
  const c0 = document.querySelector(".pl-wb-right #dashboard canvas");
  if (!vb || !sel || !c0) return null;
  const vr = vb.getBoundingClientRect(), sr = sel.getBoundingClientRect(), cr = c0.getBoundingClientRect();
  const inside = (r) => r.left >= vr.left - 1 && r.right <= vr.right + 1 && r.top >= vr.top - 1 && r.bottom <= vr.bottom + 1;
  return { selVisible: inside(sr), firstChartVisible: inside(cr) };
});
ok(!!last && last.selVisible, "the species <select> is fully visible on open");
ok(!!last && last.firstChartVisible, "the ENTIRE first chart is fully visible on open (vertical scroll reaches the others)");

// no chart label is ellipsized to '…' in any of the three canvases
last = await page.evaluate(() => {
  const ell = [];
  for (const c of document.querySelectorAll(".pl-wb-right #dashboard canvas"))
    for (const o of JSON.parse(c.getAttribute("data-ops") ?? "[]")) if (o.op === "text" && /…/.test(o.text)) ell.push(o.text);
  return ell;
});
ok(Array.isArray(last) && last.length === 0, `no chart label is ellipsized to '…' (${JSON.stringify(last)})`);

ok(errs.length === 0, `no page errors (${errs.length ? errs[0]?.slice(0, 200) : "clean"})`);

console.log(`\n${pass} pass, ${fail} fail`);
await browser.close();
srv.kill();
process.exit(fail ? 1 : 0);
