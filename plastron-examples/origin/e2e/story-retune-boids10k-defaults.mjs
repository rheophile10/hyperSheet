// CAPSTONE STORY e2e + video — "I open 10k Boids, press run, and the fish
// actually swim and school" ([[story-retune-boids10k-defaults]], card
// 6bca2f49). Proves the retune (apps/docs/boids10k.json values-only) on video
// and pins the design's acceptance clauses the regression suite (boids10k.mjs)
// does NOT assert:
//   1. Real motion  — B17 mean speed reads clearly non-trivial (≈1.5, up from
//      the old ≈0.6 sub-pixel jitter).
//   2. Visible schooling — a VISUAL acceptance: carried by the recorded video,
//      not a scalar (design §"What visibly swims and schools means", clause 2).
//   3. Still 10 000 fish / one draw call — count 10000, positions.len 30000,
//      A1 still instances 10000.
//   4. Whole flock framed — camera pulled back to (0,10,40); carried by video.
//   + the retuned values are visible/editable ON the sheet (formula bar / the
//     B-column) and live — bumping B5 (maxSpeed) mid-swim visibly slows the
//     fish (mean speed drops), restoring it speeds them back up.
//
// Run:  cd plastron-examples/origin && bun e2e/story-retune-boids10k-defaults.mjs
// The .webm lands in the dir named by STORY_VIDEO_DIR (default: a temp dir it
// prints at the end) — the reviewer attaches it to the card.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8847);
const origin = "/home/ian/projects/plastron/plastron-examples/origin";
const VIDEO_DIR = process.env.STORY_VIDEO_DIR ?? mkdtempSync(join(tmpdir(), "boids10k-story-"));

const srv = spawn("bun", [`${origin}/serve.ts`], { stdio: "ignore", env: { ...process.env, PORT: String(PORT) } });
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://localhost:${PORT}/index.html`); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  recordVideo: { dir: VIDEO_DIR, size: { width: 1400, height: 900 } },
});
const page = await context.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0, last;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); if (!c) console.log("      last:", JSON.stringify(last)?.slice(0, 240)); };
const celV = (k) => page.evaluate((key) => {
  const v = globalThis.plastron.state.cels.get(key)?.v;
  return typeof v === "object" && v && v.positions ? { n: v.n, len: v.positions.length } : v;
}, k);
const barValue = () => page.evaluate(() => document.querySelector(".pl-wb-left textarea.fx-input")?.value ?? "");

// ── Story step 1: load the origin desktop, see the icons ─────────────────────
await page.goto(`http://localhost:${PORT}/index.html`, { timeout: 60000 });
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });
await page.waitForTimeout(1500);
last = await page.evaluate(() => [...document.querySelectorAll("button.pl-desk-icon")].some((b) => /10k Boids/.test(b.textContent ?? "")));
ok(last === true, "desktop shows the 🐟 10k Boids icon");

// ── Story step 2: click the icon → one workbook opens, the whole tank framed ─
await page.evaluate(() => [...document.querySelectorAll("button.pl-desk-icon")].find((b) => /10k Boids/.test(b.textContent ?? ""))?.click());
await page.waitForTimeout(2500);   // opendoc + settle + lazy three import
last = await celV("win.boids10k.state");
ok(!!last && last.closed !== 1, "the 10k Boids workbook opened");
last = await page.evaluate(() => !!document.querySelector("canvas[data-scene]"));
ok(last === true, "the =scene() fish pane painted a <canvas data-scene>");
// clause 4 — the reframed camera is the value we shipped (whole flock framed; video shows no clipping)
last = await page.evaluate(() => globalThis.plastron.state.cels.get("boids10k.A1")?.f?.match(/camera\([^)]*\)/)?.[0]);
ok(last === "camera(0, 10, 40)", `A1's =view() frames the enlarged tank (${last})`);

// ── Story step 3: press ▶ run — the flock seeds, moves, and (on video) schools
await page.evaluate(() => [...document.querySelectorAll(".pl-wb-vbody button")].find((b) => /run/.test(b.textContent ?? ""))?.click());
await page.waitForTimeout(1200);
// clause 3 — still 10 000 fish, one draw call
last = await celV("boids10k.D1");
ok(!!last && last.n === 10000 && last.len === 30000, `still 10 000 fish (n=${last?.n}, positions.len=${last?.len})`);
last = await celV("boids10k.B12");
ok(last === 10000, `B12 count is still 10000 (${last})`);

