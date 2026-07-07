// e2e capstone story — "I open Turtles and every graph is whole — labels,
// legend, last bar and all" (card 35137405; story-turtles-chart-canvas-size).
// Films the chart-canvas-size fix step-for-step from the story:
//   1. load the origin desktop (1280×720) and see the desktop icons;
//   2. click 📊 Turtles — ONE workbook opens (worksheets left, 🐢 dashboard
//      right) and the whole window fits the screen (nothing off the edge);
//   3. WITHOUT resizing, the species select + the ENTIRE bar chart are visible:
//      all 7 bars, a value above each, every species name spelled out
//      ("Leatherback"/"Loggerhead" whole, no "…"), no bar off the right edge,
//      the baseline axis present;
//   4. scroll the pane down (vertically only — no sideways scrollbar): the line
//      chart is whole — a 7-point polyline, all 7 x-axis labels, none clipped;
//   5. keep scrolling: the pie chart is complete — 7 wedges closing the circle,
//      a legend of all 7 species with value + %, no "+N more";
//   6. pick "Leatherback" — every chart re-renders to the one species, still in
//      its canvas; pick "all" — the seven come back;
//   7. click the turtle_charts sheet, select B4 — the formula bar shows the
//      canvas + matching box sizes (480, 300) right there on the surface.
// Records the story video via Playwright recordVideo. Dev-server pattern of
// e2e/turtles.mjs (serve.ts bakes the CURRENT apps/docs/turtles.json).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";

const PORT = 8895;
const originDir = new URL("..", import.meta.url).pathname;
const videoDir = join(originDir, "e2e", "videos", "story-turtles-chart-canvas-size");
await mkdir(videoDir, { recursive: true });

const srv = spawn("bun", ["serve.ts"], { cwd: originDir, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://localhost:${PORT}/index.html`); if (r.ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
});
const page = await context.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0, last;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); if (!c) console.log("      last:", JSON.stringify(last)?.slice(0, 260)); };
const opsOfCanvas = (idx) => page.evaluate((i) => {
  const c = document.querySelectorAll(".pl-wb-right #dashboard canvas")[i];
  return c ? JSON.parse(c.getAttribute("data-ops") ?? "[]") : null;
}, idx);
// a canvas is "whole in view" when its bounding rect sits inside the scrollable
// view body's visible box (after scrolling it into view).
const canvasInView = (idx) => page.evaluate((i) => {
  const vb = document.querySelector(".pl-wb-right .pl-wb-vbody");
  const c = document.querySelectorAll(".pl-wb-right #dashboard canvas")[i];
  if (!vb || !c) return null;
  c.scrollIntoView({ block: "center" });
  const vr = vb.getBoundingClientRect(), cr = c.getBoundingClientRect();
  return cr.left >= vr.left - 1 && cr.right <= vr.right + 1 && cr.top >= vr.top - 1 && cr.bottom <= vr.bottom + 1;
}, idx);

// 1) the desktop with its icons
await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });
await page.waitForSelector('button.pl-desk-icon[data-icon="📊 Turtles"]', { timeout: 15000 });
await page.waitForTimeout(600);
ok(await page.evaluate(() => document.querySelectorAll("button.pl-desk-icon").length > 0), "the origin desktop shows its icons");

// 2) click 📊 Turtles → one workbook, whole window on screen
await page.click('button.pl-desk-icon[data-icon="📊 Turtles"]');
await page.waitForTimeout(1400);
last = await page.evaluate(() => {
  const w = document.querySelector('.pl-window[data-win="win.turtle_charts.state"]');
  if (!w) return null;
  const r = w.getBoundingClientRect();
  return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
});
ok(!!last && last.left >= 0 && last.top >= 0 && last.right <= 1280 && last.bottom <= 720,
  `the Turtles workbook opened and fits the screen (${JSON.stringify(last)})`);
ok(await page.evaluate(() => document.querySelectorAll(".pl-wb-right #dashboard canvas").length === 3), "the 🐢 dashboard pane holds all three charts");
ok(await page.evaluate(() => {
  const vb = document.querySelector(".pl-wb-right .pl-wb-vbody");
  return vb && vb.scrollWidth <= vb.clientWidth + 1;
}), "there is no sideways scrollbar (vertical scroll only)");

