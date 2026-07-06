// e2e: the sheetapp feature matrix the user asked to see proven, in real chromium:
//   A. load + run an EXISTING user-segment example (turtles) in the workbook;
//   B. a NEW segment with FormulaCels downrange of ValueCels — calculations work;
//   C. switch worksheet TABS and see a FormulaCel update from a ValueCel edited on
//      a DIFFERENT worksheet (cross-worksheet reactivity), via real grid editing;
//   D. FormulaCels that PAINT to a dom-view window;
//   E. CREATE/open a NEW dom window in the view stack (window.addView).
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8827;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));

let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };
const settle = `async () => { const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k); for (let i=0;i<3;i++){ await F("view.refresh")(s); await F("runCycle")(s); await F("drain")(s,"dom.paint"); } }`;

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/404|Failed to load resource/.test(t)) errs.push("con:" + t.split("\n")[0]); } });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
  await page.waitForTimeout(1200);

  // ════ A. load + run an EXISTING user-segment example (turtles) ═════════════
  await page.evaluate(async () => { const s = globalThis.plastron.state; await globalThis.plastron.resolveFn(s, "origin.navOpen")(s, "doc:turtle_charts"); await globalThis.plastron.resolveFn(s, "drain")(s, "dom.paint"); });
  await page.waitForSelector(".pl-workbook", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900);
  ok(await page.evaluate(() => !!document.querySelector(".pl-workbook")), "A. existing example (turtles) opened as a workbook");
  ok(await page.evaluate(() => [...globalThis.plastron.state.cels.keys()].some((k) => /^turtle_data\.[A-Z]\d/.test(k))), "A. turtle_data worksheet hydrated + running");
  ok(await page.evaluate(() => document.querySelectorAll(".pl-wb-right canvas").length > 0), "A. turtle_charts dom-view paints chart canvases");
  ok(await page.evaluate(() => document.querySelectorAll('.pl-wb-left .cell-value[data-key^="turtle_data."]').length > 0), "A. the worksheet renders editable grid cells");

  // ════ B–E. a NEW workbook: ValueCels, downrange FormulaCels, dom views ═════
  await page.evaluate(async () => {
    const s = globalThis.plastron.state; const F = (k) => globalThis.plastron.resolveFn(s, k);
    const V = (k, v) => ({ celType: "ValueCel", v, metadata: { key: k, segment: k.split(".")[0] } });
    const Ff = (k, f) => ({ celType: "FormulaCel", f, metadata: { key: k, segment: k.split(".")[0], parser: "infix" } });
    await F("setCelBatch")(s, {
      "wbA.A1": V("wbA.A1", 10),                       // a ValueCel on sheet A
      "wbB.A1": Ff("wbB.A1", "=wbA.A1 * 2"),           // a FormulaCel DOWNRANGE, cross-worksheet (= 20)
      // editable grid bodies for each sheet + a dom-view that PAINTS from wbB.A1
      "saf.sA": Ff("saf.sA", "=sheetgrid('wbA', sheetcells('wbA.A1', wbA.A1), gridopts(sheet.editing, sheet.selected))"),
      "saf.sB": Ff("saf.sB", "=sheetgrid('wbB', sheetcells('wbB.A1', wbB.A1), gridopts(sheet.editing, sheet.selected))"),
      "saf.v1": Ff("saf.v1", "=dom('div.vw', CONCAT('B is ', wbB.A1))"),
    });
    const g = F("wbopen")("feat", "Feature Workbook",
      [{ ref: "saf.sA", title: "A" }, { ref: "saf.sB", title: "B" }],
      [{ ref: "saf.v1", title: "View1" }], { __geom: { x: 110, y: 70, w: 860, h: 560 } });
    await F("setCelBatch")(s, g.cels);
  });
  await page.evaluate(settle);
  await page.waitForTimeout(500);
  // raise the feature workbook so its cells aren't under the turtles window
  await page.evaluate(async () => { const s = globalThis.plastron.state; await globalThis.plastron.resolveFn(s, "window.raise")(s, "win.feat.state"); await globalThis.plastron.resolveFn(s, "drain")(s, "dom.paint"); });
  await page.waitForTimeout(400);

  // B. downrange FormulaCel computed from the ValueCel
  ok(await page.evaluate(() => Number(globalThis.plastron.state.cels.get("wbB.A1")?.v) === 20), "B. FormulaCel downrange of ValueCel computes (wbB.A1 = wbA.A1*2 = 20)");
  // D. the FormulaCel painted into the dom-view window
  ok(await page.evaluate(() => /B is 20/.test(document.querySelector('[data-win="win.feat.state"] .pl-wb-right')?.textContent ?? "")), "D. a FormulaCel paints into the dom-view window (B is 20)");

  // C. edit the ValueCel on sheet A via the GRID, then the FormulaCel on sheet B updates
  const cell = '[data-win="win.feat.state"] .pl-wb-left .cell-value[data-key="wbA.A1"]';
  await page.dblclick(cell);
  await page.waitForTimeout(300);
  await page.fill('[data-win="win.feat.state"] .pl-wb-left textarea.cell-edit', "50");
  await page.press('[data-win="win.feat.state"] .pl-wb-left textarea.cell-edit', "Enter");
  await page.waitForTimeout(500);
  ok(await page.evaluate(() => Number(globalThis.plastron.state.cels.get("wbA.A1")?.v) === 50), "C. editing the ValueCel via the grid committed (wbA.A1 = 50)");
  ok(await page.evaluate(() => Number(globalThis.plastron.state.cels.get("wbB.A1")?.v) === 100), "C. the downrange cross-worksheet FormulaCel recomputed (wbB.A1 = 100)");
  // switch to worksheet B's TAB and SEE the updated value
  await page.click('[data-win="win.feat.state"] .pl-wb-stabs button:has-text("B")');
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => /100/.test(document.querySelector('[data-win="win.feat.state"] .pl-wb-left')?.textContent ?? "")), "C. switching to worksheet B's tab shows the recomputed 100");
  const domViewSynced = await page.waitForFunction(
    () => /B is 100/.test(document.querySelector('[data-win="win.feat.state"] .pl-wb-right')?.textContent ?? ""),
    { timeout: 4000 },
  ).then(() => true).catch(() => false);
  ok(domViewSynced, "C. the dom-view also reflects the cross-worksheet edit (B is 100)");

  // E. create a NEW dom window in the view stack (window.addView authors + adds it)
  await page.evaluate(async () => {
    const s = globalThis.plastron.state;
    await globalThis.plastron.resolveFn(s, "window.addView")(s, { ref: "win.feat.state", viewRef: "saf.v2", title: "View2", f: "=dom('div.vw2', CONCAT('twice B = ', wbB.A1 * 2))" });
    await globalThis.plastron.resolveFn(s, "runCycle")(s); await globalThis.plastron.resolveFn(s, "drain")(s, "dom.paint");
  });
  await page.waitForTimeout(500);
  ok(await page.evaluate(() => { const t = document.querySelector('[data-win="win.feat.state"] .pl-wb-right .pl-wb-stabs'); return t && /View1/.test(t.textContent) && /View2/.test(t.textContent); }), "E. a NEW dom-view window was added to the stack (View1 + View2 tabs)");
  ok(await page.evaluate(() => /twice B = 200/.test(document.querySelector('[data-win="win.feat.state"] .pl-wb-right')?.textContent ?? "")), "E. the new dom view paints from a formula (twice B = 200)");

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ all sheetapp-features checks passed");
process.exit(failed ? 1 : 0);
