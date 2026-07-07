import { test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";

// shipped formula-first DOCS — validates the origin-user document archives the
// desktop actually installs: plastron-examples/origin/apps/docs/{turtles,keyboard}.json.
// (The old vizdemo doc was RETIRED — its bar/line/pie demo is the turtles doc now.)
// The accepted shape: worksheets on the LEFT hold the data + the visible GENERATING
// formulas; the visualization renders in the workbook's RIGHT view pane via
// =view("name", <vnode>) — NOT inside a grid cell. turtles is the COLLECTIONS-
// DOCTRINE showcase: =rows() pivots the grid into the hub form (list of dicts) in
// B1, =FILTER derives B3 from the species filter cell B2 (written by the
// dashboard's <select> through param.set), and ONE =view("🐢 dashboard") formula
// grows a pane holding the select + bar/line/pie, every chart broadcasting
// .species/.lifespan/… off the filtered dataset. The tests load the REAL files,
// so they and the desktop demos can't drift.

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-vizdemo";

const { createInitialState, resolveFn } = await import("../dist/index.js");

// the shipped artifacts — the single source of truth (tests + dock both load these)
const docsDir = "../../plastron-examples/origin/apps/docs";
const turtlesDoc = JSON.parse(readFileSync(new URL(`${docsDir}/turtles.json`, import.meta.url), "utf8"));
const keyboardDoc = JSON.parse(readFileSync(new URL(`${docsDir}/keyboard.json`, import.meta.url), "utf8"));

const root = createInitialState().cels.get("file-store.root").v;
beforeEach(async () => { await fs.rm(path.resolve(root, "plastron"), { recursive: true, force: true }); });

const boot = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["origin", "sheets", "window", "origin-lifecycle", "user-space-ops", "segment-store", "opfs-seeding"]);
  await resolveFn(s, "hydrate")(s, [], []);
  return s;
};

const sheetappArchive = {
  formatVersion: 1,
  segments: [{ name: "sheetapp", cels: [{ key: "sheetapp.program", celType: "ValueCel", metadata: { key: "sheetapp.program", segment: "sheetapp" }, v: "worksheet" }] }],
  manifests: [{ name: "sheetapp", version: "1.0.0", description: "sheet app", role: "application", kind: "origin-application", dependencies: [] }],
};

// settle: runCycle + land genesis AND origin.effects — the =view contributions are
// request→effect formulas, so they only reach the view pane at the effects drain.
// (sheetapp.opendoc does NOT drain origin.effects yet — the workbook render path
// only drains dom.paint — so this loop stands in for the missing opendoc settle.)
const settle = async (s) => {
  const drain = resolveFn(s, "drain"), runCycle = resolveFn(s, "runCycle");
  for (let i = 0; i < 6; i++) {
    await runCycle(s);
    if (s.cels.get("genesis.commit")) await drain(s, "genesis.commit");
    if (s.cels.get("origin.effects")) await drain(s, "origin.effects");
  }
};

// a =view slot: <name>.view → [slot div[data-cel]] → the contributed vnode
const slotItem = (s, name) => s.cels.get(`${name}.view`)?.v?.children?.[0]?.children?.[0];
const opsOf = (vnode) => {
  assert.ok(vnode && vnode.tag === "canvas", "the view slot holds a <canvas> vnode");
  return JSON.parse(vnode.attrs["data-ops"]);
};

const openDoc = async (s, doc, primary) => {
  await resolveFn(s, "origin.install")(s, sheetappArchive);
  await resolveFn(s, "origin.install")(s, doc);
  await resolveFn(s, "origin.opendoc")(s, primary); // what the dock icon's doc:<primary> runs
  await settle(s);
};

// the dashboard pane's parts: [controls row (select), charts row (3 canvases)]
const dashParts = (s) => {
  const slot = slotItem(s, "dashboard");
  const rows = slot?.children ?? [];
  const chartsRow = rows.find((r) => r.children?.some?.((c) => c.tag === "canvas"));
  const canvases = chartsRow?.children?.filter((c) => c.tag === "canvas") ?? [];
  const options = JSON.stringify(rows.find((r) => JSON.stringify(r).includes('"select"')) ?? {}).match(/"option"/g) ?? [];
  return { canvases, optionCount: options.length };
};

