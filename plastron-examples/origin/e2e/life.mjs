// e2e: 🦠 Life — the ECS app converted to a formula-first sheetapp document
// (apps/docs/life.json; the old app:ecsapp is retired — its fish half lives in
// the boids doc). A 🦠 Life desktop icon exists again as a shortcut (doc:life);
// this e2e opens via origin.opendoc — the same verb the icon AND the Sheets 📂
// picker dispatch — so it also proves the picker's open path.
// The whole automaton is visible cells: the 0/1 grid TABLE in
// B11, the =automaton(B11, gw, gh, rule) SYSTEM in B12, the sim.run pump in B13,
// THE RULE as a =LAMBDA (B2) + wat twin (B9, bound by =WAT in B10), params B3:B8,
// and the render pane grown by A1's =view("🦠 automaton", …) formula. Open it
// from the desktop icon AND from the Sheets 📂 picker, press ▶ run, edit the
// rules mid-flight, close (flush + evict) and reopen fresh from the store.
//
//   bun e2e/life.mjs        (spawns its own dev server on :8896)
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 8896;
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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0, last;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); if (!c) console.log("      last:", JSON.stringify(last)?.slice(0, 240)); };
const alive = () => page.evaluate(() => {
  const g = globalThis.plastron.state.cels.get("life.B11")?.v;
  return Array.isArray(g) ? g.reduce((a, b) => a + b, 0) : null;
});
const paneRects = () => page.evaluate(() => {
  const c = document.querySelector(".pl-wb-vbody canvas[data-ops]");
  return c ? JSON.parse(c.getAttribute("data-ops") ?? "[]").filter((o) => o.op === "rect").length : null;
});

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });
// 1) open via origin.opendoc — the verb the 🦠 Life icon (doc:life) and the
//    Sheets 📂 picker both dispatch (the icon returned 2026-07-05 as a shortcut).
await page.evaluate(async () => { const { state, resolveFn } = globalThis.plastron; await resolveFn(state, "origin.opendoc")(state, "life"); });
await page.waitForTimeout(1200);

last = await page.evaluate(() => globalThis.plastron.state.cels.get("win.life.state")?.v ?? null);
ok(!!last && last.closed !== 1, "the Life workbook opened (win.life.state live)");
ok(last?.sheets?.map((t) => t.title).join(",") === "life", "the life worksheet is the LEFT tab");
const vt = (last?.views ?? []).map((t) => t.title);
ok(vt.length === 1 && /automaton/.test(vt[0]), `A1's =view() grew the automaton pane on the right (${JSON.stringify(vt)})`);

// 2) the viz is IN the right pane, none in the grid; the pane paints the soup
last = await page.evaluate(() => ({
  right: !!document.querySelector(".pl-wb-right #automaton canvas"),
  left: document.querySelectorAll(".pl-wb-left canvas").length,
  buttons: [...document.querySelectorAll(".pl-wb-right #automaton button")].map((b) => b.textContent?.trim()).join(","),
}));
ok(last.right === true, "the automaton canvas renders in the RIGHT view pane");
ok(last.left === 0, "NO canvas renders inside the worksheet grid (left pane)");
ok(/run/.test(last.buttons) && /stop/.test(last.buttons), `▶ run / ⏸ stop render in the pane (${last.buttons})`);
last = await paneRects();
ok(last === 381, `the canvas paints the seeded soup (381 rects = bg + 380 live cells, got ${last})`);

// 3) the cells ARE the program: formulas visible in the bar
await page.click('.cell-value[data-key="life.B12"]');
await page.waitForTimeout(300);
last = await page.evaluate(() => document.querySelector("textarea.fx-input")?.value ?? "");
ok(last.startsWith("=automaton("), `clicking D2 loads the system formula into the bar (${JSON.stringify(last.slice(0, 30))})`);
await page.click('.cell-value[data-key="life.A1"]');
await page.waitForTimeout(300);
last = await page.evaluate(() => document.querySelector("textarea.fx-input")?.value ?? "");
ok(last.replace(/\s+/g, " ").includes('=view( "🦠 automaton"') || last.startsWith('=view("🦠 automaton"'),
  "clicking A1 loads the generating =view formula into the bar");
last = await page.evaluate(() => document.querySelector('.cell-value[data-key="life.B6"]')?.textContent ?? "");
ok(/384/.test(last), `B6 shows the DERIVED canvas width (=B3*B5 → ${JSON.stringify(last)})`);

// 3b) the pump is NOT a black box: D3 is a FORMULA over the labeled cells,
// and sim.run re-reads its value every frame — so the fps knob is live.
await page.click('.cell-value[data-key="life.B13"]');
await page.waitForTimeout(300);
last = await page.evaluate(() => ({
  bar: document.querySelector("textarea.fx-input")?.value ?? "",
  f: globalThis.plastron.state.cels.get("life.B13")?.f ?? "",
  fps: globalThis.plastron.state.cels.get("life.B13")?.v?.fps,
}));
ok(last.f.startsWith("={"), `D3 is the pump RECIPE formula (${JSON.stringify(last.f.slice(0, 24))}…)`);
ok(last.bar.replace(/\s+/g, "").startsWith("={"), "clicking D3 shows the whole pump recipe in the formula bar");
ok(last.fps === 10, `the recipe read the fps CELL (cfg.fps = ${last.fps} = B8)`);
await page.click('.cell-value[data-key="life.B8"]');
await page.waitForTimeout(250);
await page.fill("textarea.fx-input", "30");
await page.press("textarea.fx-input", "Enter");
await page.waitForTimeout(500);
last = await page.evaluate(() => globalThis.plastron.state.cels.get("life.B13")?.v?.fps);
ok(last === 30, `editing the fps cell re-derived the pump config LIVE (cfg.fps → ${last})`);

