// e2e capstone story — "I want to scroll in and get a closer look at the fish"
// (card 74f52852; story-scene-wheel-zoom). Films the mouse-wheel camera dolly
// step-for-step from the story, on a REAL (SwiftShader) WebGL context:
//   1. open the 🐟 10k Boids desktop icon → the =view() pane grows a 3-D
//      <canvas data-scene> (camera(0,10,40), the authored framing);
//   2. BEFORE run (idle scene): scroll UP (wheel-forward) over the canvas → the
//      pixels change (the boxes/fish grow, filling more of the frame) and the
//      PAGE never scrolls (the wheel is consumed — event.defaultPrevented);
//   3. keep scrolling IN hard → the framing SATURATES at the minimum distance
//      (two paused frames become identical — it never punches through the scene);
//   4. scroll OUT hard the other way → it saturates at the maximum distance
//      (never recedes to infinity), and the min/max framings differ (it moved);
//   5. ▶ run → the flock swims; scroll IN mid-swim → the wheel is still consumed
//      and the sim keeps advancing (generation crosses) with no stutter/crash —
//      zoom and the live pump coexist.
// Nothing about the boids10k document changed — the same formula gets zoom for
// free, proving it is a camera-layer feature that applies to every scene().
// Run:  cd plastron-examples/origin && bun e2e/story-scene-wheel-zoom.mjs
// (Dev-server pattern of e2e/boids10k.mjs — serves the CURRENT sources, not dist.)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8896);
const originDir = new URL("..", import.meta.url).pathname;
const videoDir = join(originDir, "e2e", "videos", "story-scene-wheel-zoom");
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
  viewport: { width: 1400, height: 900 },
  recordVideo: { dir: videoDir, size: { width: 1400, height: 900 } },
});
const page = await context.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0, last;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); if (!c) console.log("      last:", JSON.stringify(last)?.slice(0, 220)); };
const cel = (k) => page.evaluate((key) => globalThis.plastron.state.cels.get(key)?.v, k);
const sceneBox = () => page.evaluate(() => {
  const r = document.querySelector("canvas[data-scene]")?.getBoundingClientRect();
  return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
});
// scroll the wheel over the scene canvas `notches` times by dispatching a real
// cancelable WheelEvent on the <canvas data-scene> (coordinate-based mouse.wheel
// is unreliable against a WebGL pane inside a window). Reads defaultPrevented on
// each dispatched event — direct proof the view consumed the wheel (page won't
// scroll). A trusted user wheel hits the same non-passive listener identically.
const wheelOverScene = (deltaY, notches = 1) => page.evaluate(async ({ dy, n }) => {
  const c = document.querySelector("canvas[data-scene]");
  if (!c) return { prevented: false, hits: 0 };
  const flags = [];
  for (let i = 0; i < n; i++) {
    const ev = new WheelEvent("wheel", { deltaY: dy, bubbles: true, cancelable: true });
    c.dispatchEvent(ev);
    flags.push(ev.defaultPrevented);
    await new Promise((r) => setTimeout(r, 20));
  }
  return { prevented: flags.length > 0 && flags.every(Boolean), hits: flags.length };
}, { dy: deltaY, n: notches });

await page.goto(`http://localhost:${PORT}/index.html`, { timeout: 60000 });
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });
await page.waitForTimeout(1200);

// 1) open the 🐟 10k Boids document from its desktop icon → the scene pane lands
last = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button.pl-desk-icon")].find((b) => /10k Boids/.test(b.textContent ?? ""));
  if (!btn) return false; btn.click(); return true;
});
ok(last === true, "clicked the 🐟 10k Boids desktop icon");
await page.waitForTimeout(2200);   // opendoc + settle + lazy three import
ok(await page.evaluate(() => !!document.querySelector("canvas[data-scene]")), "the =scene() spec painted a <canvas data-scene> in the fish pane");
ok(!!(await sceneBox())?.width, "the scene canvas has layout");