test("turtles: the dashboard doc — =rows pivot, =FILTER derivation, ONE =view pane with select + 3 charts", async () => {
  const s = await boot();
  await openDoc(s, turtlesDoc, "turtle_charts");

  assert.equal(s.cels.has("turtle_data.B2"), true, "the data segment loaded (pulled as a dep)");
  const wb = s.cels.get("win.turtle_charts.state")?.v;
  assert.ok(wb, "the sheetApp workbook rendered the doc");
  assert.deepEqual(wb.sheets.map((t) => t.title), ["turtle_data", "turtle_charts"], "BOTH segments are worksheet tabs");
  assert.deepEqual(wb.views.map((t) => t.title), ["🐢 dashboard"], "ONE dashboard VIEW tab on the right");

  // B1: the hub-form pivot — the grid rows as a LIST OF DICTS keyed by the header row
  const b1 = s.cels.get("turtle_charts.B1");
  assert.ok(b1.f.startsWith("=rows("), "B1 keeps its =rows() pivot source");
  assert.equal(Array.isArray(b1.v) && b1.v.length, 7, "B1 is 7 dicts (one per species)");
  assert.deepEqual(Object.keys(b1.v[0]), ["species", "lifespan", "speed", "eggs"], "dict keys come from the header row");

  // B3: the FILTER derivation (empty filter = all rows pass)
  const b3 = s.cels.get("turtle_charts.B3");
  assert.ok(b3.f.startsWith("=FILTER("), "B3 keeps its =FILTER source");
  assert.equal(b3.v.length, 7, "filter='all' → all 7 dicts");

  // B4: the generative dashboard formula — token in the cell, pane on the right
  const b4 = s.cels.get("turtle_charts.B4");
  assert.ok(b4.f.startsWith('=view("🐢 dashboard"'), "B4 keeps its =view source (emoji title, sanitized ref)");
  assert.deepEqual(b4.v, { view: "dashboard", item: true }, "B4's value is the pane token (nothing renders in the cell)");

  const { canvases, optionCount } = dashParts(s);
  assert.equal(canvases.length, 3, "the dashboard pane holds ALL THREE charts");
  assert.equal(optionCount, 8, "the species select: 'all' + one option per species");
  const bars = opsOf(canvases[0]).filter((o) => o.op === "rect");
  assert.equal(bars.length - 1, 7, "barchart: one bar per species (+ bg rect)");
  const wedges = opsOf(canvases[2]).filter((o) => o.op === "wedge");
  assert.equal(wedges.length, 7, "piechart: one wedge per species");
  const poly = opsOf(canvases[1]).find((o) => o.op === "line" && o.points?.length === 7);
  assert.ok(poly, "linechart: a 7-point polyline");
});

// every drawn op's extent, inside the canvas's own width/height attrs. Rects/
// lines/circles/wedges are exact; text width is estimated at the verb's own
// 0.52 em-factor (the same estimate centered()/the linechart clamp use — within
// the design's ≤0.6px/char envelope). Returns the worst offender, or null.
const EM = 0.52;
const worstOverflow = (canvas) => {
  const W = Number(canvas.attrs.width), H = Number(canvas.attrs.height);
  let worst = null;
  const bump = (x, y, o) => { const over = Math.max(x - W, -x, y - H, -y); if (over > 1e-9 && (!worst || over > worst.over)) worst = { op: o.op, text: o.text, x, y, over }; };
  for (const o of opsOf(canvas)) {
    if (o.op === "rect") { bump(o.x, o.y, o); bump(o.x + o.w, o.y + o.h, o); }
    else if (o.op === "line") for (const [px, py] of o.points) bump(px, py, o);
    else if (o.op === "circle") { bump(o.x - o.r, o.y - o.r, o); bump(o.x + o.r, o.y + o.r, o); }
    else if (o.op === "wedge") { bump(o.cx - o.r, o.cy - o.r, o); bump(o.cx + o.r, o.cy + o.r, o); }
    else if (o.op === "text") { const fpx = parseInt(o.font) || 10; bump(o.x, o.y - fpx, o); bump(o.x + o.text.length * fpx * EM, o.y, o); }
  }
  return worst;
};

test("turtles: every chart op is inside its canvas — nothing clips (root-cause pin)", async () => {
  const s = await boot();
  await openDoc(s, turtlesDoc, "turtle_charts");
  const { canvases } = dashParts(s);
  assert.equal(canvases.length, 3, "three canvases");
  for (const c of canvases) {
    assert.equal([Number(c.attrs.width), Number(c.attrs.height)].join("x"), "480x300", "each canvas is the enlarged 480×300 surface");
    const worst = worstOverflow(c);
    assert.equal(worst, null, `no op clips the canvas — worst: ${JSON.stringify(worst)}`);
  }
});

test("turtles: no chart label is ellipsized and the pie legend shows all seven rows", async () => {
  const s = await boot();
  await openDoc(s, turtlesDoc, "turtle_charts");
  const { canvases } = dashParts(s);
  for (const c of canvases) {
    const ell = opsOf(c).filter((o) => o.op === "text" && /…/.test(o.text)).map((o) => o.text);
    assert.deepEqual(ell, [], "no '…'-clipped label in the chart");
  }
  const legend = opsOf(canvases[2]).filter((o) => o.op === "text" && /\(\d+%\)/.test(o.text));
  assert.equal(legend.length, 7, "the pie legend lists all seven species (value + %)");
  assert.ok(!opsOf(canvases[2]).some((o) => /\+\d+ more/.test(o.text ?? "")), "no '+N more' overflow row");
});

