import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../dist/index.js";

// sheet-host-cell-editing — the Excel-model selection + formula-bar editing on a
// worksheet window:
//   1) single-click SELECTS a cell (元.selected) and the cell KEEPS its VALUE;
//      the window's resizable formula bar shows the SELECTED cell's source (bound
//      to 元.draft) and commits on Enter (origin.key) to 元.selected;
//   2) double-click opens the inline editor;
//   3) the bar's LEFT 🔫 button FIRES (re-evaluates) the selected cell;
//   4) cells render clean — NO per-cell ✎/? glyphs;
//   5) the titlebar shows exactly one of ◱ (mid, when maximized) / ⛶ (maximize).

const mkEl = (tag) => {
  const L = new Map();
  const el = {
    nodeType: 1, tag, tagName: tag.toUpperCase(), value: undefined, childNodes: [], attrs: {},
    style: { props: {}, setProperty(p, v) { this.props[p] = v; }, removeProperty(p) { delete this.props[p]; } },
    get firstChild() { return this.childNodes[0] ?? null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; },
    setAttribute(n, v) { this.attrs[n] = v; }, removeAttribute(n) { delete this.attrs[n]; },
    appendChild(c) { this.childNodes.push(c); return c; },
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; },
    replaceChild(n, o) { const i = this.childNodes.indexOf(o); if (i >= 0) this.childNodes[i] = n; return o; },
    insertBefore(n, r) { const i = r ? this.childNodes.indexOf(r) : -1; if (i >= 0) this.childNodes.splice(i, 0, n); else this.childNodes.push(n); return n; },
    replaceChildren(...c) { this.childNodes = [...c]; },
    addEventListener(t, fn) { (L.get(t) ?? L.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { L.get(t)?.delete(fn); },
    fire(t, ev = {}) { for (const fn of [...(L.get(t) ?? [])]) fn({ type: t, target: el, currentTarget: el, ...ev }); },
  };
  return el;
};
const walk = (n, p, o = []) => { if (n?.nodeType === 1) { if (p(n)) o.push(n); for (const c of n.childNodes) walk(c, p, o); } return o; };
const txt = (n) => (n.nodeType === 3 ? n.data : (n.childNodes ?? []).map(txt).join(""));
const hasClass = (n, c) => new RegExp(`(^| )${c}( |$)`).test(String(n.attrs?.class ?? ""));
const byClass = (root, c) => walk(root, (n) => hasClass(n, c));
const cellByKey = (root, key) => walk(root, (n) => (n.tag === "div" || n.tag === "td") && hasClass(n, "cell") && n.attrs["data-key"] === key)[0];
const cellVal = (root, key) => { const c = cellByKey(root, key); const v = c && walk(c, (n) => String(n.attrs?.class ?? "") === "cell-value")[0]; return v ? txt(v).replace("⤢", "").trim() : ""; };
const hasEditor = (root, key) => { const c = cellByKey(root, key); return !!(c && walk(c, (n) => n.tag === "textarea")[0]); };
const windowOf = (root, seg) => walk(root, (n) => hasClass(n, "pl-window") && n.attrs["data-win"] === seg)[0];
const fxbarOf = (root, seg) => { const w = windowOf(root, seg); return w && byClass(w, "pl-fxbar")[0]; };
const fxInput = (root, seg) => { const bar = fxbarOf(root, seg); return bar && walk(bar, (n) => n.tag === "textarea")[0]; };
const mockRaf = () => { const q = []; return { raf: (cb) => q.push(cb), caf: () => {}, run: () => { for (const cb of q.splice(0)) cb(); } }; };

const boot = async () => {
  const root = mkEl("app");
  globalThis.document = {
    createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }),
    querySelector: (s) => (s === "#app" ? root : null),
    addEventListener() {}, removeEventListener() {},
  };
  const m = mockRaf();
  const state = createInitialState();
  setPainter(state, createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: true, doc: globalThis.document, resolveMount: (x) => (x === "#app" ? root : null) }));
  await resolveFn(state, "ensureSegments")(state, ["origin"]);
  await resolveFn(state, "hydrate")(state, [], []);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "origin.commit")(state, "元"); // boot genesis: turtles + turtlecharts materialize
  await resolveFn(state, "drain")(state, "dom.paint");
  m.run();
  return { state, root, m };
};

// ── 1) the formula bar ───────────────────────────────────────────────────────

test("formula bar: every worksheet window has a resizable formula bar (resize:vertical)", async () => {
  const { root } = await boot();
  const bar = fxbarOf(root, "turtles");
  assert.ok(bar, "the turtles window has a formula bar");
  const input = fxInput(root, "turtles");
  assert.ok(input, "the formula bar holds an editable textarea control");
  assert.match(String(input.attrs?.style ?? ""), /resize:\s*vertical/, "the bar control is vertically resizable");
  assert.match(String(input.attrs?.style ?? ""), /box-sizing:\s*border-box/, "the bar control is border-box (resizes cleanly)");
});

