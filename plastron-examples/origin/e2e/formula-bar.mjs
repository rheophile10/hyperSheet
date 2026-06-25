// e2e: the Excel FORMULA BAR + its affordances, proven in real chromium. The bar
// was silently dropped in the gen-2 cutover (sheet-host delete); this locks it in:
//   A. the bar renders ABOVE the grid (sheetpane) with ⚡ fire, 📖 wiki, 🔗 topology
//      buttons and a textarea — and the grid scrolls UNDER it (the bar isn't inside
//      the grid's scroll container, so a scrollbar can't occlude it).
//   B. selecting a cell loads its source into the bar (sheet.draft mirror); editing
//      + ⚡ commits the new formula to the selected cell.
//   C. 📖 opens the docgraph wiki on the selected cell (article + force-graph).
//   D. 🔗 opens the runCycle dependency-cone topology (upstream + self + downstream).
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8829;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));

let failed = 0;
const ok = (c, m, g) => { console.log(`${c ? "✓" : "✗"} ${m}${c ? "" : "  got: " + JSON.stringify(g)}`); if (!c) failed++; };

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/404|Failed to load resource/.test(t)) errs.push("con:" + t.split("\n")[0]); } });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
  await page.waitForTimeout(1200);

  // open the base 元 window
  await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("setValue")(s, "win.元.state", { ...s.cels.get("win.元.state").v, closed: 0, min: 0, w: 640, h: 470 });
    await F("window.raise")(s, "win.元.state");
    await F("origin.select")(s, "元");
    await F("runCycle")(s); await F("drain")(s, "dom.paint");
  });
  await page.waitForTimeout(400);

  // ════ A. bar layout ═══════════════════════════════════════════════════════
  const a = await page.evaluate(() => {
    const w = document.querySelector('[data-win="win.元.state"]');
    const bar = w?.querySelector(".sheet-fxbar"), grid = w?.querySelector("table.grid");
    const scroller = w?.querySelector(".sheet-pane-body");
    return {
      bar: !!bar, input: !!w?.querySelector("textarea.fx-input"),
      fire: !!w?.querySelector(".fx-fire"), wiki: !!w?.querySelector(".fx-wiki"), topo: !!w?.querySelector(".fx-topo"),
      barAboveGrid: bar && grid ? !!(bar.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING) : false,
      barOutsideScroller: bar && scroller ? !scroller.contains(bar) : false,
    };
  });
  ok(a.bar && a.input, "A. formula bar with a textarea renders");
  ok(a.fire && a.wiki && a.topo, "A. bar has ⚡ fire, 📖 wiki, 🔗 topology buttons", a);
  ok(a.barAboveGrid, "A. bar sits above the grid");
  ok(a.barOutsideScroller, "A. bar is OUTSIDE the grid's scroll container (no scrollbar occlusion)", a);

  // ════ B. select loads source; edit + ⚡ commits ═══════════════════════════
  const b = await page.evaluate(() => {
    const s = globalThis.plastron.state;
    const w = document.querySelector('[data-win="win.元.state"]');
    return { ref: w?.querySelector(".fx-ref")?.textContent, val: (w?.querySelector("textarea.fx-input")?.value ?? "").length };
  });
  ok(b.ref === "元" && b.val > 0, "B. selecting a cell loads its ref + source into the bar", b);
  const committed = await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("setValue")(s, "元.draft", "=7 * 6");   // simulate typing into the bar (input writes 元.draft)
    await F("origin.fire")(s, "元");                 // ⚡ fire button
    return s.cels.get("元")?.v;
  });
  ok(Number(committed) === 42, "B. ⚡ commits the bar's formula to the cell (元 = 42)", { committed });

  // restore 元 so later boots/screens aren't stuck on 42
  await page.evaluate(async () => { const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k); await F("setValue")(s, "元.draft", ""); await F("origin.fire")(s, "元"); await F("origin.select")(s, "元"); await F("drain")(s, "dom.paint"); });
  await page.waitForTimeout(300);

  // ════ C. 📖 wiki ═══════════════════════════════════════════════════════════
  await page.click('[data-win="win.元.state"] .fx-wiki');
  await page.waitForTimeout(700);
  const c = await page.evaluate(() => {
    const s = globalThis.plastron.state, st = s.cels.get("win.wiki.state")?.v;
    const w = document.querySelector('[data-win="win.wiki.state"]');
    return { open: !!st && !st.closed, current: s.cels.get("wiki.current")?.v, graph: !!w && w.querySelectorAll("canvas").length > 0 };
  });
  ok(c.open && c.current === "元", "C. 📖 opens the wiki on the selected cell", c);
  ok(c.graph, "C. the wiki renders a force-directed graph (canvas)", c);

  // ════ D. 🔗 topology — a real dependency chain ════════════════════════════
  await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    const V = (k, v) => ({ celType: "ValueCel", v, metadata: { key: k, segment: "fbtopo" } });
    const Ff = (k, f) => ({ celType: "FormulaCel", f, metadata: { key: k, segment: "fbtopo", parser: "infix" } });
    await F("setCelBatch")(s, { "fbtopo.A1": V("fbtopo.A1", 10), "fbtopo.B1": Ff("fbtopo.B1", "=fbtopo.A1 * 2"), "fbtopo.C1": Ff("fbtopo.C1", "=fbtopo.B1 + 1") });
    await F("runCycle")(s);
    await F("origin.celtopo")(s, "fbtopo.B1");   // topology of B1: A1 upstream, C1 downstream
  });
  await page.waitForTimeout(600);
  const d = await page.evaluate(() => {
    const s = globalThis.plastron.state, st = s.cels.get("win.celtopo.state")?.v;
    const spec = s.cels.get("fg.celtopo.spec")?.v;
    const kind = (k) => (spec?.nodes ?? []).find((n) => n.key === k)?.kind;
    return { open: !!st && !st.closed, self: kind("fbtopo.B1"), up: kind("fbtopo.A1"), down: kind("fbtopo.C1"), edges: (spec?.edges ?? []).length };
  });
  ok(d.open, "D. 🔗 opens the topology window", d);
  ok(d.self === "self" && d.up === "up" && d.down === "down", "D. cone tags self / upstream / downstream correctly", d);
  ok(d.edges >= 2, "D. topology graph carries the runCycle edges", d);

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ all formula-bar checks passed");
process.exit(failed ? 1 : 0);
