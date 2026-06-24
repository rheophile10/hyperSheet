// e2e: the sheetapp WORKBOOK acceptance gate, in real headless chromium against
// the bundled origin. Authors a workbook the plastron way (cels + formulas, incl.
// a live button lambda) and drives it to prove the consolidated sheetapp can:
//   1. host MULTIPLE worksheets whose formulas reference one another ACROSS sheets;
//   2. host a dom-view pane formulas paint into, incl. a BUTTON that updates a cel
//      on click — re-rendering reactively across BOTH panes (dispatch → setValue);
//   4. FULLSCREEN one pane / switch / see both (two-pane workbook + per-pane full).
// (Criterion 3 — save a user segment + reopen from OPFS — is covered by the unit
//  suite test/sheetapp-docs.test.mjs and the Turtles opendoc→workbook smoke.)
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8821;
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
  await page.waitForTimeout(1200);

  // ── author a 2-sheet + 1-view workbook, then open it via wbopen ─────────────
  await page.evaluate(async () => {
    const s = globalThis.plastron.state;
    const F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("ensureSegments")(s, ["origin", "sheetapp", "sheets", "window", "dom", "sheet"]);
    const V = (k, v) => ({ celType: "ValueCel", v, metadata: { key: k, segment: k.split(".")[0] } });
    const Ff = (k, f) => ({ celType: "FormulaCel", f, metadata: { key: k, segment: k.split(".")[0], parser: "infix" } });
    await F("setCelBatch")(s, {
      // sheet A — data
      "wbd.B1": V("wbd.B1", 10), "wbd.B2": V("wbd.B2", 4),
      // sheet B — a CROSS-SHEET formula referencing sheet A
      "wbc.B1": Ff("wbc.B1", "=wbd.B1 * wbd.B2"),
      // view — counter the button bumps
      "wbv.count": V("wbv.count", 0),
    });
    // live button lambda (page context) — bumps the counter + repaints
    await F("setCel")(s, "wbv.bump", { celType: "LockedLambdaCel", locked: true, fn: async (st) => {
      const R = (k) => globalThis.plastron.resolveFn(st, k);
      const cur = Number(st.cels.get("wbv.count")?.v ?? 0);
      await R("setValue")(st, "wbv.count", cur + 1);
      await R("runCycle")(st); await R("drain")(st, "dom.paint");   // runCycle+drain lands (painter quirk)
    }, metadata: { key: "wbv.bump", segment: "wbv", kind: "native" } });
    // content cells: two sheet bodies (the 2nd shows the cross-sheet total AND the
    // live click count → cross-pane reactivity) + a dom-view button body
    await F("setCelBatch")(s, {
      "sa.s1": Ff("sa.s1", "=dom('div', CONCAT('qty ', wbd.B1, '  rate ', wbd.B2))"),
      "sa.s2": Ff("sa.s2", "=dom('div', CONCAT('total=', wbc.B1, '  clicks=', wbv.count))"),
      "sa.v1": Ff("sa.v1", "=dom('button', CONCAT('clicked: ', wbv.count), on('click', 'wbv.bump'))"),
    });
    const g = F("wbopen")("acc", "Acceptance Workbook",
      [{ ref: "sa.s1", title: "Data" }, { ref: "sa.s2", title: "Calc" }],
      [{ ref: "sa.v1", title: "Dashboard" }], { __geom: { x: 120, y: 64, w: 840, h: 540 } });
    await F("setCelBatch")(s, g.cels);
    // settle: the self-mounting frame references the content cells, which reference
    // the data cells — refresh the view set, then a few runCycle/drain passes.
    for (let i = 0; i < 4; i++) { await F("view.refresh")(s); await F("runCycle")(s); await F("drain")(s, "dom.paint"); }
  });
  await page.waitForSelector(".pl-workbook", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(600);

  // ── 1. multiple worksheets + a cross-sheet formula ─────────────────────────
  ok(await page.evaluate(() => !!document.querySelector(".pl-workbook")), "opened as a workbook window");
  ok(await page.evaluate(() => { const t = document.querySelector(".pl-wb-stabs"); return t && /Data/.test(t.textContent) && /Calc/.test(t.textContent); }), "two worksheet tabs (Data, Calc)");
  ok(await page.evaluate(() => { const t = document.querySelector(".pl-wb-vtabs"); return t && /Dashboard/.test(t.textContent); }), "a dom-view tab (Dashboard)");
  ok(await page.evaluate(() => Number(globalThis.plastron.state.cels.get("wbc.B1")?.v) === 40), "cross-sheet formula computed (wbc.B1 = wbd.B1*B2 = 40)");
  ok(await page.evaluate(() => /qty 10/.test(document.querySelector(".pl-wb-left")?.textContent ?? "")), "active sheet (Data) body renders");

  // ── 2. a dom-view button that updates a cel + re-renders BOTH panes ─────────
  ok(await page.evaluate(() => /clicked: 0/.test(document.querySelector(".pl-wb-vbody")?.textContent ?? "")), "dom-view button renders (clicked: 0)");
  await page.click(".pl-wb-vbody button");   // the view BODY button, not the tab chip
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => Number(globalThis.plastron.state.cels.get("wbv.count")?.v) === 1), "clicking the button updated the cel (count = 1)");
  ok(await page.evaluate(() => /clicked: 1/.test(document.querySelector(".pl-wb-vbody")?.textContent ?? "")), "the view pane re-rendered reactively (clicked: 1)");
  // switch to the Calc sheet → it shows the live click count too (cross-pane reactivity)
  await page.click('.pl-wb-stabs button:has-text("Calc")');
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => /clicks=1/.test(document.querySelector(".pl-wb-left")?.textContent ?? "")), "the OTHER sheet pane reflects the click (cross-pane reactivity)");
  ok(await page.evaluate(() => /total=40/.test(document.querySelector(".pl-wb-left")?.textContent ?? "")), "Calc sheet shows the cross-sheet total (40)");

  // ── 4. fullscreen one pane / switch / see both ─────────────────────────────
  ok(await page.evaluate(() => !!document.querySelector(".pl-wb-divider")), "see both panes (divider present)");
  // click the view pane's fullscreen (⛶) button — the LAST .pl-wb-full
  await page.evaluate(() => { const b = [...document.querySelectorAll(".pl-wb-full")].pop(); b && b.click(); });
  await page.waitForTimeout(350);
  ok(await page.evaluate(() => !document.querySelector(".pl-wb-divider") && !!document.querySelector(".pl-wb-right button")), "fullscreen the view pane (no divider; view still shown)");
  await page.evaluate(() => { const b = [...document.querySelectorAll(".pl-wb-full")].pop(); b && b.click(); });
  await page.waitForTimeout(350);
  ok(await page.evaluate(() => !!document.querySelector(".pl-wb-divider") && !!document.querySelector(".pl-wb-left")), "toggle back to see-both (divider returns, both panes)");

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ all sheetapp-workbook acceptance checks passed");
process.exit(failed ? 1 : 0);
