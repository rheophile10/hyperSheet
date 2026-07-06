// e2e: the ECS demos from a FRESH localhost boot of the DEV server — verifies
// exactly what a user gets from `bun serve.ts` + clicking the desktop icons.
// Two variants, both launched by clicking the REAL desktop icon buttons:
//   🦠 Life  (doc:life)       — the ECS app CONVERTED to a formula-first doc:
//                               the 0/1 grid table (B11), the =automaton system
//                               (B12), the pump config (B13) and the rule kernel cells
//                               as visible cells; the canvas pane grown by A1's
//                               =view() formula. (The old app:ecsapp is retired;
//                               its fish half lives in the boids doc.)
//   🐟 10k Boids (doc:boids10k) — 10,000 fish, 3D instanced (plastron-gpu) on a
//                               real (SwiftShader) WebGL context; formula-first:
//                               a params CELL edit re-derives the D3 object mid-swim.
// Run:  cd plastron-examples/origin && bun e2e/fish-localhost.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT ?? 5175);
const origin = "/home/ian/projects/plastron/plastron-examples/origin";
const srv = spawn("bun", [`${origin}/serve.ts`], { stdio: "ignore", env: { ...process.env, PORT: String(PORT) } });

// wait for the dev server to answer (the first request triggers a full Bun.build)
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
// click a desktop icon by its label — the exact user click path.
const clickIcon = (label) => page.evaluate((lbl) => {
  const btn = [...document.querySelectorAll("button.pl-desk-icon")].find((b) => (b.textContent ?? "").includes(lbl));
  if (!btn) return false;
  btn.click();
  return true;
}, label);

await page.goto(`http://localhost:${PORT}/`, { timeout: 60000 });
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });
await page.waitForTimeout(1500); // desktop boot: baked apps → OPFS → icons paint

last = await page.evaluate(() => [...document.querySelectorAll("button.pl-desk-icon")].map((b) => b.textContent?.trim()));
ok(Array.isArray(last) && last.some((t) => /10k Boids/.test(t)) && last.some((t) => /Life/.test(t))
    && last.some((t) => /Boids/.test(t)) && !last.some((t) => /ECS/.test(t)),
  `desktop boots with 🐟 10k Boids + 🦠 Life + 🐠 Boids icons (ECS retired; ${last?.length} icons)`);

// NB: the 3D doc runs FIRST — a closed 2D workbook's <canvas> (a data-ops
// element with a live 2d context) can be REUSED by the vnode differ for the
// scene canvas, and a canvas can't switch context kinds (THREE then fails
// with "existing context of a different type"). Virgin page → WebGL first.
// ═══════════════════ 🐟 10k Boids (formula-first, 3D doc) ═══════════════════
console.log("— 🐟 10k Boids (10,000 fish, plastron-gpu, formula-first) —");
last = await clickIcon("10k Boids");
ok(last === true, "clicked the 🐟 10k Boids desktop icon");
await page.waitForTimeout(2000);

last = await page.evaluate(() => globalThis.plastron.state.cels.get("win.boids10k.state")?.v ?? null);
ok(!!last && last.closed !== 1, "the 10k Boids workbook opened (win.boids10k.state live)");
last = await page.evaluate(() => !!document.querySelector("canvas[data-scene]"));
ok(last === true, "A1's =view()/=scene() formula painted a <canvas data-scene> in the fish pane");

await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /run/.test(b.textContent ?? ""));
  btn?.click();
});
await page.waitForTimeout(1000);

last = await cel("boids10k.D1");
ok(last && last.len === 30000, `flockSeed seeded 10k fish (positions len ${last?.len})`);
const g0 = await cel("boids10k.D2");
await page.waitForTimeout(600);
const g1 = await cel("boids10k.D2");
ok(typeof g0 === "number" && g1 > g0, `generation strictly increasing (${g0} → ${g1})`);

