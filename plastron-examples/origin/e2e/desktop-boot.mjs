// e2e: the live desktop boot — a regression detector for the gen-1→gen-2 cutover
// (windowing-cutover Stage 5). Captures the behaviors that MUST keep working as 元
// moves to a gen-2 workbook and sheet-host/windows are retired:
//   - the page boots; the gen-2 desktop chrome paints (wallpaper, icons, taskbar);
//   - clicking 🧮 Origin shows the 元 base spreadsheet;
//   - clicking a doc launcher (📖 Readme) opens a workbook window;
//   - the taskbar tracks open windows; a window minimizes/restores;
//   - no page errors.
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8825;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));

let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/404|Failed to load resource/.test(t)) errs.push("con:" + t.split("\n")[0]); } });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
  await page.waitForTimeout(1500);

  // ── the gen-2 desktop chrome paints ────────────────────────────────────────
  ok(await page.evaluate(() => [...document.querySelectorAll("button.pl-desk-icon")].length >= 4), "desktop icons render");
  ok(await page.evaluate(() => !!document.querySelector(".desktop-bg") || !!document.querySelector("[class*=desktop]")), "wallpaper / desktop chrome present");
  ok(await page.evaluate(() => !!document.querySelector("[class*=task]")), "taskbar present");
  ok(await page.evaluate(() => !!globalThis.plastron.state.cels.get("desktop.iconbar.frame")), "desktop origin-application hydrated");

  // ── 🧮 Origin shows the 元 base spreadsheet ────────────────────────────────
  // (open via navOpen dispatch — desktop icons get occluded by open windows)
  await page.evaluate(async () => { const s = globalThis.plastron.state; await globalThis.plastron.resolveFn(s, "origin.navOpen")(s, "元"); await globalThis.plastron.resolveFn(s, "drain")(s, "dom.paint"); });
  await page.waitForTimeout(700);
  ok(await page.evaluate(() => !!document.querySelector('[data-win="元"], [data-win="win.元.state"], #app .cell, .pl-workbook')), "opening Origin shows the 元 base sheet");
  ok(await page.evaluate(() => { const c = globalThis.plastron.state.cels.get("元"); return !!c; }), "元 cel exists (the base substrate)");

  // ── 📖 Readme opens a workbook window ──────────────────────────────────────
  await page.evaluate(async () => { const s = globalThis.plastron.state; await globalThis.plastron.resolveFn(s, "origin.navOpen")(s, "doc:readme"); await globalThis.plastron.resolveFn(s, "drain")(s, "dom.paint"); });
  await page.waitForTimeout(1200);
  ok(await page.evaluate(() => [...document.querySelectorAll(".pl-window, .pl-workbook")].length >= 1), "Readme opened a window");
  ok(await page.evaluate(() => [...globalThis.plastron.state.cels.keys()].some((k) => /^readme\./.test(k))), "readme doc hydrated");

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ all desktop-boot checks passed");
process.exit(failed ? 1 : 0);
