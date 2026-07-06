// e2e: when the DOOM assets can't be found, the window surfaces a readable
// "DOOM could not load" error card — NOT a silent black canvas. We point the
// asset base at a path that 404s (via the __doomAssets override the harness
// reads), click the icon, and assert the engine reports #ERROR and the window
// shows the error overlay with a "not found" message.
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 8795;
const dist = new URL("../dist", import.meta.url).pathname;

const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));

let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // override the asset base BEFORE any page script evaluates the doom module's
  // `const ASSETS = globalThis.__doomAssets ?? "/"`, so every fetch 404s.
  await page.addInitScript(() => { globalThis.__doomAssets = "/this-path-does-not-exist/"; });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
  await page.waitForTimeout(1200);

  await (await page.$('button.pl-desk-icon:has-text("DOOM")')).click();
  await page.waitForTimeout(500);

  // while it's trying, the loading overlay should be up (not a bare black canvas)
  ok(await page.evaluate(() => !!document.querySelector(".wasm-overlay")), "a status overlay is shown while loading (not a silent black canvas)");

  // the fetch 404s → boot catches it → wasm.doom.out becomes #ERROR(...)
  await page.waitForFunction(() => /^#ERROR/.test(String(globalThis.plastron.state.cels.get("wasm.doom.out")?.v ?? "")), { timeout: 20000 });
  const out = await page.evaluate(() => globalThis.plastron.state.cels.get("wasm.doom.out")?.v);
  ok(/^#ERROR/.test(String(out)), `engine reports the failure to the graph: ${out}`);

  // and the window renders the human-readable error card
  await page.waitForFunction(() => !!document.querySelector(".wasm-overlay-error"), { timeout: 5000 }).catch(() => {});
  const errText = await page.evaluate(() => document.querySelector(".wasm-overlay-error")?.textContent ?? "");
  ok(/DOOM could not load/.test(errText), `error card says it could not load (\"${errText.slice(0, 80)}…\")`);
  ok(/not found/i.test(errText), "error card explains the files were not found");
  await page.screenshot({ path: `${import.meta.dir}/doom-error.png` });
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ doom error-surfacing e2e passed");
process.exit(failed ? 1 : 0);
