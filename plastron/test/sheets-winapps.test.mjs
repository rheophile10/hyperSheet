import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, setPainter } from "../dist/index.js";

// sheets (native grid as content lambdas) + winapps (generic toolbars), and a sheet
// hosted as a `window` tab — proving the phase-2 split: sheet-unique rendering in
// `sheets`, app-agnostic toolbars in `winapps`, the frame in `window`.

const boot = async () => {
  const state = createInitialState();
  setPainter(state, { enqueue: () => {}, drain: () => {}, flush: () => {} });
  await resolveFn(state, "ensureSegments")(state, ["sheets", "winapps", "window", "dom"]);
  await resolveFn(state, "hydrate")(state, [], []);
  return state;
};
const walk = (n, p, out = []) => { if (n && typeof n === "object") { if (n.type === "el" && p(n)) out.push(n); for (const c of n.children ?? []) walk(c, p, out); } return out; };
const cls = (n, c) => new RegExp(`(^| )${c}( |$)`).test(String(n.attrs?.class ?? ""));
const byClass = (root, c) => walk(root, (n) => cls(n, c));
const byTag = (root, t) => walk(root, (n) => n.tag === t);
const vtxt = (n) => (n?.type === "text" ? n.text : (n?.children ?? []).map(vtxt).join(""));

const CELLS = [
  { key: "budget.A1", col: 0, row: 0, value: "Item" },  { key: "budget.B1", col: 1, row: 0, value: "Cost" },
  { key: "budget.A2", col: 0, row: 1, value: "Rent" },  { key: "budget.B2", col: 1, row: 1, value: 1800 },
  { key: "budget.A3", col: 0, row: 2, value: "Food" },  { key: "budget.B3", col: 1, row: 2, value: 420 },
];

test("sheetgrid renders an editable grid: label + column letters + row numbers + cell values", async () => {
  const state = await boot();
  const grid = resolveFn(state, "sheetgrid")("budget", CELLS);
  assert.equal(byTag(grid, "table").length, 1, "one table");
  assert.ok(vtxt(byClass(grid, "corner")[0]).includes("budget"), "corner shows the sheet label");
  const heads = byTag(grid, "th").map(vtxt);
  assert.ok(heads.includes("A") && heads.includes("B"), "column letters A, B");
  assert.ok(heads.includes("1") && heads.includes("3"), "row numbers 1..3");
  const cells = byClass(grid, "cell-value");
  assert.ok(cells.some((c) => vtxt(c) === "Rent") && cells.some((c) => vtxt(c) === "1800"), "cell values rendered");
  // a value cell dispatches select on click, edit on double-click
  const rent = cells.find((c) => vtxt(c) === "Rent");
  assert.equal(rent.events?.click?.dispatch, "origin.select");
  assert.equal(rent.events?.dblclick?.dispatch, "origin.edit");
});

test("the ACTIVE cell shows an inline editor bound to the draft cel", async () => {
  const state = await boot();
  const grid = resolveFn(state, "sheetgrid")("budget", CELLS, { active: "budget.B2", draft: "元.draft" });
  const ta = byTag(grid, "textarea");
  assert.equal(ta.length, 1, "exactly one editor (the active cell)");
  assert.equal(ta[0].attrs["data-key"], "budget.B2", "editor is on the active cell");
  assert.equal(ta[0].events?.input?.set, "元.draft", "typing writes the draft cel");
});

test("sheetcell renders a value, and a vnode value renders in place", async () => {
  const state = await boot();
  assert.equal(vtxt(resolveFn(state, "sheetcell")(42)), "42", "scalar → text");
  const widget = resolveFn(state, "dom")("canvas.chart");
  assert.equal(resolveFn(state, "sheetcell")(widget), widget, "a vnode value renders as itself");
});

test("winapps toolbar: toolbtn dispatches; toolbar rows them up", async () => {
  const state = await boot();
  const save = resolveFn(state, "toolbtn")("💾", "save", "sheet.save", "budget");
  const bar = resolveFn(state, "toolbar")(save, resolveFn(state, "toolbtn")("📁", "open", "sheet.open"));
  assert.ok(cls(bar, "pl-apptoolbar"), "a toolbar row");
  const btns = byClass(bar, "pl-toolbtn");
  assert.equal(btns.length, 2, "two buttons");
  assert.equal(btns[0].events?.click?.dispatch, "sheet.save");
  assert.equal(btns[0].events?.click?.payload, "budget");
  assert.equal(btns[0].events?.pointerdown?.dispatch, "window.stop", "toolbtn won't start a window drag");
});

test("a sheet grid is hosted as a window TAB (content-agnostic frame), tabbable with another app", async () => {
  const state = await boot();
  const REF = "win.budget.state";
  await resolveFn(state, "setCel")(state, REF, {
    celType: "ValueCel", metadata: { key: REF, segment: "budget" },
    v: { ref: REF, x: 80, y: 60, w: 520, h: 360, z: 3, min: 0, max: 0, closed: 0,
         tabs: [{ ref: "budget.view", title: "Budget", icon: "▦" }, { ref: "wasm.doom.content", title: "DOOM", icon: "🐢" }], active: 0 },
  });
  // build the sheet content with a toolbar above the grid (winapps + sheets together)
  const toolbar = resolveFn(state, "toolbar")(resolveFn(state, "toolbtn")("💾", "save", "sheet.save", "budget"));
  const grid = resolveFn(state, "sheetgrid")("budget", CELLS);
  const sheetContent = resolveFn(state, "dom")("div.sheet-app", toolbar, grid);
  const doomContent = resolveFn(state, "dom")("div.doom", "DOOM");

  const frame = resolveFn(state, "wframe")(state.cels.get(REF).v, REF, sheetContent, doomContent);
  assert.equal(byClass(frame, "pl-window").length, 1, "one window frame");
  assert.equal(byClass(frame, "pl-tab").length, 2, "two tabs — the sheet and DOOM in one frame");
  assert.equal(byTag(frame, "table").length, 1, "the native grid is hosted inside the window body");
  assert.equal(byClass(frame, "pl-apptoolbar").length, 1, "the winapps toolbar renders above the grid");
  assert.equal(byClass(frame, "doom").length, 0, "the inactive DOOM tab's content is not rendered");
});