test("formula bar: uncapped resize (no max-height) so it can fill the window", async () => {
  const { root } = await boot();
  const input = fxInput(root, "turtles");
  assert.ok(!/max-height/.test(String(input.attrs?.style ?? "")), "the bar control has NO max-height cap");
});

// ── 1) SELECTION — single-click selects, value stays, bar shows source ────────

test("selection: single-click SELECTS a cell and the cell KEEPS rendering its value", async () => {
  const { state, root, m } = await boot();
  assert.equal(cellVal(root, "turtles.B4"), "75", "B4 shows its value before selection");
  // single-clicking the cell value SELECTS (origin.select) — it must NOT open the editor
  const td = cellByKey(root, "turtles.B4");
  const value = byClass(td, "cell-value")[0];
  value.fire("click");
  await new Promise((r) => setTimeout(r, 0)); m.run();
  assert.equal(state.cels.get("元.selected")?.v, "turtles.B4", "the cell is now selected");
  assert.equal(state.cels.get("元.editing")?.v, null, "selection does NOT enter inline editing");
  assert.ok(!hasEditor(root, "turtles.B4"), "no editor swapped in — the value stays");
  assert.equal(cellVal(root, "turtles.B4"), "75", "the cell STILL renders its value after selection");
  // double-clicking opens the inline editor
  const td2 = cellByKey(root, "turtles.B4");
  const value2 = byClass(td2, "cell-value")[0];
  value2.fire("dblclick");
  await new Promise((r) => setTimeout(r, 0)); m.run();
  assert.equal(state.cels.get("元.editing")?.v, "turtles.B4", "double-click opened the inline editor");
});

