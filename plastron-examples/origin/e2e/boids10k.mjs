// e2e: 🐟 10k Boids — the FORMULA-FIRST 10,000-boids doc (apps/docs/boids10k.json),
// successor to the retired fish_scene/fish_params pair. ONE segment whose GRID
// CELLS carry the whole program: params B2:B10, the SoA buffer cel D1 (schema
// "buffers"), the generation boundary D2, the params object as an infix formula
// D3, the sceneframe channel D4, the pump config D5, and the plastron-gpu
// =scene() pane grown by the =view() formula in A1.
//
// The full loop on a real (SwiftShader) WebGL context, through REAL affordances:
// desktop icon click → workbook + =view pane land on open (renderWorkbook's
// settle loop) → formulas visible in the formula bar → ▶ run seeds 10k fish +
// generation increases + pixels change → a params CELL edit re-derives the D3
// object mid-swim → close stops the pump → the 📂 picker (Sheets app) lists the
// doc and reopens it.
// Run:  cd plastron-examples/origin && bun e2e/boids10k.mjs
// (Serves the DEV server, not dist/: as of 2026-07-04 bundle.ts's sentinel bakes
//  corrupt the inlined kernel JS — the guide segment now carries the literal
//  [[VOCAB_CATALOG]] sentinel, and the whole-document html.replace() after
//  inlineAssets hits the occurrence INSIDE the module script, splicing
//  backtick-laden catalog text into a template literal → SyntaxError on boot.
//  Fix belongs to bundle.ts (run the bakes BEFORE inlineAssets, or anchor them
//  to the #llms block); switch back to dist once it boots.)
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT ?? 8845);
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
const cel = (k) => page.evaluate((key) => {
  const v = globalThis.plastron.state.cels.get(key)?.v;
  return typeof v === "object" && v && v.positions ? { n: v.n, len: v.positions.length } : v;
}, k);

await page.goto(`http://localhost:${PORT}/index.html`, { timeout: 60000 });
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });
await page.waitForTimeout(1500);

// ── 1) discoverable: the 📂 picker's data source lists it as a DOCUMENT ──────
last = await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  return (await resolveFn(state, "store.list")(state)).filter((e) => e.name === "boids10k");
});
ok(last?.length === 1 && !!last[0].app, `boids10k in the segment store as a document (app: ${last?.[0]?.app})`);

// ── 2) open via the REAL desktop icon ────────────────────────────────────────
last = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button.pl-desk-icon")].find((b) => /10k Boids/.test(b.textContent ?? ""));
  if (!btn) return false;
  btn.click();
  return true;
});
ok(last === true, "clicked the 🐟 10k Boids desktop icon");
await page.waitForTimeout(2000);   // opendoc + settle + lazy three import

last = await cel("win.boids10k.state");
ok(!!last && last.closed !== 1, "the 10k Boids workbook opened (win.boids10k.state live)");
ok(last?.views?.some((t) => t.title === "fish"), `A1's =view() grew the fish pane on open (views: ${JSON.stringify(last?.views?.map((t) => t.title))})`);
last = await page.evaluate(() => !!document.querySelector("canvas[data-scene]"));
ok(last === true, "the =scene() spec painted a <canvas data-scene> in the fish pane");

