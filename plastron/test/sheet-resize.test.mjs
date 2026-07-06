import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, setPainter } from "../dist/index.js";

// Excel-style row/column resize for the sheet grid (library/sheets).
//
// Sizes are DATA: sparse per-sheet dicts in `<seg>.colw` ({"B":120}) and
// `<seg>.rowh` ({"2":44}) ValueCels — minted lazily on first resize, owned by
// the sheet's segment (so they archive with the document). sheetgrid takes
// them as OPTIONAL trailing args (label, cells, opts?, dims?, colw?, rowh?);
// headers grow drag handles that dispatch sheet.resizeGrab/Move/Drop (the
// window.drag pattern), dblclick → sheet.resizeReset. Because a formula
// authored before the size cel existed can't reference it, the first grab
// REWRITES the grid formula tail (dims, colw, rowh — absent → 0), after which
// every size write cascades through the graph like any other cel.

const boot = async () => {
  const state = createInitialState();
  setPainter(state, { enqueue: () => {}, drain: () => {}, flush: () => {} });
  await resolveFn(state, "ensureSegments")(state, ["sheets", "sheet", "dom"]);
  await resolveFn(state, "hydrate")(state, [], []);
  return state;
};

const walk = (n, p, out = []) => { if (n && typeof n === "object") { if (n.type === "el" && p(n)) out.push(n); for (const c of n.children ?? []) walk(c, p, out); } return out; };
const cls = (n, c) => new RegExp(`(^| )${c}( |$)`).test(String(n.attrs?.class ?? ""));
const byClass = (root, c) => walk(root, (n) => cls(n, c));
const byAttr = (root, a, v) => walk(root, (n) => String(n.attrs?.[a]) === v);
const style = (n) => String(n?.attrs?.style ?? "");

const CELLS = [
  { key: "t1.A1", col: 0, row: 0, value: "Item" }, { key: "t1.B1", col: 1, row: 0, value: "Cost" },
  { key: "t1.A2", col: 0, row: 1, value: "Rent" }, { key: "t1.B2", col: 1, row: 1, value: 1800 },
];

// ── the renderer: sizes ride the vnode ───────────────────────────────────────

test("sheetgrid applies colw/rowh overrides and leaves untouched columns/rows at defaults", async () => {
  const state = await boot();
  const grid = resolveFn(state, "sheetgrid")("t1", CELLS, {}, { rows: 3, cols: 3 }, { B: 120 }, { 2: 44 });
  // column B pinned hard: width+min+max, border-box (the table can't stretch it back)
  const thB = byAttr(grid, "data-col", "B")[0];
  assert.ok(/width:120px;min-width:120px;max-width:120px;box-sizing:border-box/.test(style(thB)), `th B carries the 120px pin (${style(thB)})`);
  const tdB1 = byAttr(grid, "data-key", "t1.B1")[0];
  assert.ok(/width:120px/.test(style(tdB1)), "td B1 carries the width");
  // column A stays default
  const tdA1 = byAttr(grid, "data-key", "t1.A1")[0];
  assert.ok(/min-width:4\.5rem/.test(style(tdA1)) && !/width:\d+px/.test(style(tdA1)), "td A1 keeps the default min-width");
  // row 2 carries the height on the row header AND its cells; the cell inner
  // drops its default min-height so the row can shrink
  const rn2 = byAttr(grid, "data-row", "2")[0];
  assert.ok(/height:44px/.test(style(rn2)), "row-2 header carries the height");
  const tdA2 = byAttr(grid, "data-key", "t1.A2")[0];
  assert.ok(/height:44px/.test(style(tdA2)), "td A2 carries the height");
  assert.ok(/min-height:0/.test(style(byClass(tdA2, "cell-value")[0])), "row-sized cell inner drops the stock min-height");
  const tdA1inner = byClass(tdA1, "cell-value")[0];
  assert.ok(!/min-height:0/.test(style(tdA1inner)), "default rows keep the stock cell min-height");
});