// let it swim/school for several seconds — this is what the video carries (clause 2)
const g0 = await celV("boids10k.D2");
await page.waitForTimeout(6000);
const g1 = await celV("boids10k.D2");
ok(typeof g0 === "number" && g1 > g0, `sim advancing while it swims (gen ${g0} → ${g1})`);

// clause 1 — REAL motion: mean speed clearly non-trivial (old sub-pixel jitter ≈0.6)
const runSpeed = await celV("boids10k.B17");
ok(typeof runSpeed === "number" && runSpeed >= 1.3, `B17 mean speed non-trivial while swimming (${runSpeed}, old jitter ≈0.6)`);

// visual confirmation the pane is actually changing (the flock is moving)
const box = await page.evaluate(() => {
  const r = document.querySelector("canvas[data-scene]")?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
});
const s0 = await page.screenshot({ clip: box });
await page.waitForTimeout(600);
const s1 = await page.screenshot({ clip: box });
ok(!s0.equals(s1), "the fish pane pixels change frame to frame (visibly swimming)");

// ── Story step 4 & 5: the retuned values are ON the sheet — click them ───────
await page.click('.pl-wb-left .cell-value[data-key="boids10k.B5"]');
await page.waitForTimeout(350);
last = await barValue();
ok(String(last).trim() === "5" || Number(last) === 5, `clicking B5 shows maxSpeed 5.0 in the formula bar (${JSON.stringify(last)})`);
await page.click('.pl-wb-left .cell-value[data-key="boids10k.B7"]');
await page.waitForTimeout(300);
last = await barValue();
ok(Number(last) === 0.05, `clicking B7 shows dt 0.05 (${JSON.stringify(last)})`);
for (const [k, want, knob] of [["boids10k.B8", 28, "w"], ["boids10k.B9", 16, "h"], ["boids10k.B10", 28, "d"]]) {
  await page.click(`.pl-wb-left .cell-value[data-key="${k}"]`);
  await page.waitForTimeout(250);
  last = await barValue();
  ok(Number(last) === want, `clicking ${k} shows tank ${knob}=${want} (${JSON.stringify(last)})`);
}
await page.click('.pl-wb-left .cell-value[data-key="boids10k.B3"]');
await page.waitForTimeout(250);
last = await barValue();
ok(Number(last) === 0.08, `clicking B3 shows the alignment nudge 0.08 (${JSON.stringify(last)})`);

// ── Story step 5 (live): bump B5 down mid-swim → fish visibly slow ───────────
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "setValue")(state, "boids10k.B5", 1.0);
});
await page.waitForTimeout(2500);   // let the clamped speed settle + show on video
const slowSpeed = await celV("boids10k.B17");
ok(typeof slowSpeed === "number" && slowSpeed < runSpeed - 0.3, `B5→1.0 mid-swim visibly slows the flock (mean speed ${runSpeed} → ${slowSpeed})`);

// restore → fish speed back up (live, mechanism untouched)
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "setValue")(state, "boids10k.B5", 5.0);
});
await page.waitForTimeout(2500);
const fastAgain = await celV("boids10k.B17");
ok(typeof fastAgain === "number" && fastAgain >= 1.3, `restoring B5→5.0 speeds the flock back up (mean speed ${slowSpeed} → ${fastAgain})`);

// ── Story step 6: ⏸ stop → the flock freezes, the pump halts cleanly ─────────
await page.evaluate(() => [...document.querySelectorAll(".pl-wb-vbody button")].find((b) => /stop/.test(b.textContent ?? ""))?.click());
await page.waitForTimeout(600);
const gStop = await celV("boids10k.D2");
await page.waitForTimeout(700);
ok((await celV("boids10k.D2")) === gStop, "⏸ stop freezes the flock (generation stable — pump halted)");

ok(errs.length === 0, `no page errors (${errs.length ? errs[0]?.slice(0, 200) : "clean"})`);

console.log(`\n${pass} pass, ${fail} fail`);
await context.close();   // flushes the .webm
await browser.close();
srv.kill();
const videoPath = await page.video()?.path();
console.log(`\nVIDEO: ${videoPath}`);
process.exit(fail ? 1 : 0);
