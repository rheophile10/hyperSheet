// render — actually RUN each model's formula in a real browser and capture what
// it made: a screenshot + DOM facts (buttons, canvases, cells, console errors).
// Renders every viable entry in last-run.json (or one formula passed as an arg).
//   bun render.ts                         (render everything in last-run.json)
//   bun render.ts '=cels(3,3)'            (render one formula)
// Screenshots land in llm-eval/shots/. Uses the bundled dist + Playwright.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const shotsDir = join(here, "shots");
if (!existsSync(join(distDir, "index.html"))) { console.error("build the bundle first: (cd .. && bun bundle.ts)"); process.exit(1); }
mkdirSync(shotsDir, { recursive: true });

// what to render: one arg formula, or every viable entry in last-run.json
const arg = process.argv.slice(2).join(" ").trim();
type Item = { key: string; label: string; formula: string };
let items: Item[] = [];
if (arg) items = [{ key: "adhoc", label: "adhoc", formula: arg }];
else {
  const lr = JSON.parse(readFileSync(join(here, "last-run.json"), "utf8")) as Record<string, { ok: boolean; formula: string | null }>;
  items = Object.entries(lr).filter(([, v]) => v.ok && v.formula).map(([k, v]) => ({ key: k, label: k.replace(/[:]/g, "-"), formula: v.formula! }));
}
if (!items.length) { console.error("nothing to render (no viable formulas in last-run.json)"); process.exit(1); }

const srv = spawn("python3", ["-m", "http.server", "8780", "--directory", distDir], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

const manifest: Array<{ key: string; label: string; formula: string; png: string; facts: Record<string, unknown>; errors: string[] }> = [];
for (const { key, label, formula } of items) {
  const page = await (await b.newContext({ viewport: { width: 1100, height: 720 } })).newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  const shot = join(shotsDir, `${label}.png`);
  try {
    // Boot via #raw= so the formula IS 元 in a locked kernel — no desktop demos,
    // a clean isolated view of exactly what the model made.
    const hash = "#raw=" + encodeURIComponent(formula);
    await page.goto("http://localhost:8780/index.html" + hash, { timeout: 15000 });
    await page.waitForFunction(() => !!(globalThis as { plastron?: unknown }).plastron, { timeout: 8000 });
    await page.waitForTimeout(700);
    const facts = await page.evaluate(() => ({
      buttons: document.querySelectorAll("button").length,
      canvases: document.querySelectorAll("canvas").length,
      inputs: document.querySelectorAll("input").length,
      cells: document.querySelectorAll('[data-win] td, .pl-cell, [class*="cell"]').length,
      text: document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 160),
    }));
    await page.screenshot({ path: shot, fullPage: false });
    console.log(`${label.padEnd(28)} buttons=${facts.buttons} canvas=${facts.canvases} cells=${facts.cells} errors=${errs.length}`);
    console.log(`  text: ${facts.text}`);
    console.log(`  → ${shot}`);
    if (errs.length) console.log(`  ! ${errs.slice(0, 2).join(" | ")}`);
    manifest.push({ key, label, formula, png: shot, facts, errors: errs });
  } catch (e) {
    // one bad render must not abort the batch — record it and move on.
    const msg = String((e as { message?: unknown })?.message ?? e).split("\n")[0];
    console.log(`${label.padEnd(28)} RENDER FAILED — ${msg}`);
    try { await page.screenshot({ path: shot, fullPage: false }); } catch { /* page may be dead */ }
    manifest.push({ key, label, formula, png: shot, facts: { buttons: 0, canvases: 0, inputs: 0, cells: 0, text: `RENDER FAILED: ${msg}` }, errors: [...errs, msg] });
  }
  await page.close();
}
await b.close(); srv.kill();
writeFileSync(join(shotsDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\nscreenshots + manifest in ${shotsDir}`);
