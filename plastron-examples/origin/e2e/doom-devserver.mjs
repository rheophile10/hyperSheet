// e2e: clicking 🐢 DOOM works against the DEV SERVER (serve.ts), not just the
// production dist bundle. This is the gap doom.mjs missed: doom.mjs serves the
// already-built dist/ via python http.server, so it stayed green even when the
// dev server returned the JS bundle (text/javascript) for /doom.wasm instead of
// the real WASM → WebAssembly.instantiate failed → black screen. This test
// boots serve.ts itself and clicks the icon, so a dev-path asset regression is
// caught. (Lean version of doom.mjs: launch → running → non-black pixels.)
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 8794;
const origin = new URL("..", import.meta.url).pathname;

// belt-and-suspenders: assert the dev server hands back real WASM (not the JS
// bundle) before we even open a browser — pinpoints the regression directly.
const srv = spawn("bun", ["serve.ts"], { cwd: origin, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));

let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  // 1) the dev server must serve real WASM at the site root (the regression).
  const wasmRes = await fetch(`http://localhost:${PORT}/doom.wasm`);
  const ct = wasmRes.headers.get("content-type") || "";
  const magic = new Uint8Array(await wasmRes.arrayBuffer()).slice(0, 4);
  ok(/wasm/.test(ct), `dev server serves /doom.wasm as wasm, not the JS bundle (content-type: ${ct})`);
  ok(magic[0] === 0x00 && magic[1] === 0x61 && magic[2] === 0x73 && magic[3] === 0x6d, "/doom.wasm starts with the \\0asm magic (real module, not text/javascript)");

  // 2) the REAL user path: click the 🐢 DOOM launcher and watch it boot+render.
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
  await page.waitForTimeout(1200);

  await (await page.$('button.pl-desk-icon:has-text("DOOM")')).click();
  await page.waitForTimeout(800);
  ok(await page.evaluate(() => !!document.getElementById("wasm-doom")), "clicking 🐢 DOOM mounted the <canvas id=wasm-doom>");

  await page.waitForFunction(() => {
    const v = globalThis.plastron.state.cels.get("wasm.doom.out")?.v;
    return typeof v === "string" && (v === "running" || /#ERROR/.test(v));
  }, { timeout: 45000 });
  const status = await page.evaluate(() => globalThis.plastron.state.cels.get("wasm.doom.out")?.v);
  ok(status === "running", `engine status: ${status}`);

  await page.waitForTimeout(1500);
  const lit = await page.evaluate(() => {
    const c = document.getElementById("wasm-doom");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let nonBlack = 0; for (let i = 0; i < d.length; i += 4) if (d[i] | d[i + 1] | d[i + 2]) nonBlack++;
    return nonBlack;
  });
  ok(lit > 1000, `Doom is rendering on the dev server: ${lit} non-black pixels`);
  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ all doom dev-server e2e checks passed");
process.exit(failed ? 1 : 0);
