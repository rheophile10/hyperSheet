import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, setPainter } from "../dist/index.js";

// wbframe — the WORKBOOK frame: two tab stacks at once (worksheets ‖ dom views)
// split by a draggable divider, with per-pane fullscreen. State on the window cel:
// { …geom…, sheets:[Tab], asheet, views:[Tab], aview, split, full }. Realizes the
// sheetapp workbook DoD (multi-sheet + dom views + fullscreen toggle).

const boot = async () => {
  const state = createInitialState();
  setPainter(state, { enqueue: () => {}, drain: () => {}, flush: () => {} });
  await resolveFn(state, "ensureSegments")(state, ["window", "dom"]);
  await resolveFn(state, "hydrate")(state, [], []);
  return state;
};

const walk = (n, p, out = []) => { if (n && typeof n === "object") { if (n.type === "el" && p(n)) out.push(n); for (const c of n.children ?? []) walk(c, p, out); } return out; };
const cls = (n, c) => new RegExp(`(^| )${c}( |$)`).test(String(n.attrs?.class ?? ""));
const byClass = (root, c) => walk(root, (n) => cls(n, c));
const vtxt = (n) => (n?.type === "text" ? n.text : (n?.children ?? []).map(vtxt).join(""));

const REF = "win.book.state";
const el = (tag, attrs, children) => ({ type: "el", tag, attrs: attrs ?? {}, children: children ?? [] });
const seed = async (state, patch = {}) => {
  await resolveFn(state, "setCel")(state, REF, {
    celType: "ValueCel",
    v: { ref: REF, x: 100, y: 70, w: 760, h: 500, z: 5, min: 0, max: 0, closed: 0, title: "Book",
         sheets: [{ ref: "data.view", title: "Data" }, { ref: "calc.view", title: "Calc" }], asheet: 0,
         views: [{ ref: "dash.view", title: "Dashboard" }, { ref: "report.view", title: "Report" }], aview: 0,
         split: 0.6, full: "", ...patch },
    metadata: { key: REF, segment: "book" },
  });
};
const st = (state) => state.cels.get(REF)?.v;
// contents: sheets first (Data, Calc), then views (Dashboard, Report)
const SHEET_A = el("div", { class: "sheetA" }, [{ type: "text", text: "DATA-GRID" }]);
const SHEET_B = el("div", { class: "sheetB" }, [{ type: "text", text: "CALC-GRID" }]);
const VIEW_A = el("canvas", { class: "dashA" }, [{ type: "text", text: "DASH" }]);
const VIEW_B = el("div", { class: "reportB" }, [{ type: "text", text: "REPORT" }]);
const wbframe = (state, active = REF) => resolveFn(state, "wbframe")(st(state), active, SHEET_A, SHEET_B, VIEW_A, VIEW_B);
const fire = (state, verb, payload, event) => resolveFn(state, verb)(state, payload, event);

test("wbopen genesis: state holds both tab stacks + a frame referencing every content cel", async () => {
  const state = await boot();
  const g = resolveFn(state, "wbopen")("book", "My Book",
    [{ ref: "data.view", title: "Data" }, { ref: "calc.view", title: "Calc" }],
    [{ ref: "dash.view", title: "Dashboard" }],
    { __geom: { x: 120, y: 60, w: 800, h: 520 } });
  assert.equal(g.genesis, true);
  const wb = g.cels["win.book.state"].v;
  assert.equal(wb.sheets.length, 2, "two worksheet tabs");
  assert.equal(wb.views.length, 1, "one dom-view tab");
  assert.deepEqual([wb.w, wb.h], [800, 520], "geometry from where");
  const frame = g.cels["win.book.frame"].f;
  for (const ref of ["data.view", "calc.view", "dash.view"]) assert.ok(frame.includes(ref), `frame references ${ref}`);
  assert.ok(frame.startsWith('(mount ".origin" (wbframe win.book.state win.active'), "self-mounting wbframe");
});

test("wbframe renders BOTH panes: sheet tabs + view tabs both at the BOTTOM (same row class), active bodies", async () => {
  const state = await boot();
  await seed(state);
  const v = wbframe(state);
  // both panes present
  assert.equal(byClass(v, "pl-wb-left").length, 1, "left (sheets / celBook) pane");
  assert.equal(byClass(v, "pl-wb-right").length, 1, "right (views / cardBook) pane");
  assert.equal(byClass(v, "pl-wb-divider").length, 1, "divider shown when not fullscreen");
  // both tab rows use the same class now (bottom tabs, same look); [0]=sheets, [1]=views
  const rows = byClass(v, "pl-wb-stabs");
  const stabs = rows[0];
  const vtabs = rows[1];
  assert.ok(vtxt(stabs).includes("Data") && vtxt(stabs).includes("Calc"), "sheet tab chips");
  assert.ok(vtabs && vtxt(vtabs).includes("Dashboard") && vtxt(vtabs).includes("Report"), "view tab chips");
  // active sheet + active view bodies rendered
  assert.equal(byClass(v, "sheetA").length, 1, "active sheet (Data) body");
  assert.equal(byClass(v, "dashA").length, 1, "active view (Dashboard) body");
  assert.equal(byClass(v, "sheetB").length, 0, "inactive sheet not rendered");
});

test("window.sheetTab / window.viewTab switch the active pane bodies", async () => {
  const state = await boot();
  await seed(state);
  await fire(state, "window.sheetTab", { ref: REF, index: 1 });
  assert.equal(st(state).asheet, 1, "asheet advanced");
  assert.equal(byClass(wbframe(state), "sheetB").length, 1, "Calc sheet now rendered");
  await fire(state, "window.viewTab", { ref: REF, index: 1 });
  assert.equal(st(state).aview, 1, "aview advanced");
  assert.equal(byClass(wbframe(state), "reportB").length, 1, "Report view now rendered");
});

test("window.paneFull fullscreens one pane, hides the other + the divider, and toggles back", async () => {
  const state = await boot();
  await seed(state);
  await fire(state, "window.paneFull", { ref: REF, pane: "R" });
  assert.equal(st(state).full, "R");
  let v = wbframe(state);
  assert.equal(byClass(v, "pl-wb-divider").length, 0, "no divider when fullscreen");
  assert.equal(byClass(v, "dashA").length, 1, "view pane still rendered (fullscreen)");
  // toggling the same pane returns to see-both
  await fire(state, "window.paneFull", { ref: REF, pane: "R" });
  assert.equal(st(state).full, "", "toggled back to see-both");
  assert.equal(byClass(wbframe(state), "pl-wb-divider").length, 1, "divider back");
});

test("window.splitGrab + splitMove resize the divider (fraction across the window, clamped)", async () => {
  const state = await boot();
  await seed(state);
  await fire(state, "window.splitGrab", REF, { clientX: 0 });
  // window x=100, w=760 → clientX 480 → frac ≈ 0.5
  await fire(state, "window.splitMove", null, { clientX: 480 });
  assert.ok(Math.abs(st(state).split - 0.5) < 0.02, `split ~0.5 (got ${st(state).split})`);
  // clamp: far left → 0.15 floor
  await fire(state, "window.splitMove", null, { clientX: 0 });
  assert.equal(st(state).split, 0.15, "clamped to 0.15");
});
