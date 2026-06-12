import { chromium } from "playwright";

const URL = process.env.URL ?? "http://localhost:5174/";
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(URL);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 12000 });
await page.waitForTimeout(500);
let pass = 0, fail = 0; const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); };

// the boot desktop must be clean
ok(errs.length === 0, `boot: no page errors${errs.length ? ` (${errs[0]})` : ""}`);

// create two state-cel windows via formulas
const put = (src, key) => page.evaluate(async ([s, k]) => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "origin.edit")(state, k);
  await resolveFn(state, "setValue")(state, "元.draft", s);
  await resolveFn(state, "origin.commit")(state, k);
  await new Promise((r) => setTimeout(r, 250));
  await resolveFn(state, "drain")(state, "dom.paint");
}, [src, key]);

await put('=doc(winmake("la", "Win A", "left window"), winmake("lb", "Win B", "right window"))', "元");
await page.waitForTimeout(400);

const winCount = await page.evaluate(() => document.querySelectorAll(".pl-window[data-win$='.state']").length);
ok(winCount >= 2, `two state-cel windows rendered (${winCount})`);

// each window has a 🔗 link grip in its titlebar
const gripCount = await page.evaluate(() => document.querySelectorAll(".pl-window .pl-link-grip").length);
ok(gripCount >= 2, `each window has a 🔗 link grip (${gripCount})`);

// the link overlay layer exists on the desktop
const overlayExists = await page.evaluate(() => !!document.querySelector(".pl-link-overlay"));
ok(overlayExists, "the SVG link overlay is mounted on .origin");

// simulate the corner-link drag: grip A → drop over window B. We stub
// elementsFromPoint so the drop hit-tests window B, then drive the handlers.
const linked = await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  const orig = document.elementsFromPoint?.bind(document);
  document.elementsFromPoint = () => [{ closest: (sel) => sel === ".pl-window" ? { getAttribute: () => "win.lb.state" } : null }];
  try {
    await resolveFn(state, "winx.linkGrab")(state, "win.la.state", { clientX: 100, clientY: 100, pointerId: 1 });
    await resolveFn(state, "winx.linkMove")(state, null, { clientX: 300, clientY: 300 });
    await resolveFn(state, "winx.linkDrop")(state, null, { clientX: 400, clientY: 400 });
    await resolveFn(state, "drain")(state, "dom.paint");
  } finally { document.elementsFromPoint = orig; }
  const links = state.cels.get("win.links")?.v ?? [];
  const bundled = resolveFn(state, "canGet")
    ? resolveFn(state, "canGet")(state, "win.la", "win.lb")
    : null;
  return { links, count: links.length };
});
ok(linked.count === 1, `link recorded one {a,b} pair in win.links (${linked.count})`);
ok(linked.links.some((p) => (p.a === "win.la.state" && p.b === "win.lb.state") || (p.a === "win.lb.state" && p.b === "win.la.state")), "the pair is the two dragged windows");

// the segments are now bundled (shared memory) — check via the live state
const shared = await page.evaluate(() => {
  const { state } = globalThis.plastron;
  const bundles = state.cels.get("access.bundles")?.v ?? [];
  return bundles.some((g) => g.has?.("win.la") && g.has?.("win.lb"));
});
ok(shared, "linking BUNDLED the two segments (shared memory)");

// a persistent edge <line> is now drawn between the windows
await page.waitForTimeout(200);
const edgeCount = await page.evaluate(() => document.querySelectorAll(".pl-link-overlay line.pl-link-edge").length);
ok(edgeCount >= 1, `a persistent edge line is drawn between the linked windows (${edgeCount})`);

// the edge re-renders reactively when a window MOVES — drive the REAL drag
// handlers (winx.grab → winx.move), the same path a titlebar drag fires. The
// line's endpoint should follow the new window position.
const moved = await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "winx.grab")(state, "win.la.state", { clientX: 110, clientY: 110, pointerId: 9 });
  await resolveFn(state, "winx.move")(state, null, { clientX: 887, clientY: 665 });
  await resolveFn(state, "winx.drop")(state, null, { clientX: 887, clientY: 665 });
  await resolveFn(state, "drain")(state, "dom.paint");
  await new Promise((r) => setTimeout(r, 200));
  const line = document.querySelector(".pl-link-overlay line.pl-link-edge");
  const win = document.querySelector('.pl-window[data-win="win.la.state"]');
  return { winLeft: win?.style?.left, x1: line?.getAttribute("x1"), y1: line?.getAttribute("y1") };
});
// the edge endpoint must match the window's new on-screen left position
ok(moved && moved.x1 && parseInt(moved.winLeft) === parseInt(moved.x1), `the edge follows the moved window reactively (win @${moved.winLeft}, edge x1=${moved.x1})`);

ok(errs.length === 0, `no page errors after linking${errs.length ? ` (${errs[0]})` : ""}`);
await browser.close();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