// 4) ▶ run — the pump commits generations; the PANE derives from the grid.
// (The former origin.effects landing workaround is gone: the pump drains
// origin.effects per frame, and the landing cascade recomposes the root
// view itself — 元.view's vals carry each frame's content cels.)
await page.click(".pl-wb-right #automaton button");   // first button = ▶ run
const a0 = await alive();
const ops0 = await page.evaluate(() => document.querySelector(".pl-wb-vbody canvas[data-ops]")?.getAttribute("data-ops"));
await page.waitForTimeout(700);                        // fps 10 → ~7 generations
const a1 = await alive();
ok(a0 !== a1, `▶ run: generations advance (population ${a0} → ${a1})`);
const ops1 = await page.evaluate(() => document.querySelector(".pl-wb-vbody canvas[data-ops]")?.getAttribute("data-ops"));
ok(ops0 !== ops1, "the pane canvas re-renders from the committed generations");

// 5) THE RULE IS A CELL (grid-program contract): edit the WAT SOURCE mid-run —
// a kill-all kernel (always 0) empties the soup; the B10 binder recompiles the
// committed source and the next pump commit runs the new rule.
await page.click('.cell-value[data-key="life.B9"]');
await page.waitForTimeout(300);
await page.fill("textarea.fx-input", `='(module (func (export "main") (param $alive f64) (param $n f64) (result f64) (f64.const 0)))'`);
await page.press("textarea.fx-input", "Enter");
await page.waitForTimeout(900);                        // recompile + ≥1 commit under the new rule
last = await alive();
ok(last === 0, `the wat rule edit changed behavior: kill-all emptied the grid (population ${last})`);
// restore Conway for the reopen half (a dead grid stays dead — close SAVES, so keep it honest below)
await page.click('.cell-value[data-key="life.B9"]');
await page.waitForTimeout(200);
await page.fill("textarea.fx-input", `='(module (func (export "main") (param $alive f64) (param $n f64) (result f64)\n  (if (result f64) (f64.gt (local.get $alive) (f64.const 0))\n    (then (select (f64.const 1) (f64.const 0)\n      (i32.or (f64.eq (local.get $n) (f64.const 2)) (f64.eq (local.get $n) (f64.const 3)))))\n    (else (select (f64.const 1) (f64.const 0) (f64.eq (local.get $n) (f64.const 3)))))\n))'`);
await page.press("textarea.fx-input", "Enter");
await page.waitForTimeout(500);

// 6) close → the while-gate stops the pump AND the doc flushes + evicts
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "window.close")(state, "win.life.state");
});
await page.waitForTimeout(600);
last = await page.evaluate(() => globalThis.plastron.state.cels.has("life.B11"));
ok(last === false, "closing the workbook flushes + evicts the doc (life.* gone; the while-gate stopped the pump)");

// 7) reopen through the REAL Sheets flow: 田 Sheet → 📂 Open → pick 📄 life
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button.pl-desk-icon")].find((b) => /田 Sheet/.test(b.textContent ?? ""));
  btn?.click();
});
await page.waitForTimeout(1000);
await page.click('.pl-workbook .pl-wb-tool[title="Open a stored document"]');
await page.waitForTimeout(700);
last = await page.evaluate(() => [...document.querySelectorAll('[data-win="win.sheetopen.state"] button')].map((b) => b.textContent?.trim()));
ok(last?.some((t) => /^📄 life$/.test(t ?? "")), `the 📂 picker lists the life doc (${JSON.stringify(last)?.slice(0, 120)})`);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('[data-win="win.sheetopen.state"] button')].find((b) => /^📄 life$/.test(b.textContent?.trim() ?? ""));
  btn?.click();
});
await page.waitForTimeout(1200);
last = await page.evaluate(() => globalThis.plastron.state.cels.get("win.life.state")?.v ?? null);
ok(!!last && last.closed !== 1 && (last.views ?? []).some((t) => /automaton/.test(t.title)),
  "picking 📄 life reopened the workbook with the automaton pane (fresh from the store)");
last = await page.evaluate(() => ({
  lam: globalThis.plastron.state.cels.get("life.B2")?.f ?? "",
  wat: String(globalThis.plastron.state.cels.get("life.B9")?.v ?? ""),
  grid: globalThis.plastron.state.cels.get("life.B11")?.v?.length,
}));
ok(last.lam.startsWith("=LAMBDA(") && last.wat.startsWith("(module") && last.grid === 1440,
  `the close SAVED the doc — both rule tiers + the grid persisted (grid ${last.grid})`);

ok(errs.length === 0, `no page errors (${errs.length ? errs[0]?.slice(0, 200) : "clean"})`);

console.log(`\n${pass} pass, ${fail} fail`);
await browser.close();
srv.kill();
process.exit(fail ? 1 : 0);
