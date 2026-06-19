// e2e: =doom() runs Doom in a wasm-window, in real headless chromium.
// Proves: the window mounts → doom.boot fetches doom.wasm + the WAD → the
// kind:"wasm" engine instantiates → the RAF tick loop renders to the canvas
// (non-black pixels) → arrow keys change the frame.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { cpSync } from "node:fs";

const PORT = 8793;
const dist = "/home/ian/projects/plastron/plastron-examples/origin/dist";
const doomDir = "/home/ian/projects/plastron/plastron-examples/doom";
// serve the assets doom.boot fetches from "/"
cpSync(`${doomDir}/doom.wasm`, `${dist}/doom.wasm`);
cpSync(`${doomDir}/freedoom1.wad`, `${dist}/freedoom1.wad`);

const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));

let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
  await page.waitForTimeout(400);

  // materialise =doom() (the genesis) + settle so the canvas mounts; armboot then
  // RAF-defers doom.boot (fetch assets → hydrate kind:wasm → harness.start()).
  await page.evaluate(async () => {
    const { state, resolveFn } = globalThis.plastron;
    const g = resolveFn(state, "doom")();
    const batch = {}; for (const [k, spec] of Object.entries(g.cels)) batch[k] = spec;
    await resolveFn(state, "setCelBatch")(state, batch);
    for (let i = 0; i < 10; i++) {
      await resolveFn(state, "runCycle")(state);
      if (state.cels.get("genesis.commit")) await resolveFn(state, "drain")(state, "genesis.commit");
      await resolveFn(state, "drain")(state, "dom.paint");
    }
  });

  ok(await page.evaluate(() => !!document.getElementById("wasm-doom")), "the <canvas id=wasm-doom> mounted");

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

  // focus the canvas + drive the player; the frame should change
  await page.evaluate(() => document.getElementById("wasm-doom").focus());
  const before = await page.evaluate(() => { const c = document.getElementById("wasm-doom"); return [...c.getContext("2d").getImageData(0, 0, 64, 64).data].join(","); });
  await page.keyboard.down("ArrowUp"); await page.waitForTimeout(800); await page.keyboard.up("ArrowUp");
  const after = await page.evaluate(() => { const c = document.getElementById("wasm-doom"); return [...c.getContext("2d").getImageData(0, 0, 64, 64).data].join(","); });
  ok(before !== after, "arrow key changed the frame (input drives the player)");

  ok(errs.length === 0, `no console errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ all doom e2e checks passed");
process.exit(failed ? 1 : 0);