test("turtles: the manifest window block sizes the workbook; a doc without one keeps the default", async () => {
  const s = await boot();
  await openDoc(s, turtlesDoc, "turtle_charts");
  const wb = s.cels.get("win.turtle_charts.state")?.v;
  assert.deepEqual(
    { x: wb.x, y: wb.y, w: wb.w, h: wb.h, split: wb.split },
    { x: 48, y: 20, w: 1120, h: 640, split: 0.42 },
    "renderWorkbook honored turtle_charts' manifest window geometry + split",
  );
  // a doc that declares NO window block still opens at the 820×540 / 0.58 default
  const s2 = await boot();
  await openDoc(s2, keyboardDoc, "keyboard");
  const kb = s2.cels.get("win.keyboard.state")?.v;
  assert.deepEqual({ w: kb.w, h: kb.h, split: kb.split }, { w: 820, h: 540, split: 0.58 }, "keyboard.json (no window block) keeps the default geometry");
});

test("turtles: the species filter (param.set → B2) re-derives B3 and re-renders EVERY chart", async () => {
  const s = await boot();
  await openDoc(s, turtlesDoc, "turtle_charts");

  // the select dispatches param.set with the cel key — same call the DOM event makes
  await resolveFn(s, "param.set")(s, "turtle_charts.B2", { target: { value: "Leatherback" } });
  await settle(s);

  assert.equal(s.cels.get("turtle_charts.B2")?.v, "Leatherback", "the filter cell took the select's value");
  assert.equal(s.cels.get("turtle_charts.B3")?.v?.length, 1, "B3 filtered down to the one species");
  const { canvases } = dashParts(s);
  assert.equal(opsOf(canvases[0]).filter((o) => o.op === "rect").length - 1, 1, "barchart: one bar");
  assert.equal(opsOf(canvases[2]).filter((o) => o.op === "wedge").length, 1, "piechart: one wedge");

  // back to all
  await resolveFn(s, "param.set")(s, "turtle_charts.B2", { target: { value: "all" } });
  await settle(s);
  assert.equal(s.cels.get("turtle_charts.B3")?.v?.length, 7, "selecting 'all' restores all rows");
});

test("turtles: editing a data cell re-renders the dashboard through the =rows pivot", async () => {
  const s = await boot();
  await openDoc(s, turtlesDoc, "turtle_charts");
  const barH = () => opsOf(dashParts(s).canvases[0]).filter((o) => o.op === "rect")[2].h; // Leatherback (not the max)
  const before = barH();

  await resolveFn(s, "setValue")(s, "turtle_data.B2", 500); // stretch the scale
  await settle(s);

  assert.equal(s.cels.get("turtle_charts.B1")?.v?.[0]?.lifespan, 500, "the edit flowed into the hub-form dataset");
  assert.notEqual(barH(), before, "…and through =FILTER + =view to the pane canvas");
});

test("keyboard: note/freq rows drive ONE =view formula; the playable keys render in the view pane", async () => {
  const s = await boot();
  await openDoc(s, keyboardDoc, "keyboard");

  const wb = s.cels.get("win.keyboard.state")?.v;
  assert.ok(wb, "the keyboard workbook rendered");
  assert.deepEqual(wb.sheets.map((t) => t.title), ["keyboard"], "one worksheet: the note/freq data + the formula");
  assert.deepEqual(wb.views.map((t) => t.title), ["piano"], "the =view formula contributed the piano VIEW tab (named ≠ the segment so the tab ref can't collide with the sheet tab's)");

  const c1 = s.cels.get("keyboard.C1");
  assert.ok(c1.f.startsWith('=view("piano"'), "C1 keeps its generating =view source");
  assert.deepEqual(c1.v, { view: "piano", item: true }, "C1's value is the pane token — no buttons render in the grid");

  const pane = slotItem(s, "piano");
  const row = pane.children.find((c) => c.tag === "div");
  const keys = row.children.filter((c) => c.tag === "button");
  assert.equal(keys.length, 7, "seven keys");
  assert.equal(keys.map((k) => k.children?.[0]?.text).join(""), "CDEFGAB", "key caps come from the note cells");
  assert.deepEqual(keys[0].events.click, { dispatch: "origin.tone", payload: 262 }, "pressing C dispatches origin.tone with the freq CELL's value");
});

test("keyboard: editing a note/freq cell re-renders the keys in the view pane", async () => {
  const s = await boot();
  await openDoc(s, keyboardDoc, "keyboard");

  await resolveFn(s, "setValue")(s, "keyboard.A2", "Do");   // relabel
  await resolveFn(s, "setValue")(s, "keyboard.B2", 300);    // retune
  await settle(s);

  const row = slotItem(s, "piano").children.find((c) => c.tag === "div");
  const first = row.children.filter((c) => c.tag === "button")[0];
  assert.equal(first.children?.[0]?.text, "Do", "the key cap re-labeled from the sheet edit");
  assert.equal(first.events.click.payload, 300, "the key re-tuned from the sheet edit");
});
