// e2e: the =view() TOKEN paints in the grid cell — the ⋯-forever regression.
//
// A `=view("fish", …)` cell's value flip-flops by design: every unsuppressed
// runCycle re-evaluates the formula to its REQUEST (grid shows a quiet ⋯),
// and the origin.effects drain lands the ⧉ token back via a SUPPRESSED
// cascade. The mount handle a window frame returns is deliberately stable,
// so that landing cascade only reaches the root view because 元.view's vals
// carry each frame's CONTENT cels (origin's rewireView / frameContentKeys).
// This test pins that edge: the painted grid leaf must read `⧉ fish +` right
// after opendoc (no manual nudges) and STAY ⧉ on every sampled frame while
// the sim.run pump commits positions.
// Run:  cd plastron-examples/origin && bun e2e/view-token-paint.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT ?? 5179);
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

// ── open the boids doc EXACTLY as the console would — no nudges after ────────
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "origin.opendoc")(state, "boids");
});
await page.waitForTimeout(1000);

const painted = () => page.evaluate(() =>
  document.querySelector('.pl-wb-left .cell-value[data-key="boids.A1"]')?.textContent ?? null);

// the CEL landed the token…
last = await page.evaluate(() => globalThis.plastron.state.cels.get("boids.A1")?.v ?? null);
ok(last && last.view === "fish" && last.item === true, `A1's value is the landed ⧉ token (${JSON.stringify(last)})`);
// …and the PAINTED grid leaf shows it — no view.refresh / runCycle nudges.
last = await painted();
ok(last === "⧉ fish +", `the painted grid cell reads "⧉ fish +" right after opendoc (got ${JSON.stringify(last)})`);

// ── ▶ run: the painted token must SURVIVE the pump's request→token churn ─────
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".pl-wb-vbody button")].find((b) => /run/.test(b.textContent ?? ""));
  btn?.click();
});
await page.waitForTimeout(600);
const samples = [];
for (let i = 0; i < 5; i++) {
  samples.push({
    painted: await painted(),
    d1: await page.evaluate(() => JSON.stringify(globalThis.plastron.state.cels.get("boids.D1")?.v?.[0])),
  });
  await page.waitForTimeout(350);
}
last = samples;
ok(new Set(samples.map((s) => s.d1)).size > 1,
  `the pump advances D1 across samples (${samples[0].d1} → ${samples.at(-1).d1})`);
ok(samples.every((s) => s.painted === "⧉ fish +"),
  `the painted cell reads "⧉ fish +" on every sampled frame while running (${JSON.stringify(samples.map((s) => s.painted))})`);

ok(errs.length === 0, `no page errors (${errs.length ? errs[0]?.slice(0, 200) : "clean"})`);

console.log(`\n${pass} pass, ${fail} fail`);
await browser.close();
srv.kill();
process.exit(fail ? 1 : 0);
