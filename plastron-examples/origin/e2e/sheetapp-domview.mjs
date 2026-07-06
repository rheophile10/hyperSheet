// ============================================================================
// e2e: the DOM-VIEW pane — open a sheet, then drive a dom panel entirely by
// FORMULAS, the way the turtle charts sit next to the sheets:
//   =domview('charts')                 → a <div id="charts"> view tab in the
//                                        workbook's RIGHT pane (next to the sheets)
//   =append('charts', dom('h1', …))    → append a dom vnode to it (reactive)
//
// Both are request→effect formulas (the formula returns a request, the
// origin.effects drain applies it), so a pure cell formula drives the panel.
//
//   bun e2e/sheetapp-domview.mjs
// ============================================================================
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8971;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const URLP = `http://localhost:${PORT}/index.html`;

let failed = 0;
const ok = (c, m, g) => { console.log(`${c ? "✓" : "✗"} ${m}${c ? "" : "  got: " + JSON.stringify(g)}`); if (!c) failed++; };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

// type a formula into the bar (元.draft) + fire it into `key` (the ⚡ path).
const fire = (page, key, formula) => page.evaluate(async ([key, formula]) => {
  const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
  await F("setValue")(s, "元.draft", formula); await F("origin.fire")(s, key);
  await new Promise((r) => setTimeout(r, 250));
}, [key, formula]);

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/404|Failed to load resource|favicon/.test(t)) errs.push("con:" + t.split("\n")[0]); } });
  await page.goto(URLP);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 12000 });
  await page.waitForTimeout(800);

  // open a sheet workbook + focus it
  await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("ensureSegments")(s, ["sheetapp", "sheets", "window", "dom", "segment-store", "user-space-ops"]);
    await F("hydrate")(s, [], []); await F("runCycle")(s);
    await F("origin.newsheet")(s); await F("window.raise")(s, "win.sheet1.state");
    await F("runCycle")(s); await F("drain")(s, "dom.paint");
  });
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => !!document.querySelector('[data-win="win.sheet1.state"]')), "a sheet workbook is open");

  // ════ =domview('charts') opens a dom pane in the workbook's RIGHT side ═════
  await fire(page, "sheet1.A1", "=domview('charts')");
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => {
    const st = globalThis.plastron.state.cels.get("win.sheet1.state")?.v;
    const div = document.querySelector("#charts.pl-domview");
    const rightPane = document.querySelector('[data-win="win.sheet1.state"] .pl-wb-right');
    return { views: (st?.views ?? []).map((v) => v.title), hasDiv: !!div, inRightPane: !!(rightPane && rightPane.querySelector("#charts")) };
  });
  ok(opened.views.includes("charts"), "=domview('charts') added a 'charts' view tab", opened.views);
  ok(opened.hasDiv, "the <div id='charts'> dom pane rendered", opened);
  ok(opened.inRightPane, "the dom pane is in the workbook's RIGHT pane (next to the sheets)", opened);

  // ════ =append('charts', dom(…)) appends dom to it (reactive, formula-driven) ═
  await fire(page, "sheet1.A2", "=append('charts', dom('h1', 'Hello World'))");
  await fire(page, "sheet1.A3", "=append('charts', dom('p', 'second item'))");
  await page.evaluate(async () => { const s = globalThis.plastron.state; await globalThis.plastron.resolveFn(s, "drain")(s, "dom.paint"); });
  await page.waitForTimeout(300);
  const html = await page.evaluate(() => document.querySelector("#charts")?.innerHTML ?? "");
  ok(/<h1[^>]*>Hello World<\/h1>/.test(html), "first append rendered an <h1>", html.slice(0, 120));
  ok(/<p[^>]*>second item<\/p>/.test(html), "second append rendered a <p> (items accumulate)", html.slice(0, 160));

  // ════ a third append updates reactively without re-opening ════════════════
  await fire(page, "sheet1.A4", "=append('charts', dom('button', 'click me'))");
  await page.evaluate(async () => { const s = globalThis.plastron.state; await globalThis.plastron.resolveFn(s, "drain")(s, "dom.paint"); });
  await page.waitForTimeout(250);
  ok(await page.evaluate(() => (document.querySelector("#charts")?.querySelectorAll("h1,p,button").length ?? 0) === 3), "the pane now holds 3 appended elements");

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs.slice(0, 2).join(" | ") : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ domview + append (formula-driven dom pane) all pass");
process.exit(failed ? 1 : 0);