test("headers grow resize handles wired to the sheet.resize* verbs; a label-less grid grows none", async () => {
  const state = await boot();
  const grid = resolveFn(state, "sheetgrid")("t1", CELLS, {}, { rows: 3, cols: 3 });
  const colHandles = byClass(grid, "col-resize");
  const rowHandles = byClass(grid, "row-resize");
  assert.equal(colHandles.length, 3, "one handle per column header");
  assert.equal(rowHandles.length, 3, "one handle per row header");
  const hB = colHandles.find((h) => h.attrs["data-col"] === "B");
  assert.deepEqual(hB.events?.pointerdown, { dispatch: "sheet.resizeGrab", payload: { seg: "t1", kind: "col", key: "B" } });
  assert.equal(hB.events?.pointermove?.dispatch, "sheet.resizeMove");
  assert.equal(hB.events?.pointerup?.dispatch, "sheet.resizeDrop");
  assert.deepEqual(hB.events?.dblclick, { dispatch: "sheet.resizeReset", payload: { seg: "t1", kind: "col", key: "B" } });
  assert.ok(/cursor:col-resize/.test(style(hB)), "col handle shows the col-resize cursor");
  const h2 = rowHandles.find((h) => h.attrs["data-row"] === "2");
  assert.deepEqual(h2.events?.pointerdown?.payload, { seg: "t1", kind: "row", key: "2" });
  assert.ok(/cursor:row-resize/.test(style(h2)), "row handle shows the row-resize cursor");
  // graceful absence: no label → no segment to write → no handles; 0-placeholder
  // size args (the formula tail's "absent" form) render clean
  const bare = resolveFn(state, "sheetgrid")("", CELLS, 0, 0, 0, 0);
  assert.equal(byClass(bare, "col-resize").length, 0, "label-less grid has no handles");
});

// ── the verbs: lazy mint + formula rewrite + live drag + clamp + reset ────────

const GRID_KEY = "t1grid.view";
const gridFormula = "=sheetpane(0, sheetgrid('t1', 0, gridopts(0, 0), t1.dims))";

const wire = async (state) => {
  await resolveFn(state, "setCel")(state, "t1.dims", {
    celType: "ValueCel", v: { rows: 3, cols: 3 }, metadata: { key: "t1.dims", segment: "t1", name: "dims" },
  });
  await resolveFn(state, "setCel")(state, GRID_KEY, {
    celType: "FormulaCel", f: gridFormula, metadata: { key: GRID_KEY, segment: "t1grid", name: "view", parser: "infix" },
  });
  await resolveFn(state, "runCycle")(state);
};

test("resizeGrab mints <seg>.colw lazily (owned by the sheet's segment) and rewrites the grid formula tail", async () => {
  const state = await boot();
  await wire(state);
  assert.equal(state.cels.get("t1.colw"), undefined, "no size cel before the first resize");
  await resolveFn(state, "sheet.resizeGrab")(state, { seg: "t1", kind: "col", key: "B" }, { clientX: 100, pointerId: 1 });
  const cw = state.cels.get("t1.colw");
  assert.ok(cw, "t1.colw minted on first grab");
  assert.equal(cw.metadata.segment, "t1", "size cel belongs to the SHEET's segment (archives with the doc)");
  assert.deepEqual(cw.v, {}, "minted empty — nothing overridden yet");
  // the grid formula now references the size cels that exist (dims, colw; rowh → 0)
  const f = state.cels.get(GRID_KEY).f;
  assert.ok(f.includes("gridopts(0, 0), t1.dims, t1.colw, 0)"), `formula tail rewritten (${f})`);
  // the drag snapshot
  const d = state.cels.get("sheet.resizedrag").v;
  assert.deepEqual(d, { seg: "t1", kind: "col", key: "B", p0: 100, size0: 72 }, "drag holds start pos + default start size");
});

