// ============================================================================
// e2e: Excel-style KEYBOARD NAVIGATION of a worksheet grid, in real headless
// chromium against the bundled origin. Proves the three behaviours:
//   1. select a cell + start typing → the char shows IN THE CELL (inline editor,
//      focused) and is MIRRORED in the formula bar (both bind 元.draft);
//   2. arrow keys move the selection left / right / up / down between cells;
//   3. Enter commits the formula (it fires) AND the active cell moves DOWN a row.
//
//   bun e2e/sheetapp-keynav.mjs
// ============================================================================
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8979;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const URLP = `http://localhost:${PORT}/index.html`;

let failed = 0;
const ok = (c, m, g) => { console.log(`${c ? "✓" : "✗"} ${m}${c ? "" : "  got: " + JSON.stringify(g)}`); if (!c) failed++; };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const sel = async (page) => page.evaluate(() => globalThis.plastron.state.cels.get("元.selected")?.v);

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  await page.goto(URLP);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 12000 });
  await page.waitForTimeout(700);

  // a fresh blank worksheet (sheet1: A1..G12 of empty ValueCels), raised as a window
  await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("ensureSegments")(s, ["sheetapp", "sheets", "window", "dom", "segment-store", "user-space-ops"]);
    await F("hydrate")(s, [], []); await F("runCycle")(s);
    await F("origin.newsheet")(s); await F("window.raise")(s, "win.sheet1.state");
    await F("view.refresh")(s); await F("runCycle")(s); await F("drain")(s, "dom.paint");
  });
  const W = '[data-win="win.sheet1.state"]';
  await page.waitForSelector(`${W} .cell-value[data-key="sheet1.A1"]`, { timeout: 8000 });
  await page.waitForTimeout(300);

  // ── click A1 to select it (single click selects, does NOT edit) ───────────
  await page.click(`${W} .cell-value[data-key="sheet1.A1"]`);
  await page.waitForTimeout(250);
  ok(await sel(page) === "sheet1.A1", "clicking A1 selects it (元.selected = sheet1.A1)", await sel(page));
  ok(await page.evaluate((W) => !document.querySelector(`${W} .cell-edit`), W), "A1 is selected but NOT yet editing (no inline editor)");

  // ── 1. type a char → inline editor opens IN THE CELL with the char + cursor ─
  await page.keyboard.press("=");
  await page.waitForSelector(`${W} .cell-edit[data-key="sheet1.A1"]`, { timeout: 4000 });
  await page.waitForTimeout(200);
  ok(await page.evaluate((W) => document.querySelector(`${W} .cell-edit[data-key="sheet1.A1"]`)?.value === "=", W),
    "typing '=' on the selected cell opens the inline editor showing '='");
  ok(await page.evaluate((W) => document.activeElement === document.querySelector(`${W} .cell-edit[data-key="sheet1.A1"]`), W),
    "the inline cell editor is FOCUSED (the cursor is in the cell)");
  // starting to type MIRRORS the cell into the formula bar (both show '='). The bar
  // reflects 元.draft at the edit gesture; subsequent keystrokes stay in the focused
  // cell editor (the {set} binding writes the draft without churning the grid/bar)
  // and re-sync to the bar on commit / re-select — the documented no-churn design.
  ok(await page.evaluate(() => globalThis.plastron.state.cels.get("元.draft")?.v === "="),
    "the typed char is mirrored into the formula-bar draft (元.draft = '=')");
  ok(await page.evaluate((W) => document.querySelector(`${W} .fx-input`)?.value === "=", W),
    "the formula BAR mirrors the cell when typing starts (fx-input shows '=')");

  // continue the formula in the focused cell editor → the full formula shows in-cell
  await page.keyboard.type("4+5");
  await page.waitForTimeout(200);
  ok(await page.evaluate((W) => document.querySelector(`${W} .cell-edit[data-key="sheet1.A1"]`)?.value === "=4+5", W),
    "the rest of the formula types into the cell (=4+5)");

  // ── 3. Enter fires the formula AND moves the active cell DOWN a row ─────────
  await page.keyboard.press("Enter");
  await page.waitForTimeout(350);
  ok(await page.evaluate(() => Number(globalThis.plastron.state.cels.get("sheet1.A1")?.v) === 9),
    "Enter committed + FIRED the formula (A1 = 4+5 = 9)", await page.evaluate(() => globalThis.plastron.state.cels.get("sheet1.A1")?.v));
  ok(await sel(page) === "sheet1.A2", "after Enter the active cell moved DOWN a row (元.selected = sheet1.A2)", await sel(page));
  ok(await page.evaluate((W) => !document.querySelector(`${W} .cell-edit`), W), "editing ended after Enter (no inline editor)");

  // ── 2. arrow keys move the selection between cells ─────────────────────────
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  ok(await sel(page) === "sheet1.B2", "ArrowRight moves selection right (A2 → B2)", await sel(page));
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(200);
  ok(await sel(page) === "sheet1.B3", "ArrowDown moves selection down (B2 → B3)", await sel(page));
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(200);
  ok(await sel(page) === "sheet1.A3", "ArrowLeft moves selection left (B3 → A3)", await sel(page));
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(200);
  ok(await sel(page) === "sheet1.A2", "ArrowUp moves selection up (A3 → A2)", await sel(page));

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ keyboard navigation (type-to-edit, arrows, Enter-down) all pass");
process.exit(failed ? 1 : 0);