// 3) the bar chart is whole on open — 7 bars, values, every species name, no "…", axis present
ok(await canvasInView(0), "the ENTIRE bar chart is visible without resizing");
last = await opsOfCanvas(0);
ok(last && last.filter((o) => o.op === "rect").length === 8, `all seven bars render (+ bg) (${last?.filter((o) => o.op === "rect").length} rects)`);
const barLabels = (last ?? []).filter((o) => o.op === "text" && o.font === "9px system-ui").map((o) => o.text);
ok(barLabels.includes("Leatherback") && barLabels.includes("Loggerhead"), `species names spelled out whole ("Leatherback"/"Loggerhead") (${JSON.stringify(barLabels)})`);
ok(!(last ?? []).some((o) => o.op === "text" && /…/.test(o.text)), "no bar-chart label is ellipsized");
ok((last ?? []).some((o) => o.op === "line"), "the baseline axis renders");
ok((last ?? []).every((o) => o.op !== "rect" || (o.x + o.w <= 480 + 1e-9 && o.x >= -1e-9)), "no bar falls off the right edge");

// 4) scroll down → the line chart is whole
ok(await canvasInView(1), "scrolling down, the ENTIRE line chart comes into view");
last = await opsOfCanvas(1);
ok(last && last.some((o) => o.op === "line" && o.points?.length === 7), "the polyline reaches all seven points");
const lineXLabels = (last ?? []).filter((o) => o.op === "text" && o.font === "9px system-ui" && o.y >= 295);
ok(lineXLabels.length === 7, `all seven labels along the bottom (${lineXLabels.length})`);
ok(lineXLabels.every((o) => o.x >= -1e-9 && o.x + o.text.length * 9 * 0.52 <= 480 + 1e-9), "every x-axis label — Loggerhead included — sits inside the box");
ok(!lineXLabels.some((o) => /…/.test(o.text)), "no line-chart label is ellipsized");

// 5) keep scrolling → the pie chart is complete
ok(await canvasInView(2), "scrolling further, the ENTIRE pie chart comes into view");
last = await opsOfCanvas(2);
ok(last && last.filter((o) => o.op === "wedge").length === 7, `the full circle: seven wedges (${last?.filter((o) => o.op === "wedge").length})`);
ok((last ?? []).filter((o) => o.op === "text" && /\(\d+%\)/.test(o.text)).length === 7, "the legend lists all seven species with value + %");
ok(!(last ?? []).some((o) => /\+\d+ more/.test(o.text ?? "")), "no '+N more' overflow row");

// 6) filter to one species, then back to all
await page.evaluate(() => { document.querySelector(".pl-wb-right .pl-wb-vbody")?.scrollTo(0, 0); });
await page.waitForTimeout(300);
await page.selectOption(".pl-wb-right #dashboard select", "Leatherback");
await page.waitForTimeout(600);
last = await opsOfCanvas(0);
ok(last && last.filter((o) => o.op === "rect").length === 2, `picking "Leatherback" re-renders every chart to the one species (${last?.filter((o) => o.op === "rect").length} rects)`);
await page.selectOption(".pl-wb-right #dashboard select", "all");
await page.waitForTimeout(600);
last = await opsOfCanvas(0);
ok(last && last.filter((o) => o.op === "rect").length === 8, "picking 'all' brings the seven back");

// 7) the sizes are visible on the surface — B4's formula
await page.evaluate(() => {
  const tab = Array.from(document.querySelectorAll(".pl-wb-left .pl-wb-tab")).find((b) => b.textContent?.trim() === "turtle_charts");
  tab?.click();
});
await page.waitForTimeout(400);
await page.click('.cell-value[data-key="turtle_charts.B4"]');
await page.waitForTimeout(400);
last = await page.evaluate(() => document.querySelector("textarea.fx-input")?.value ?? "");
ok(/canvas\(\s*480\s*,\s*300\s*,/.test(last) && /0,\s*0,\s*480,\s*300/.test(last.replace(/\s+/g, " ")),
  "selecting B4 shows the 480×300 canvas + matching chart box on the surface");

ok(errs.length === 0, `no page errors (${errs.length ? errs[0]?.slice(0, 200) : "clean"})`);

await page.waitForTimeout(600);
console.log(`\n${pass} pass, ${fail} fail`);
// finalize the recording: closing the context flushes the .webm; give it a stable name.
await context.close();
await browser.close();
srv.kill();
try {
  const vids = (await readdir(videoDir)).filter((f) => f.endsWith(".webm"));
  if (vids.length) { await rename(join(videoDir, vids[0]), join(videoDir, "story.webm")); console.log(`video: ${join(videoDir, "story.webm")}`); }
} catch { /* video rename best-effort */ }
process.exit(fail ? 1 : 0);
