// e2e: cels(…, geom(x,y,w,h)) declares a worksheet window's geometry. A value in
// (0,1] is a PROPORTION of the viewport (x/w → viewport.w, y/h → viewport.h); >1
// is absolute pixels. The genesis writes it into win.geom[name] the FIRST time the
// window materializes, and a later user drag/resize is preserved.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const PORT = 8791, dist = new URL("../dist", import.meta.url).pathname;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
await page.waitForTimeout(800);

let pass = 0, fail = 0;
const ok = (c, w, got) => { if (c) { pass++; console.log("  ✔", w); } else { fail++; console.log("  ✘", w, "  got:", JSON.stringify(got)); } };

// run a formula into a fresh holding cell (commits + settles, like a launcher).
const run = (runKey, formula) => page.evaluate(async ([k, f]) => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "origin.run")(state, k, f);
  await new Promise((r) => setTimeout(r, 100));
}, [runKey, formula]);

const geomOf = (seg) => page.evaluate((s) => globalThis.plastron.state.cels.get("win.geom")?.v?.[s] ?? null, seg);
const viewport = () => page.evaluate(() => ({ w: globalThis.plastron.state.cels.get("viewport.w")?.v, h: globalThis.plastron.state.cels.get("viewport.h")?.v }));
// the rendered window element's box (width/height are exact; x/y carry the .origin offset)
const winBox = (seg) => page.evaluate((s) => {
  const w = [...document.querySelectorAll(".pl-window")].find((x) => x.getAttribute("data-win") === s);
  if (!w) return null; const r = w.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
}, seg);

const vp = await viewport();
ok(vp.w === 1280 && vp.h === 800, `viewport.w/h seeded to the real viewport (${vp.w}×${vp.h})`, vp);

// 1) PROPORTIONAL geom — 10% x, 15% y, 50% w, 40% h of the 1280×800 viewport.
await run("g1.run", '=cels("gprop", 4, 4, geom(0.1, 0.15, 0.5, 0.4), at("a1", "x"))');
const g1 = await geomOf("gprop");
ok(g1 && g1.x === 128, "geom(0.1,…) x → 10% of viewport.w (128)", g1);
ok(g1 && g1.y === 120, "geom(…,0.15,…) y → 15% of viewport.h (120)", g1);
ok(g1 && g1.w === 640, "geom(…,0.5,…) w → 50% of viewport.w (640)", g1);
ok(g1 && g1.h === 320, "geom(…,0.4) h → 40% of viewport.h (320)", g1);
const g1box = await winBox("gprop");
ok(g1box && Math.abs(g1box.w - 640) <= 2, "the rendered gprop window is ~640px wide", g1box);
ok(g1box && Math.abs(g1box.h - 320) <= 2, "the rendered gprop window is ~320px tall", g1box);

// 2) ABSOLUTE PIXELS — values >1 pass straight through.
await run("g2.run", '=cels("gpx", 3, 3, geom(50, 60, 420, 300), at("a1", "x"))');
const g2 = await geomOf("gpx");
ok(g2 && g2.x === 50 && g2.y === 60 && g2.w === 420 && g2.h === 300, "geom(50,60,420,300) → exact pixels", g2);

// 3) SIZE-ONLY is fine — 0 is pixels (0), not a proportion; w/h are proportions.
await run("g3.run", '=cels("gsize", 2, 2, geom(0, 0, 0.5, 1), at("a1", "x"))');
const g3 = await geomOf("gsize");
ok(g3 && g3.x === 0 && g3.y === 0 && g3.w === 640 && g3.h === 800, "geom(0,0,0.5,1) → left half, full height", g3);

// 4) a worksheet WITHOUT geom() gets no seeded geometry (content-sized).
await run("g4.run", '=cels("gnone", 2, 2, at("a1", "x"))');
const g4 = await geomOf("gnone");
ok(g4 === null || (g4.w === undefined && g4.h === undefined), "no geom() → no win.geom size entry (content-sized)", g4);

// 5) PRESERVE a user resize: drag gpx bigger, re-run its formula → geom does NOT clobber.
await page.evaluate(() => {
  const { state, resolveFn } = globalThis.plastron;
  const m = { ...(state.cels.get("win.geom")?.v ?? {}) };
  m.gpx = { ...m.gpx, w: 999, h: 777 };   // simulate a user drag/resize
  return resolveFn(state, "setValue")(state, "win.geom", m);
});
await run("g2.run", '=cels("gpx", 3, 3, geom(50, 60, 420, 300), at("a1", "x"))');   // re-open
const g5 = await geomOf("gpx");
ok(g5 && g5.w === 999 && g5.h === 777, "re-running preserves the user's resize (geom only sets a NEW window)", g5);

// 6) MIN SIZE (CSS min-width/min-height floor) — the proportional w/h resolves
// SMALL (0.2 → 256×160) but minW/minH (500, 400) clamp the RENDERED window.
await run("g6.run", '=cels("gmin", 3, 3, geom(0.1, 0.1, 0.2, 0.2, 500, 400), at("a1", "x"))');
const g6 = await geomOf("gmin");
ok(g6 && g6.w === 256 && g6.h === 160, "proportional w/h resolved (0.2 → 256×160)", g6);
ok(g6 && g6.minW === 500 && g6.minH === 400, "min-width/min-height stored on win.geom (500×400)", g6);
const g6box = await winBox("gmin");
ok(g6box && g6box.w >= 500, "rendered window honours min-width (≥500 although w=256)", g6box);
ok(g6box && g6box.h >= 400, "rendered window honours min-height (≥400 although h=160)", g6box);

ok(errs.filter((e) => !/reading 'get'/.test(e)).length === 0, "no page errors", errs.slice(0, 3));

await b.close(); srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