test("formula bar: shows the SELECTED cell's source and is bound to 元.draft", async () => {
  const { state, root, m } = await boot();
  // nothing selected → the bar shows an empty hint (no live value)
  assert.equal(String(fxInput(root, "turtles").attrs?.value ?? ""), "", "empty bar before selection");
  // select a turtles cell → its source appears in the turtles window's formula bar
  await resolveFn(state, "origin.select")(state, "turtles.B4"); m.run();
  const input = fxInput(root, "turtles");
  assert.equal(state.cels.get("元.draft")?.v, "75", "draft seeded from the selected cell's source");
  assert.equal(String(input.attrs?.value ?? ""), "75", "the formula bar shows the selected cell's source");
  // typing in the bar writes 元.draft
  input.fire("input", { target: { value: "999" } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(state.cels.get("元.draft")?.v, "999", "editing in the bar updates 元.draft");
});

test("formula bar: Enter in the bar commits the draft to the SELECTED cell (origin.key)", async () => {
  const { state, root, m } = await boot();
  await resolveFn(state, "origin.select")(state, "turtles.B4"); m.run();
  await resolveFn(state, "setValue")(state, "元.draft", "4242");
  const input = fxInput(root, "turtles");
  input.fire("keydown", { key: "Enter", shiftKey: false, preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0)); m.run();
  assert.equal(state.cels.get("turtles.B4")?.v, 4242, "Enter in the bar committed the selected cell");
  assert.equal(state.cels.get("元.selected")?.v, "turtles.B4", "selection stays on the committed cell");
});

// ── 2) double-click opens the inline editor ──────────────────────────────────

test("double-click: opens the inline editor for the cell", async () => {
  const { state, root, m } = await boot();
  assert.ok(!hasEditor(root, "turtles.B4"), "not editing yet");
  await resolveFn(state, "origin.edit")(state, "turtles.B4"); m.run();
  assert.equal(state.cels.get("元.editing")?.v, "turtles.B4", "the cell is now editing");
  assert.ok(hasEditor(root, "turtles.B4"), "the inline editor opened");
});

// ── 3) the fire (🔫) button ──────────────────────────────────────────────────

test("fire: the bar's LEFT 🔫 button dispatches origin.fire for the selected cell", async () => {
  const { state, root, m } = await boot();
  await resolveFn(state, "origin.select")(state, "turtles.B4"); m.run();
  const bar = fxbarOf(root, "turtles");
  const fire = byClass(bar, "pl-fxbar-fire")[0];
  assert.ok(fire, "the formula bar has a 🔫 fire button on the left");
  assert.equal(txt(fire), "🔫", "the fire glyph");
  // spy on origin.fire — clicking the button must dispatch it with the selected key
  const cel = state.cels.get("origin.fire");
  let fired = null;
  const orig = cel._fn;
  cel._fn = (st, payload) => { fired = payload; return st; };
  try {
    fire.fire("click");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(fired, "turtles.B4", "the 🔫 button dispatches origin.fire with the selected cell key");
  } finally { cel._fn = orig; }
  // there is NO ƒx label any more
  assert.ok(!byClass(bar, "pl-fxbar-label")[0], "the ƒx label is gone (replaced by 🔫)");
});

test("fire: origin.fire re-evaluates a formula cell", async () => {
  const { state, m } = await boot();
  // make B4 a formula referencing another cel, select + fire → re-evaluates
  await resolveFn(state, "origin.edit")(state, "turtles.B4"); m.run();
  await resolveFn(state, "setValue")(state, "元.draft", "=1+1");
  await resolveFn(state, "origin.commit")(state, "turtles.B4"); m.run();
  assert.equal(state.cels.get("turtles.B4")?.v, 2, "formula committed → 2");
  await resolveFn(state, "origin.select")(state, "turtles.B4"); m.run();
  await resolveFn(state, "origin.fire")(state); m.run();
  assert.equal(state.cels.get("turtles.B4")?.v, 2, "fire re-evaluated the formula (still 2)");
  assert.ok((state.cels.get("turtles.B4")).f, "the cell stays a FormulaCel after firing");
});

// ── 4) no per-cell glyphs ─────────────────────────────────────────────────────

test("glyphs: cells render clean — NO per-cell ✎/✓/? glyphs", async () => {
  const { state, root, m } = await boot();
  // a plain value cell
  let td = cellByKey(root, "turtles.B4");
  assert.ok(!byClass(td, "pl-cell-edit")[0], "no per-cell pencil");
  assert.ok(!byClass(td, "pl-cell-wiki")[0], "no per-cell wiki glyph");
  assert.ok(!byClass(td, "pl-cell-view")[0], "no per-cell done glyph");
  assert.ok(!byClass(td, "pl-cell-glyphs")[0], "no glyph cluster");
  // also true for a FORMULA cell (used to carry a pencil)
  await resolveFn(state, "origin.edit")(state, "turtles.B4"); m.run();
  await resolveFn(state, "setValue")(state, "元.draft", "=1+1");
  await resolveFn(state, "origin.commit")(state, "turtles.B4"); m.run();
  td = cellByKey(root, "turtles.B4");
  assert.ok(!byClass(td, "pl-cell-edit")[0], "no pencil even on a formula cell");
  assert.ok(!byClass(td, "pl-cell-glyphs")[0], "no glyph cluster on a formula cell");
});

test("cell value: selection does NOT inject text into .cell-value", async () => {
  const { state, root, m } = await boot();
  await resolveFn(state, "origin.select")(state, "turtles.B4"); m.run();
  assert.equal(cellVal(root, "turtles.B4"), "75", ".cell-value still holds only the value (no glyph text)");
});

// ── 5) the bar's wiki affordance ─────────────────────────────────────────────

test("wiki: the formula bar carries a ? wiki affordance dispatching wiki.open for the selected cell", async () => {
  const { state, root, m } = await boot();
  await resolveFn(state, "origin.select")(state, "turtles.B4"); m.run();
  const cel = state.cels.get("wiki.open");
  let opened = null;
  const orig = cel._fn;
  cel._fn = (st, payload) => { opened = payload; return st; };
  try {
    const bar = fxbarOf(root, "turtles");
    const wiki = byClass(bar, "pl-fxbar-wiki")[0];
    assert.ok(wiki, "the formula bar has a ? wiki affordance");
    wiki.fire("click");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(opened, "turtles.B4", "the bar's wiki affordance dispatches wiki.open for the selected cell");
  } finally { cel._fn = orig; }
});

// ── 6) the max / mid titlebar toggle ─────────────────────────────────────────

const winBtns = (root, seg) => { const w = windowOf(root, seg); return w ? byClass(w, "pl-win-btn") : []; };

test("max/mid toggle: a non-maximized window shows ⛶ (maximize) and NOT ◱", async () => {
  const { root } = await boot();
  const glyphs = winBtns(root, "turtles").map(txt);
  assert.ok(glyphs.includes("⛶"), "shows ⛶ maximize when not maximized");
  assert.ok(!glyphs.includes("◱"), "does NOT also show ◱");
});

test("max/mid toggle: a maximized window shows ◱ (mid) and NOT ⛶", async () => {
  const { state, root, m } = await boot();
  await resolveFn(state, "winsheet.maximize")(state, "turtles"); m.run();
  assert.equal(state.cels.get("win.geom")?.v?.turtles?.max, 1, "win.geom[turtles].max set");
  const glyphs = winBtns(root, "turtles").map(txt);
  assert.ok(glyphs.includes("◱"), "shows ◱ mid when maximized");
  assert.ok(!glyphs.includes("⛶"), "does NOT also show ⛶");
  // mid clears it again → back to ⛶
  await resolveFn(state, "winsheet.mid")(state, "turtles"); m.run();
  assert.ok(!state.cels.get("win.geom")?.v?.turtles?.max, "mid cleared the max flag");
  const after = winBtns(root, "turtles").map(txt);
  assert.ok(after.includes("⛶") && !after.includes("◱"), "back to ⛶ after mid");
});
