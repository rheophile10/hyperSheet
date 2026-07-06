// ============================================================================
// e2e: an INVALID formula must surface an ERROR, not silently render blank.
//   parse error   (=1+)        — caught at setCel, shown under the editor
//   runtime error (=nope(5))   — formula evaluates and throws; the error VALUE
//                                used to just render blank — now surfaced too.
// Both should set 元.error AND keep the cell in edit mode so the message shows.
//
//   bun e2e/sheetapp-formula-error.mjs
// ============================================================================
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8973;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const URLP = `http://localhost:${PORT}/index.html`;

let failed = 0;
const ok = (c, m, g) => { console.log(`${c ? "✓" : "✗"} ${m}${c ? "" : "  got: " + JSON.stringify(g)}`); if (!c) failed++; };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

const fire = (page, key, formula) => page.evaluate(async ([key, formula]) => {
  const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
  await F("setValue")(s, "元.draft", formula); await F("origin.fire")(s, key);
  await F("drain")(s, "dom.paint"); await new Promise((r) => setTimeout(r, 250));
}, [key, formula]);
const errCel = (page) => page.evaluate(() => globalThis.plastron.state.cels.get("元.error")?.v ?? null);
const errInDom = (page) => page.evaluate(() => { const t = document.body.innerText || ""; return /#ERROR|infix:|error/i.test(t) && /win\.sheet1\.state/.test(document.querySelector('[data-win="win.sheet1.state"]') ? "win.sheet1.state" : ""); });

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
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
    await F("runCycle")(s); await F("drain")(s, "dom.paint");
  });
  await page.waitForTimeout(300);

  // ── a valid formula commits clean (no error) ──────────────────────────────
  await fire(page, "sheet1.A1", "=2+2");
  ok((await page.evaluate(() => globalThis.plastron.state.cels.get("sheet1.A1")?.v)) === 4 && !(await errCel(page)), "valid =2+2 commits to 4 with no error");

  // ── parse error surfaces ──────────────────────────────────────────────────
  await fire(page, "sheet1.A2", "=1+");
  const pe = await errCel(page);
  ok(typeof pe === "string" && /infix|error|unexpected/i.test(pe), "parse error =1+ surfaces a message", pe);
  ok(await page.evaluate(() => globalThis.plastron.state.cels.get("元.editing")?.v === "sheet1.A2"), "the cell stays in edit mode so the error shows");
  ok(await page.evaluate(() => /infix|error|unexpected/i.test(document.body.innerText || "")), "the error text is visible in the DOM");

  // ── runtime error surfaces (the bug: used to render blank) ─────────────────
  await fire(page, "sheet1.A3", "=nope(5)");
  const re = await errCel(page);
  ok(typeof re === "string" && /error|nope|not/i.test(re), "runtime error =nope(5) surfaces (not silent blank)", re);

  // ── clearing it recovers ──────────────────────────────────────────────────
  await fire(page, "sheet1.A2", "=10");
  ok((await page.evaluate(() => globalThis.plastron.state.cels.get("sheet1.A2")?.v)) === 10 && !(await errCel(page)), "fixing the formula clears the error");

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ formula-error surfacing all pass");
process.exit(failed ? 1 : 0);
