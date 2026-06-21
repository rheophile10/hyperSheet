// e2e: clicking 🐢 DOOM in the navpanel runs Doom in a wasm-window, in real
// headless chromium. Proves the whole launch path:
//   navOpen("=doom()") → the window's <canvas id=wasm-doom> mounts (the frame cel
//   enters the view via cellKeys' wasm.*.frame whitelist) → armboot RAF-defers
//   doom.boot → boot recovers the kernel state + fetches doom.wasm + the WAD →
//   the kind:"wasm" engine instantiates → harness.start()'s RAF loop renders to
//   the canvas (non-black pixels) → arrow keys change the frame.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { cpSync } from "node:fs";

const PORT = 8793;
const dist = new URL("../dist", import.meta.url).pathname;
const doomDir = new URL("../../doom", import.meta.url).pathname;
// serve the assets doom.boot fetches from "/"
cpSync(`${doomDir}/doom.wasm`, `${dist}/doom.wasm`);
cpSync(`${doomDir}/freedoom1.wad`, `${dist}/freedoom1.wad`);

const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));

let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  // spy on Web Audio BEFORE page scripts run — count buffer sources that actually
  // start(), so we can assert Doom's DMX SFX reached the `sound` segment → audio.
  await page.addInitScript(() => {
    globalThis.__snd = { started: 0 };
    const OAC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (OAC) globalThis.AudioContext = class extends OAC {
      createBufferSource() { const s = super.createBufferSource(); const st = s.start.bind(s); s.start = (...x) => { globalThis.__snd.started++; return st(...x); }; return s; }
    };
  });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
  await page.waitForTimeout(1200);

  // the REAL user path: click the 🐢 DOOM launcher in the navpanel.
  await (await page.$('button.pl-nav-icon:has-text("DOOM")')).click();
  await page.waitForTimeout(800);

  ok(await page.evaluate(() => !!document.getElementById("wasm-doom")), "clicking 🐢 DOOM mounted the <canvas id=wasm-doom>");

  // wait for the engine to report running (doom.boot streams status to wasm.doom.out)
  await page.waitForFunction(() => {
    const v = globalThis.plastron.state.cels.get("wasm.doom.out")?.v;
    return typeof v === "string" && (v === "running" || /#ERROR/.test(v));
  }, { timeout: 45000 });
  const status = await page.evaluate(() => globalThis.plastron.state.cels.get("wasm.doom.out")?.v);
  ok(status === "running", `engine status: ${status}`);

  // let it render a few frames, then sample the canvas for non-black pixels
  await page.waitForTimeout(1500);
  const lit = await page.evaluate(() => {
    const c = document.getElementById("wasm-doom");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let nonBlack = 0; for (let i = 0; i < d.length; i += 4) if (d[i] | d[i + 1] | d[i + 2]) nonBlack++;
    return nonBlack;
  });
  ok(lit > 1000, `Doom is rendering: ${lit} non-black pixels`);
  await page.screenshot({ path: `${import.meta.dir}/doom.png` });

  // the RAF tick loop is LIVE — DOOM holds a STATIC title screen for ~3.5s, then
  // the attract-mode demo animates. Poll a centre-playfield hash until it advances
  // (proves the engine is ticking, not stuck on frame 1). Sampling the centre, not a
  // static HUD corner.
  const centerHash = () => page.evaluate(() => {
    const c = document.getElementById("wasm-doom");
    const d = c.getContext("2d").getImageData(c.width / 2 - 64, c.height / 2 - 64, 128, 128).data;
    let h = 0; for (let i = 0; i < d.length; i += 37) h = (h * 31 + d[i]) >>> 0; return h;
  });
  await page.evaluate(() => document.getElementById("wasm-doom").focus());
  const base = await centerHash();
  let advanced = false;
  for (let i = 0; i < 16 && !advanced; i++) { await page.waitForTimeout(700); advanced = (await centerHash()) !== base; }
  ok(advanced, "the RAF tick loop advances the frame over time (engine is live, not stuck on frame 1)");

  // SOUND — the attract demo fires weapons → DMX SFX → sound.play-pcm → Web Audio.
  // The launch click grants sticky activation, so the AudioContext starts running.
  let sfx = 0;
  for (let i = 0; i < 12 && sfx === 0; i++) { await page.waitForTimeout(1000); sfx = await page.evaluate(() => globalThis.__snd?.started ?? 0); }
  ok(sfx > 0, `Doom SFX plays through Web Audio (${sfx} PCM sources started)`);
  ok((await page.evaluate(() => globalThis.plastron.state.cels.get("sound.context-state")?.v)) === "running", "the AudioContext is running (not autoplay-suspended)");

  // QUIT TO DOS — Esc opens the menu; ArrowUp from "New Game" WRAPS to the last item
  // = "Quit Game" (count-agnostic); Enter → the y/n prompt; "y" → proc_exit → onExit
  // closes the window (wasm.doom.state.closed=1) + resets so a re-launch reboots.
  await page.evaluate(() => document.getElementById("wasm-doom").focus());
  await page.keyboard.press("Escape"); await page.waitForTimeout(500);
  await page.keyboard.press("ArrowUp"); await page.waitForTimeout(300);
  await page.keyboard.press("Enter"); await page.waitForTimeout(600);
  await page.keyboard.press("y");
  await page.waitForFunction(() => globalThis.plastron.state.cels.get("wasm.doom.state")?.v?.closed === 1, { timeout: 8000 }).catch(() => {});
  ok((await page.evaluate(() => globalThis.plastron.state.cels.get("wasm.doom.state")?.v?.closed)) === 1, "quit-to-DOS (Esc → Quit Game → y) closes the DOOM window");
  // the closed cel flips before onExit's async drain repaints the stub — poll the DOM.
  const winGone = () => page.evaluate(() => { const w = [...document.querySelectorAll(".pl-window")].find((x) => x.getAttribute("data-win") === "wasm.doom.state"); return !w || w.offsetParent === null; });
  await page.waitForFunction(() => { const w = [...document.querySelectorAll(".pl-window")].find((x) => x.getAttribute("data-win") === "wasm.doom.state"); return !w || w.offsetParent === null; }, { timeout: 4000 }).catch(() => {});
  ok(await winGone(), "the DOOM window is gone from the desktop after quit");

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ all doom e2e checks passed");
process.exit(failed ? 1 : 0);
