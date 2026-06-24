// e2e: the ▦ Sheet desktop launcher (do:origin.newsheet) creates a FRESH blank
// worksheet DOCUMENT each click — a new origin-user sheetapp segment (sheet1,
// sheet2, …) seeded with a 12×7 grid, rendered as a one-pane gen-2 workbook
// window (win.<doc>.state). Proves: clicking it mounts a workbook with editable
// grid cells, and a second click makes a SECOND new sheet (not a reuse).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const PORT = 8811, dist = new URL("../dist", import.meta.url).pathname;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; p.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
await p.goto(`http://localhost:${PORT}/index.html`);
await p.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
await p.waitForTimeout(1200);
let pass = 0, fail = 0; const ok = (c, w, g) => { if (c) { pass++; console.log("  ✔", w); } else { fail++; console.log("  ✘", w, "got:", JSON.stringify(g)); } };

// inspect a sheetapp workbook window by its doc segment (win.<doc>.state).
const probe = (doc) => p.evaluate((d) => {
  const win = [...document.querySelectorAll(".pl-window")].find((w) => w.getAttribute("data-win") === `win.${d}.state`);
  return {
    mounted: !!win,
    workbook: !!win && win.classList.contains("pl-workbook"),
    cells: win ? win.querySelectorAll("td.cell").length : 0,
    docExists: !!globalThis.plastron.state.cels.get(`win.${d}.state`),
  };
}, doc);

await (await p.$('button.pl-desk-icon:has-text("Sheet")')).click();
await p.waitForTimeout(900);
const r = await probe("sheet1");
ok(r.mounted, "clicking ▦ Sheet mounted a new 'sheet1' workbook window", r);
ok(r.workbook, "the new sheet renders as a gen-2 workbook (pl-workbook)", r);
ok(r.cells >= 84, "the blank sheet has its 12×7 grid of editable cells (≥84)", r.cells);

// a SECOND click makes a SECOND fresh document (sheet2) — New, not reuse.
await (await p.$('button.pl-desk-icon:has-text("Sheet")')).click();
await p.waitForTimeout(900);
const r2 = await probe("sheet2");
ok(r2.mounted, "re-clicking ▦ Sheet makes a SECOND new sheet (sheet2)", r2);
const count = await p.evaluate(() => [...document.querySelectorAll(".pl-window")].filter((w) => /^win\.sheet\d+\.state$/.test(w.getAttribute("data-win") || "")).length);
ok(count === 2, "two distinct sheet workbooks are open", count);

ok(errs.filter((e) => !/reading 'get'/.test(e)).length === 0, "no page errors", errs.slice(0, 2));
await b.close(); srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