// ── 3) the grid IS the program: formulas visible in the bar ──────────────────
await page.click('.pl-wb-left .cell-value[data-key="boids10k.A1"]');
await page.waitForTimeout(400);
last = await page.evaluate(() => document.querySelector(".pl-wb-left textarea.fx-input")?.value);
ok(String(last ?? "").startsWith("=view("), `clicking A1 loads the =view()/scene formula into the bar (${JSON.stringify(last)?.slice(0, 30)}…)`);
await page.click('.pl-wb-left .cell-value[data-key="boids10k.D3"]');
await page.waitForTimeout(300);
last = await page.evaluate(() => document.querySelector(".pl-wb-left textarea.fx-input")?.value);
ok(/^=\{/.test(String(last ?? "")) && /cohesion/.test(String(last ?? "")), "clicking D3 loads the params object-literal formula into the bar");

// ── 3b) cursor the sheet: arrows traverse EMPTY addresses (the dims range) ───
await page.click('.pl-wb-left .cell-value[data-key="boids10k.B17"]');
await page.waitForTimeout(300);
await page.keyboard.press("ArrowDown");   // B18 — empty, synthesized from dims
await page.waitForTimeout(200);
await page.keyboard.press("ArrowDown");   // B19 — the steering =LAMBDA
await page.waitForTimeout(300);
last = await page.evaluate(() => ({
  sel: globalThis.plastron.state.cels.get("sheet.selected")?.v,
  bar: document.querySelector(".pl-wb-left textarea.fx-input")?.value ?? "",
}));
ok(last.sel === "boids10k.B19", `arrows cursor across the empty B18 down to B19 (selected: ${JSON.stringify(last.sel)})`);
ok(String(last.bar).startsWith("=LAMBDA("), "landing on B19 loads the steering rule into the formula bar");

// ── 4) ▶ run — flockSeed seeds the SoA buffers, the generation crosses ───────
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".pl-wb-vbody button")].find((b) => /run/.test(b.textContent ?? ""));
  btn?.click();
});
await page.waitForTimeout(1000);

last = await cel("boids10k.D1");
ok(last && last.len === 30000, `flockSeed init seeded 10k fish (positions len ${last?.len})`);
const g0 = await cel("boids10k.D2");
await page.waitForTimeout(600);
const g1 = await cel("boids10k.D2");
ok(typeof g0 === "number" && g1 > g0, `generation strictly increasing (${g0} → ${g1})`);

// ── 5) pixels change across generations ──────────────────────────────────────
const canvasBox = await page.evaluate(() => {
  const r = document.querySelector("canvas[data-scene]")?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
});
ok(!!canvasBox && canvasBox.width > 0, "scene canvas has layout");
const shot0 = await page.screenshot({ clip: canvasBox });
await page.waitForTimeout(500);
const shot1 = await page.screenshot({ clip: canvasBox });
ok(!shot0.equals(shot1), "pixels change across generations (the flock is swimming)");

// ── 6) edit a params CELL mid-swim → the D3 params object re-derives ─────────
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "setValue")(state, "boids10k.B4", 0.2);   // separation
});
await page.waitForTimeout(400);
last = await page.evaluate(() => globalThis.plastron.state.cels.get("boids10k.D3")?.v ?? null);
ok(last && last.separation === 0.2, `B4 edit re-derived the D3 params object (separation ${last?.separation})`);
const g2 = await cel("boids10k.D2");
await page.waitForTimeout(400);
ok((await cel("boids10k.D2")) > g2, "sim still advancing after the mid-swim edit");

// ── 7) close → the pump's while-gate stops it ────────────────────────────────
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "window.close")(state, "win.boids10k.state");
});
await page.waitForTimeout(400);
const g3 = await cel("boids10k.D2");
await page.waitForTimeout(500);
ok((await cel("boids10k.D2")) === g3, "closing the workbook stops the pump (generation stable)");

// ── 8) the 📂 picker (Sheets app) lists + reopens it — the REAL Open flow ─────
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "origin.navOpen")(state, "do:origin.newsheet");
});
await page.waitForTimeout(900);
await page.click('.pl-workbook .pl-wb-tool[title="Open a stored document"]');
await page.waitForTimeout(700);
last = await page.evaluate(() => [...document.querySelectorAll('[data-win="win.sheetopen.state"] button')].map((b) => b.textContent?.trim()));
ok(last?.some((t) => /boids10k/.test(t ?? "")), `the 📂 picker lists the doc (${JSON.stringify(last)})`);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[data-win="win.sheetopen.state"] button')].find((b) => /boids10k/.test(b.textContent ?? ""));
  btn?.click();
});
await page.waitForTimeout(1500);
last = await cel("win.boids10k.state");
ok(!!last && last.closed !== 1, "picking 📄 boids10k reopens the workbook");
last = await page.evaluate(() => !!document.querySelector("canvas[data-scene]"));
ok(last === true, "the scene pane is back after the picker reopen");

ok(errs.length === 0, `no page errors (${errs.length ? errs[0]?.slice(0, 200) : "clean"})`);

console.log(`\n${pass} pass, ${fail} fail`);
await browser.close();
srv.kill();
process.exit(fail ? 1 : 0);