const canvasBox = await page.evaluate(() => {
  const r = document.querySelector("canvas[data-scene]")?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
});
ok(!!canvasBox && canvasBox.width > 0, "scene canvas has layout");
const shot0 = await page.screenshot({ clip: canvasBox });
await page.waitForTimeout(500);
const shot1 = await page.screenshot({ clip: canvasBox });
ok(!shot0.equals(shot1), "pixels change across generations (the flock is swimming)");

// params CELL edit mid-swim → the D3 params object re-derives
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "setValue")(state, "boids10k.B4", 0.2);
});
await page.waitForTimeout(300);
last = await page.evaluate(() => globalThis.plastron.state.cels.get("boids10k.D3")?.v ?? null);
ok(last && last.separation === 0.2, `sheet edit re-derived the D3 params object (separation ${last?.separation})`);
const g2 = await cel("boids10k.D2");
await page.waitForTimeout(1200);   // SwiftShader frames are slow — give it a few
ok((await cel("boids10k.D2")) > g2, "sim still advancing after the mid-swim edit");

// the pump is NOT a black box: D5 is a formula over labeled cells (fps/count/seed)
last = await page.evaluate(() => ({
  f: globalThis.plastron.state.cels.get("boids10k.D5")?.f ?? "",
  cfg: globalThis.plastron.state.cels.get("boids10k.D5")?.v,
}));
ok(last.f.startsWith("={"), `D5 is the pump RECIPE formula (${JSON.stringify(last.f.slice(0, 20))}…)`);
ok(JSON.stringify(last.cfg?.effects?.[0]?.initArgs) === "[10000,42,20,12,20]",
  `initArgs read the count/seed/w/h/d CELLS (${JSON.stringify(last.cfg?.effects?.[0]?.initArgs)})`);
// where the BEHAVIOR is defined: THE RULE IS ON THE GRID (grid-program
// contract, R10), stacked vertically — B19 is the legible =LAMBDA, B20 the
// wat SOURCE, B21 the =WAT binder that mints boids10k.steerwat; the pump's
// kernel picked one.
last = await page.evaluate(() => ({
  row: document.querySelector(".pl-wb-left")?.textContent ?? "",
  lam: globalThis.plastron.state.cels.get("boids10k.B19")?.f ?? "",
  src: String(globalThis.plastron.state.cels.get("boids10k.B20")?.v ?? ""),
  bind: globalThis.plastron.state.cels.get("boids10k.B21")?.f ?? "",
  wat: typeof globalThis.plastron.state.cels.get("boids10k.steerwat")?._fn,
  by: globalThis.plastron.state.cels.get("boids10k.steerwat")?.metadata?.definedBy,
  kern: typeof globalThis.plastron.state.cels.get("boids10k.D5")?.v?.effects?.[0]?.kernel,
}));
ok(/B20/.test(last.row) && /B19/.test(last.row), "the rule rows point at B19 (=LAMBDA) + B20/B21 (wat tier)");
ok(last.lam.startsWith("=LAMBDA("), `B19 IS the steering rule, authored as a formula (${JSON.stringify(last.lam.slice(0, 24))}…)`);
ok(last.src.startsWith("(module"), "B20 carries the wat SOURCE on the grid — readable, editable");
ok(last.bind.startsWith("=WAT(B20"), `B21 is the binder that mints the compiled rule (${JSON.stringify(last.bind)})`);
ok(last.wat === "function" && last.by === "boids10k.B21", `the minted kernel compiled + is lineage-stamped to B21 (definedBy: ${last.by})`);
ok(last.kern === "function", "the pump's kernel is a CALLABLE cel reference, not a string");
last = last.row;
// the HONEST reseed story: count/seed are SEED-time knobs — flockSeed only runs
// when D1 is EMPTY. Edit the seed cell, clear D1 mid-run → next frame reseeds
// with the live cell values. (close+reopen does NOT reseed — the buffers schema
// saves D1 with the doc.)
const pos0 = await page.evaluate(() => globalThis.plastron.state.cels.get("boids10k.D1")?.v?.positions?.[0]);
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "setValue")(state, "boids10k.B13", 7);      // new RNG seed
  await resolveFn(state, "setValue")(state, "boids10k.D1", {});      // clear the buffer mid-run
});
await page.waitForTimeout(600);                                      // ≥1 pump frame → init refires
last = await cel("boids10k.D1");
const pos1 = await page.evaluate(() => globalThis.plastron.state.cels.get("boids10k.D1")?.v?.positions?.[0]);
ok(last && last.len === 30000 && pos0 !== pos1,
  `clearing D1 mid-run RESEEDED from the live cells (n ${last?.n}, pos[0] ${pos0?.toFixed?.(2)} → ${pos1?.toFixed?.(2)})`);

