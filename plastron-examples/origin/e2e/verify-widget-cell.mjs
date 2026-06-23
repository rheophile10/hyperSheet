// Ad-hoc verification for fix A: a sized canvas widget in a grid cell must
// render at its natural footprint (un-clipped), wrapped in .cell-widget.
import { chromium } from "playwright";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const bundle = join(repoRoot, "dist/index.html");
if (!existsSync(bundle)) { console.error("no dist/index.html — run `bun e2e/run.ts` once to bundle"); process.exit(1); }
const kdist = join(repoRoot, "../../plastron/dist/index.js");
if (existsSync(kdist) && statSync(kdist).mtimeMs > statSync(bundle).mtimeMs) {
  console.log("📦 rebundling (kernel newer than dist)…");
  const r = Bun.spawnSync(["bun", join(repoRoot, "bundle.ts")], { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
}

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
await page.goto("file://" + bundle);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 8000 });
await page.waitForTimeout(250);

await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  // a chart worksheet (the turtles shape: a cels(…) window holding a canvas cell)
  await resolveFn(state, "origin.edit")(state, "desktop.A2");
  await resolveFn(state, "setValue")(state, "元.draft", '=cels("dash", 1, 1, at("a1", \'=canvas(300, 200, rect(0,0,300,200,"#222"), text(14,120,"chart","#fff","20px system-ui"))\'))');
  await resolveFn(state, "origin.run")(state, "desktop.A2");
  await new Promise((r) => setTimeout(r, 160));
});

const m = await page.evaluate(() => {
  const c = document.querySelector(".cell-widget canvas") || document.querySelector(".cell canvas");
  if (!c) return { found: false };
  const wrap = c.closest(".cell-value");
  const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let drawn = 0; for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) drawn++;
  return {
    found: true,
    canvasAttr: { w: c.width, h: c.height },
    rendered: { w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height) },
    wrapClass: wrap ? wrap.getAttribute("class") : null,
    drawn,
  };
});

let pass = true;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) pass = false; };
ok(m.found, "canvas present in a cell");
if (m.found) {
  ok(m.wrapClass?.includes("cell-widget"), `wrapper is .cell-widget (got "${m.wrapClass}")`);
  ok(m.rendered.h >= 195, `canvas rendered at full height ${m.rendered.h}px (natural ${m.canvasAttr.h}) — not clipped`);
  ok(m.rendered.w >= 295, `canvas rendered at full width ${m.rendered.w}px (natural ${m.canvasAttr.w})`);
  ok(m.drawn > 1000, `chart actually painted (${m.drawn} opaque px)`);
}
ok(errs.length === 0, `no page errors${errs.length ? ` (${errs.slice(0, 2).join(" | ")})` : ""}`);

await browser.close();
process.exit(pass ? 0 : 1);
