// charts — the boot demo: a turtles sheet + bar/line/pie chart windows, each
// chart a formula over the sheet's column ranges. Asserts the genesis bloom,
// the canvas vnodes, painted pixels (incl. the wedge op), and reactivity:
// editing a sheet cell re-renders the bar chart.
import { chromium } from "playwright";
import { join, dirname } from "path"; import { fileURLToPath } from "url";
const bundle = join(dirname(fileURLToPath(import.meta.url)), "..", "dist/index.html");
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await b.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
await page.goto("file://" + bundle); await page.waitForFunction(() => !!globalThis.plastron, { timeout: 8000 }); await page.waitForTimeout(400);
let pass = 0, fail = 0; const ok = (c, w) => { if (c) { pass++; console.log("  ✔", w); } else { fail++; console.log("  ✘", w); } };

const v = (key) => page.evaluate((k) => globalThis.plastron.state.cels.get(k)?.v ?? null, key);

// the boot bloom: the turtles sheet + the three chart windows
ok(await v("turtles.A2") === "Galapagos tortoise", "turtles sheet seeded");
ok(await v("turtles.B2") === 177, "numeric cell hydrated as a number");
for (const id of ["bar", "line", "pie"]) {
  const cv = await v(`win.chart-${id}.content`);
  ok(cv && cv.tag === "canvas", `chart-${id} content is a canvas vnode`);
}
const barOps = JSON.parse((await v("win.chart-bar.content")).attrs["data-ops"]);
ok(barOps.filter((o) => o.op === "rect").length === 8, "bar: bg + 7 bars");
const pieOps = JSON.parse((await v("win.chart-pie.content")).attrs["data-ops"]);
ok(pieOps.filter((o) => o.op === "wedge").length === 7, "pie: 7 wedges");

// the painter replayed the specs — every 420×260 chart canvas has opaque pixels
const painted = await page.evaluate(() => [...document.querySelectorAll("canvas[width='420'][height='260']")].map((c) => {
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let nz = 0; for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) nz++;
  return nz;
}));
ok(painted.length >= 3, `three chart canvases in the DOM (${painted.length})`);
ok(painted.every((n) => n > 5000), `all charts painted (${painted.join(", ")} opaque px)`);
// the pie wedge fill actually landed: count palette-blue pixels on the pie canvas
const blue = await page.evaluate(() => {
  const cs = [...document.querySelectorAll("canvas[width='420'][height='260']")];
  let best = 0;
  for (const c of cs) {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] === 0x7f && d[i + 1] === 0xd0 && d[i + 2] === 0xff) n++;
    best = Math.max(best, n);
  }
  return best;
});
ok(blue > 800, `wedge/bar fill #7fd0ff present (${blue} px)`);

// reactivity: edit a sheet member → the bar chart formula re-renders
const before = barOps.filter((o) => o.op === "rect")[1].h;
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "setValue")(state, "turtles.B2", 20); // tortoise lifespan 177 → 20
  await new Promise((r) => setTimeout(r, 150));
});
const after = JSON.parse((await v("win.chart-bar.content")).attrs["data-ops"]).filter((o) => o.op === "rect")[1].h;
ok(after < before, `bar chart re-rendered on sheet edit (h ${before} → ${after})`);

ok(errs.length === 0, "no page errors" + (errs.length ? ": " + errs.slice(0, 2).join(" | ") : ""));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail ? 1 : 0);