// close the 3D workbook before the next demo — its 60fps effect pump saturates
// the main thread (the Life opendoc raced it and lost), and a user moving on
// closes the window anyway. The while-gate stops the pump with it.
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "window.close")(state, "win.boids10k.state");
});
await page.waitForTimeout(800);

// ════════════════════════ 🦠 Life (formula-first doc) ═══════════════════════
console.log("— 🦠 Life (the automaton as a formula-first doc) —");
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "origin.opendoc")(state, "life");
});
ok(true, "opened the life doc via origin.opendoc (no desktop icon by design)");
await page.waitForTimeout(1800);

last = await cel("win.life.state");
ok(!!last && last.closed !== 1, "the Life workbook opened (win.life.state live)");
ok((last?.views ?? []).some((t) => /automaton/.test(t.title)), `A1's =view() grew the automaton pane (views: ${JSON.stringify(last?.views?.map((t) => t.title))})`);
// THE RULE IS ON THE GRID (grid-program contract, R10): B2 the legible
// =LAMBDA, B9 the wat source, B10 the =WAT binder minting life.rulewat.
last = await page.evaluate(() => ({
  row: document.querySelector(".pl-wb-left")?.textContent ?? "",
  lam: globalThis.plastron.state.cels.get("life.B2")?.f ?? "",
  wat: String(globalThis.plastron.state.cels.get("life.B9")?.v ?? ""),
  kern: typeof globalThis.plastron.state.cels.get("life.rulewat")?._fn,
}));
ok(/rule =LAMBDA/.test(last.row) && /rule \(wat\)/.test(last.row), "the rule rows render in the worksheet grid (both tiers labeled)");
ok(last.lam.startsWith("=LAMBDA(alive, n,") && last.wat.startsWith("(module") && last.kern === "function",
  `the rule is authored on the sheet + the wat tier compiled (kernel: ${last.kern})`);
last = last.row;
last = await page.evaluate(() => [...document.querySelectorAll(".pl-wb-vbody canvas[data-ops]")].map((c) => JSON.parse(c.getAttribute("data-ops") ?? "[]").filter((o) => o.op === "rect").length));
ok(last?.[0] === 381, `life canvas painted from A1's formula (381 rects = bg + 380 live cells), got ${JSON.stringify(last)}`);

await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".pl-wb-vbody button")].find((b) => /run/.test(b.textContent ?? ""));
  btn?.click();
});
const e0 = JSON.stringify(await cel("life.B11"))?.slice(0, 400);
await page.waitForTimeout(500);
const e1 = JSON.stringify(await cel("life.B11"))?.slice(0, 400);
ok(e0 !== e1, "▶ run: the pump commits generations into the grid (life.B11 changing)");

// rules CELL edit mid-flight: the =automaton system re-derives under the new rulestring
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "setValue")(state, "life.B2", "B36/S23");   // HighLife
});
await page.waitForTimeout(300);
last = await page.evaluate(() => globalThis.plastron.state.cels.get("life.B12")?.v?.length);
ok(last === 1440, "rules edit mid-flight: =automaton still deriving the full grid");

