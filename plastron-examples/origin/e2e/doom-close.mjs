// e2e regression: closing the DOOM window with ✕ must STOP the engine + audio.
// Bug: winx.close only set wasm.doom.state.closed=1 (hiding the window); the harness
// RAF loop kept ticking the attract demo into the detached canvas and firing SFX, so
// DOOM's sound played on even after close (and over a newly-opened app). Fix: the
// harness stops when its canvas leaves the DOM (onDetach) → free + sound.stop-all.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { cpSync } from "node:fs";
const PORT = 8798, dist = new URL("../dist", import.meta.url).pathname, doomDir = new URL("../../doom", import.meta.url).pathname;
cpSync(`${doomDir}/doom.wasm`, `${dist}/doom.wasm`);
cpSync(`${doomDir}/freedoom1.wad`, `${dist}/freedoom1.wad`);
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));
let pass = 0, fail = 0; const ok = (c, w, g) => { if (c) { pass++; console.log("  ✔", w); } else { fail++; console.log("  ✘", w, "got:", JSON.stringify(g)); } };

const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  // count Web Audio sources that actually start() — DOOM's SFX
  await p.addInitScript(() => {
    globalThis.__snd = { started: 0 };
    const O = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (O) globalThis.AudioContext = class extends O { createBufferSource() { const s = super.createBufferSource(); const st = s.start.bind(s); s.start = (...x) => { globalThis.__snd.started++; return st(...x); }; return s; } };
  });
  await p.goto(`http://localhost:${PORT}/index.html`);
  await p.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
  await p.waitForTimeout(1200);

  await (await p.$('button.pl-nav-icon:has-text("DOOM")')).click();
  await p.waitForFunction(() => globalThis.plastron.state.cels.get("wasm.doom.out")?.v === "running", { timeout: 45000 });
  // wait for the attract demo to fire SFX
  let started = 0;
  for (let i = 0; i < 14 && started === 0; i++) { await p.waitForTimeout(1000); started = await p.evaluate(() => globalThis.__snd.started); }
  ok(started > 0, `DOOM is firing SFX while open (${started})`, started);

  // CLOSE via the ✕ button
  await p.click('.pl-window[data-win="wasm.doom.state"] .pl-close-btn');
  await p.waitForTimeout(800);
  ok((await p.evaluate(() => globalThis.plastron.state.cels.get("wasm.doom.out")?.v)) === "stopped", "✕ close stopped the engine (wasm.doom.out = stopped)");
  const atClose = await p.evaluate(() => globalThis.__snd.started);

  // open a DIFFERENT app and wait — NO new DOOM SFX may fire after close
  await (await p.$('button.pl-nav-icon:has-text("Sheet")')).click();
  await p.waitForTimeout(3000);
  const later = await p.evaluate(() => globalThis.__snd.started);
  ok(later === atClose, `no new DOOM SFX after close (${later - atClose} new)`, { atClose, later });

  // re-clicking DOOM reboots a fresh engine (onDetach freed _harness; armboot re-arms)
  await (await p.$('button.pl-nav-icon:has-text("DOOM")')).click();
  ok(await p.waitForFunction(() => globalThis.plastron.state.cels.get("wasm.doom.out")?.v === "running", { timeout: 30000 }).then(() => true).catch(() => false), "re-opening DOOM after close reboots the engine");
} finally {
  await b.close(); srv.kill();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
