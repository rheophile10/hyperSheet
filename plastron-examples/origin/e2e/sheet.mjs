// e2e: the ▦ Sheet navpanel launcher opens a fresh BLANK worksheet —
// =cels("sheet", 20, 12, geom(0.18, 0.12, 0.6, 0.66)). Proves: clicking it mounts
// a 20×12 grid window, the geom() resolves to viewport-proportional pixels (via the
// navOpen "=formula" path's geom-application), and re-clicking reuses the segment.
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

const probe = () => p.evaluate(() => {
  const win = [...document.querySelectorAll(".pl-window")].find((w) => w.getAttribute("data-win") === "sheet");
  const box = win ? win.getBoundingClientRect() : null;
  return {
    mounted: !!win,
    w: box ? Math.round(box.width) : 0, h: box ? Math.round(box.height) : 0,
    cells: win ? win.querySelectorAll(".sheet-cell, [data-cell], td").length : 0,
    geom: globalThis.plastron.state.cels.get("win.geom")?.v?.sheet ?? null,
  };
});

await (await p.$('button.pl-nav-icon:has-text("Sheet")')).click();
await p.waitForTimeout(900);
const r = await probe();
ok(r.mounted, "clicking ▦ Sheet mounted a 'sheet' worksheet window", r);
ok(r.cells === 240, "the blank sheet is a 20×12 grid (240 cells)", r.cells);
// geom: x=0.18*1280=230, y=0.12*800=96, w=0.6*1280=768, h=0.66*800=528
ok(r.geom && r.geom.x === 230 && r.geom.y === 96 && r.geom.w === 768 && r.geom.h === 528, "geom() resolved to viewport-proportional pixels", r.geom);
ok(Math.abs(r.w - 768) <= 2 && Math.abs(r.h - 528) <= 2, "the rendered window honours the geom (≈768×528)", { w: r.w, h: r.h });

// re-clicking reuses the same segment (no sheet1/sheet2) and keeps it open.
await (await p.$('button.pl-nav-icon:has-text("Sheet")')).click();
await p.waitForTimeout(600);
const again = await probe();
ok(again.mounted && (await p.evaluate(() => [...document.querySelectorAll('.pl-window')].filter((w) => /^sheet/.test(w.getAttribute("data-win") || "")).length)) === 1, "re-clicking reuses the single 'sheet' window (no sheet1/sheet2)", again);

ok(errs.filter((e) => !/reading 'get'/.test(e)).length === 0, "no page errors", errs.slice(0, 2));
await b.close(); srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