test("resizeMove writes the size LIVE, clamps at the 24px column minimum, drop ends the drag", async () => {
  const state = await boot();
  await wire(state);
  await resolveFn(state, "sheet.resizeGrab")(state, { seg: "t1", kind: "col", key: "B" }, { clientX: 100 });
  await resolveFn(state, "sheet.resizeMove")(state, null, { clientX: 148 });
  assert.deepEqual(state.cels.get("t1.colw").v, { B: 120 }, "72 + 48 = 120");
  await resolveFn(state, "sheet.resizeMove")(state, null, { clientX: -900 });
  assert.deepEqual(state.cels.get("t1.colw").v, { B: 24 }, "clamped at the 24px column floor");
  // the write cascaded through the graph: the grid formula references t1.colw,
  // so the rendered vnode carries the new width WITHOUT any manual re-render
  const thB = byAttr(state.cels.get(GRID_KEY).v, "data-col", "B")[0];
  assert.ok(/width:24px/.test(style(thB)), `grid vnode re-derived with the width (${style(thB)})`);
  await resolveFn(state, "sheet.resizeDrop")(state);
  assert.equal(state.cels.get("sheet.resizedrag").v, null, "drop clears the drag");
  await resolveFn(state, "sheet.resizeMove")(state, null, { clientX: 500 });
  assert.deepEqual(state.cels.get("t1.colw").v, { B: 24 }, "moves after drop are no-ops");
});

test("row resize: 16px floor, vnode carries the height, dblclick reset returns the row to default", async () => {
  const state = await boot();
  await wire(state);
  await resolveFn(state, "sheet.resizeGrab")(state, { seg: "t1", kind: "row", key: "2" }, { clientY: 10 });
  assert.equal(state.cels.get("t1.rowh").metadata.segment, "t1");
  assert.ok(state.cels.get(GRID_KEY).f.includes("t1.dims, 0, t1.rowh)"), "tail references rowh (colw absent → 0)");
  await resolveFn(state, "sheet.resizeMove")(state, null, { clientY: 30 });
  assert.deepEqual(state.cels.get("t1.rowh").v, { 2: 50 }, "30 + 20 = 50");
  await resolveFn(state, "sheet.resizeMove")(state, null, { clientY: -900 });
  assert.deepEqual(state.cels.get("t1.rowh").v, { 2: 16 }, "clamped at the 16px row floor");
  await resolveFn(state, "sheet.resizeDrop")(state);
  let td = byAttr(state.cels.get(GRID_KEY).v, "data-key", "t1.A2")[0];
  assert.ok(/height:16px/.test(style(td)), "grid vnode carries the row height");
  await resolveFn(state, "sheet.resizeReset")(state, { seg: "t1", kind: "row", key: "2" });
  assert.deepEqual(state.cels.get("t1.rowh").v, {}, "reset removes the one override");
  td = byAttr(state.cels.get(GRID_KEY).v, "data-key", "t1.A2")[0];
  assert.ok(!/height:16px/.test(style(td)), "the row is back at its default height");
});

test("the size cels are plain data: a direct setValue re-renders the grid through the graph", async () => {
  const state = await boot();
  await wire(state);
  // wire the refs once (the lazy-mint path), then treat the cel as ordinary data
  await resolveFn(state, "sheet.resizeGrab")(state, { seg: "t1", kind: "col", key: "B" }, { clientX: 0 });
  await resolveFn(state, "sheet.resizeDrop")(state);
  await resolveFn(state, "setValue")(state, "t1.colw", { A: 64, B: 200 });
  const root = state.cels.get(GRID_KEY).v;
  assert.ok(/width:64px/.test(style(byAttr(root, "data-col", "A")[0])), "column A carries the formula-written width");
  assert.ok(/width:200px/.test(style(byAttr(root, "data-col", "B")[0])), "column B too — =t1.colw.B is inspectable, editable data");
  // second grab is idempotent: no re-mint, tail unchanged
  const f0 = state.cels.get(GRID_KEY).f;
  await resolveFn(state, "sheet.resizeGrab")(state, { seg: "t1", kind: "col", key: "A" }, { clientX: 0 });
  assert.equal(state.cels.get(GRID_KEY).f, f0, "re-grab leaves the rewritten formula alone");
  assert.deepEqual(state.cels.get("t1.colw").v, { A: 64, B: 200 }, "existing overrides survive");
});
