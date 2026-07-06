// ============================================================================
// e2e: rename a worksheet by ALIAS (no re-key). Right-click (or double-click) a
// sheet tab → a floating rename box → type a name → the tab's title changes and
// the segment records <seg>.alias. Crucially the cell KEYS are untouched — a
// value in A1 survives and no <newName>.* cels are created (re-keying every cell
// on a rename would be expensive + fragile, per the design).
//
//   bun e2e/sheetapp-rename.mjs
// ============================================================================
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8975;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const URLP = `http://localhost:${PORT}/index.html`;

let failed = 0;
const ok = (c, m, g) => { console.log(`${c ? "✓" : "✗"} ${m}${c ? "" : "  got: " + JSON.stringify(g)}`); if (!c) failed++; };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  await page.goto(URLP);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 12000 });
  await page.waitForTimeout(700);
  await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("ensureSegments")(s, ["sheetapp", "sheets", "window", "dom", "segment-store", "user-space-ops"]);
    await F("hydrate")(s, [], []); await F("runCycle")(s);
    await F("origin.newsheet")(s); await F("window.raise")(s, "win.sheet1.state");
    await F("setValue")(s, "sheet1.A1", 99);            // a value to prove it survives
    await F("runCycle")(s); await F("drain")(s, "dom.paint");
  });
  await page.waitForTimeout(500);

  const W = '[data-win="win.sheet1.state"]';
  ok(await page.evaluate((W) => [...document.querySelectorAll(`${W} .pl-wb-tab`)].map((b) => b.textContent), W).then((t) => t.includes("sheet1")), "the sheet tab shows 'sheet1'");

  // ── right-click the tab → the rename box appears ──────────────────────────
  await page.click(`${W} .pl-wb-tab`, { button: "right" }).catch(() => {});
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => !!document.querySelector(".pl-rename-pop input")), "right-click opens the floating rename box");

  // ── type a new name + ✓ ───────────────────────────────────────────────────
  await page.fill(".pl-rename-input", "Budget");
  await page.click(".pl-rename-ok");
  await page.waitForTimeout(500);
  const after = await page.evaluate((W) => ({
    tabs: [...document.querySelectorAll(`${W} .pl-wb-tab`)].map((b) => b.textContent),
    overlayGone: !document.querySelector(".pl-rename-pop input"),
    alias: globalThis.plastron.state.cels.get("sheet1.alias")?.v,
    a1: globalThis.plastron.state.cels.get("sheet1.A1")?.v,
    noRekey: ![...globalThis.plastron.state.cels.keys()].some((k) => k.startsWith("Budget.")),
  }), W);
  ok(after.tabs.includes("Budget"), "the tab is renamed to 'Budget'", after.tabs);
  ok(after.alias === "Budget", "the segment recorded <seg>.alias = 'Budget'", after.alias);
  ok(after.a1 === 99, "the cell value (A1=99) survived — NO re-key", after.a1);
  ok(after.noRekey, "no Budget.* cels were created (formulas untouched)", after.noRekey);
  ok(after.overlayGone, "the rename box closes after applying");

  // ── double-click also opens it (rename again) ─────────────────────────────
  await page.dblclick(`${W} .pl-wb-tab`).catch(() => {});
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => !!document.querySelector(".pl-rename-pop input")), "double-click also opens the rename box");

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ sheet rename (alias, no re-key) all pass");
process.exit(failed ? 1 : 0);