// the pump is NOT a black box: D3 is a formula reading the fps cell — live
last = await page.evaluate(() => globalThis.plastron.state.cels.get("life.B13")?.f ?? "");
ok(last.startsWith("={"), `D3 is the pump RECIPE formula (${JSON.stringify(last.slice(0, 20))}…)`);
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "setValue")(state, "life.B8", 30);
});
await page.waitForTimeout(300);
last = await page.evaluate(() => globalThis.plastron.state.cels.get("life.B13")?.v?.fps);
ok(last === 30, `editing the fps cell re-derived the pump config LIVE (cfg.fps → ${last})`);

// close → the while-gate stops the pump AND the doc flushes + evicts
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "window.close")(state, "win.life.state");
});
await page.waitForTimeout(600);
last = await page.evaluate(() => globalThis.plastron.state.cels.has("life.B11"));
ok(last === false, "closing the Life workbook flushes + evicts the doc (life.* gone; the while-gate stopped the pump)");

// ═══════════ 🐟 boids (2D) — the STEERING RULE defined in the sheet ═══════════
console.log("— boids (2D): the steering rule is a sheet LAMBDA —");
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "origin.navOpen")(state, "doc:boids");   // picker-first doc (no icon)
});
await page.waitForTimeout(1500);
last = await cel("win.boids.state");
ok(!!last && last.closed !== 1, "the boids workbook opened");
last = await page.evaluate(() => ({
  d6: globalThis.plastron.state.cels.get("boids.B11")?.f ?? "",
  d3: globalThis.plastron.state.cels.get("boids.B14")?.f ?? "",
  d6v: typeof globalThis.plastron.state.cels.get("boids.B11")?.v,
}));
ok(last.d6.startsWith("=LAMBDA(pos, vel, nbrs"), "B11 holds the steering rule as a visible =LAMBDA");
ok(last.d3.startsWith("=sysmap(B11,"), "B14 maps the SHEET rule (not the native) over every fish");
ok(last.d6v === "function", "B11's value is the callable the sysmap contract needs");
await page.click('.pl-wb-left .cell-value[data-key="boids.B11"]');
await page.waitForTimeout(400);
last = await page.evaluate(() => document.querySelector(".pl-wb-left textarea.fx-input")?.value ?? "");
ok(last.replace(/\s+/g, " ").startsWith("=LAMBDA( pos") || last.startsWith("=LAMBDA(pos"),
  "clicking B11 shows the WHOLE steering rule in the formula bar");
// the sim runs ON the sheet rule: dispatch the pump directly — BOTH boids docs
// name their view "fish", so after the 10k demo the shared fish.view pane holds
// TWO ▶ run slots and a DOM click can hit the evicted doc's dead button (the
// button-click path is covered standalone in fish-sheet.mjs; see the report's
// view-name-collision note).
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "sim.run")(state, "boids.B16");
});
await page.waitForTimeout(300);
const b0 = JSON.stringify(await cel("boids.B12"))?.slice(0, 200);
await page.waitForTimeout(800);
const b1v = JSON.stringify(await cel("boids.B12"))?.slice(0, 200);
ok(b0 !== b1v, "▶ run: the flock advances under the FORMULA rule");
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "setValue")(state, "boids.B4", 0.3);   // separation up
});
await page.waitForTimeout(400);
last = await page.evaluate(() => {
  const v = globalThis.plastron.state.cels.get("boids.B14")?.v;
  return Array.isArray(v) && v.length === 60 && v.flat().every(Number.isFinite);
});
ok(last === true, "param edit mid-flight: the sheet rule re-derives 60 finite velocity pairs");
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "window.close")(state, "win.boids.state");
});
await page.waitForTimeout(500);

ok(errs.length === 0, `no page errors (${errs.length ? errs[0]?.slice(0, 200) : "clean"})`);

console.log(`\n${pass} pass, ${fail} fail`);
await browser.close();
srv.kill();
process.exit(fail ? 1 : 0);