// 2) IDLE zoom (before ▶ run): the still scene consumes the wheel — the page
//    never scrolls. (The doc ships no floats, so the pre-seed scene has no fish
//    to *show* a dolly; the visible dolly is proven on the seeded still scene at
//    step 5, and the camera-distance mechanics at Tier B / drain test.)
const r2 = await wheelOverScene(-400, 3);   // wheel-forward = zoom IN
ok(r2.prevented, "before run, the still scene consumes the wheel — the page never scrolls (event.defaultPrevented)");

// 3) ▶ run — the pump seeds 10k fish and the flock swims (live pixels change)
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /▶\s*run/.test(b.textContent ?? ""));
  btn?.click();
});
await page.waitForTimeout(1100);
last = await page.evaluate(() => { const v = globalThis.plastron.state.cels.get("boids10k.D1")?.v; return v?.positions?.length ?? null; });
ok(last === 30000, `▶ run seeded 10k fish (positions len ${last})`);
const swim0 = await page.screenshot({ clip: await sceneBox() });
await page.waitForTimeout(500);
const swim1 = await page.screenshot({ clip: await sceneBox() });
ok(!swim0.equals(swim1), "the flock is swimming (pixels change across generations)");

// 4) ⏸ stop — the pump halts but the window + seeded flock stay: a still,
//    POPULATED scene we can dolly and screenshot reliably.
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /⏸\s*stop/.test(b.textContent ?? ""));
  btn?.click();
});
await page.waitForTimeout(500);
const gStop = await cel("boids10k.D2");
await page.waitForTimeout(500);
ok((await cel("boids10k.D2")) === gStop, "⏸ stop halts the pump (generation stable) — a still, seeded scene");

// 5) VISIBLE dolly on the still seeded scene: wheel-in grows the fish; clamps hold
const shotBase = await page.screenshot({ clip: await sceneBox() });
await wheelOverScene(-400, 4);              // zoom IN
await page.waitForTimeout(150);
const shotIn = await page.screenshot({ clip: await sceneBox() });
ok(!shotIn.equals(shotBase), "wheel-in dollies the camera in — the fish grow / fill more of the frame (zoom on a still scene)");

// clamp IN — sustained wheel-in saturates at minDistance (two frames identical)
await wheelOverScene(-400, 24);
const shotMinA = await page.screenshot({ clip: await sceneBox() });
await wheelOverScene(-400, 24);
const shotMinB = await page.screenshot({ clip: await sceneBox() });
ok(shotMinA.equals(shotMinB), "sustained wheel-in saturates at minDistance — it never punches through the scene");

// clamp OUT — sustained wheel-out saturates at maxDistance; min≠max (it moved)
await wheelOverScene(400, 44);
const shotMaxA = await page.screenshot({ clip: await sceneBox() });
await wheelOverScene(400, 24);
const shotMaxB = await page.screenshot({ clip: await sceneBox() });
ok(shotMaxB.equals(shotMaxA), "sustained wheel-out saturates at maxDistance — it never recedes to infinity");
ok(!shotMaxA.equals(shotMinA), "the min and max framings differ — the wheel dollied the camera between the clamps");

// 6) LIVE zoom — ▶ run again, scroll IN mid-swim: wheel consumed, sim advances
await wheelOverScene(-400, 8);              // back to a middle framing
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /▶\s*run/.test(b.textContent ?? ""));
  btn?.click();
});
await page.waitForTimeout(900);
const gBefore = await cel("boids10k.D2");
const r6 = await wheelOverScene(-400, 3);   // zoom IN mid-swim
ok(r6.prevented, "the wheel is still consumed by the view while the flock swims");
await page.waitForTimeout(700);
const gAfter = await cel("boids10k.D2");
ok(typeof gBefore === "number" && gAfter > gBefore, `the sim kept advancing through the mid-swim zoom (${gBefore} → ${gAfter})`);

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
