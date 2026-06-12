import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../dist/index.js";

// sheet-host-cell-editing — the spreadsheet-style cell-editing affordances on a
// worksheet window:
//   1) a resizable formula bar under each window's titlebar, bound to 元.draft
//      for the window's editing cell (commits on Enter via origin.key);
//   2) a per-cell pencil ✎ (start editing a formula cell) / ✓ done (commit, back
//      to value) toggle;
//   3) a per-cell ? wiki glyph dispatching wiki.open with the cell key.

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

test("formula bar: renders the editing cell's draft and is bound to 元.draft", async () => {
  const { state, root, m } = await boot();
  // nothing editing → the bar shows an empty hint (no live value)
  assert.equal(String(fxInput(root, "turtles").attrs?.value ?? ""), "", "empty bar before editing");
  // edit a turtles cell → its source appears in the turtles window's formula bar
  await resolveFn(state, "origin.edit")(state, "turtles.B4"); m.run();
  const input = fxInput(root, "turtles");
  assert.equal(state.cels.get("元.draft")?.v, "75", "draft seeded from the cell source");
  assert.equal(String(input.attrs?.value ?? ""), "75", "the formula bar shows the editing cell's draft");
  // typing in the bar writes 元.draft (the SAME draft the inline editor uses)
  input.fire("input", { target: { value: "999" } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(state.cels.get("元.draft")?.v, "999", "editing in the bar updates 元.draft");
});

test("formula bar: Enter in the bar commits the draft (origin.key)", async () => {
  const { state, root, m } = await boot();
  await resolveFn(state, "origin.edit")(state, "turtles.B4"); m.run();
  await resolveFn(state, "setValue")(state, "元.draft", "4242");
  const input = fxInput(root, "turtles");
  input.fire("keydown", { key: "Enter", shiftKey: false, preventDefault() {} });
  await new Promise((r) => setTimeout(r, 0)); m.run();
  assert.equal(state.cels.get("turtles.B4")?.v, 4242, "Enter in the bar committed the cell");
  assert.equal(state.cels.get("元.editing")?.v, null, "editing exited after commit");
});

// ── 2) the pencil / view toggle ──────────────────────────────────────────────

test("pencil: a formula cell shows ✎ that dispatches origin.edit (start editing)", async () => {
  const { state, root, m } = await boot();
  // put a FORMULA in a turtles cell so it carries a pencil
  await resolveFn(state, "origin.edit")(state, "turtles.B4"); m.run();
  await resolveFn(state, "setValue")(state, "元.draft", "=1+1");
  await resolveFn(state, "origin.commit")(state, "turtles.B4"); m.run();
  const td = cellByKey(root, "turtles.B4");
  const pencil = byClass(td, "pl-cell-edit")[0];
  assert.ok(pencil, "a formula cell shows the ✎ pencil");
  assert.equal(txt(pencil), "✎", "the pencil glyph");
  assert.ok(!hasEditor(root, "turtles.B4"), "not editing yet");
  // clicking the pencil dispatches origin.edit (force) → the editor opens
  pencil.fire("click");
  await new Promise((r) => setTimeout(r, 0)); m.run();
  assert.equal(state.cels.get("元.editing")?.v, "turtles.B4", "the pencil started editing the cell");
  assert.ok(hasEditor(root, "turtles.B4"), "the editor opened");
});

test("pencil: a plain VALUE cell shows NO pencil (toggle is formula-only)", async () => {
  const { root } = await boot();
  const td = cellByKey(root, "turtles.B4"); // seeded value 75
  assert.equal(cellVal(root, "turtles.B4"), "75", "a value cell");
  assert.ok(!byClass(td, "pl-cell-edit")[0], "no pencil on a plain value cell");
});

test("view: the ✓ done button exits editing back to the value view (commits the draft)", async () => {
  const { state, root, m } = await boot();
  await resolveFn(state, "origin.edit")(state, "turtles.B4"); m.run();
  assert.ok(hasEditor(root, "turtles.B4"), "editing");
  await resolveFn(state, "setValue")(state, "元.draft", "321");
  const td = cellByKey(root, "turtles.B4");
  const done = byClass(td, "pl-cell-view")[0];
  assert.ok(done, "the editing cell shows a ✓ done button");
  done.fire("click");
  await new Promise((r) => setTimeout(r, 0)); m.run();
  assert.equal(state.cels.get("元.editing")?.v, null, "editing exited");
  assert.equal(state.cels.get("turtles.B4")?.v, 321, "the draft was committed (persisted)");
  assert.equal(cellVal(root, "turtles.B4"), "321", "back to the value view");
});

// ── 3) the wiki glyph ────────────────────────────────────────────────────────

test("wiki: a cell's ? glyph dispatches wiki.open with the cell key", async () => {
  const { state, root } = await boot();
  // spy on the live wiki.open handler (docgraph is a transitive dep of origin) by
  // capturing its payload — the contract is "dispatch wiki.open with the key".
  const cel = state.cels.get("wiki.open");
  assert.ok(cel, "wiki.open is registered (docgraph loaded)");
  let opened = null;
  const orig = cel._fn;
  cel._fn = (st, payload, ev) => { opened = payload; /* don't actually open the wiki window */ return st; };
  try {
    const td = cellByKey(root, "turtles.B4");
    const wiki = byClass(td, "pl-cell-wiki")[0];
    assert.ok(wiki, "the cell shows a ? wiki glyph");
    assert.equal(txt(wiki), "?", "the wiki glyph");
    wiki.fire("click");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(opened, "turtles.B4", "wiki.open dispatched with the cell key");
  } finally { cel._fn = orig; }
});

test("wiki: the formula bar carries a ? wiki affordance dispatching wiki.open for the editing cell", async () => {
  const { state, root, m } = await boot();
  await resolveFn(state, "origin.edit")(state, "turtles.B4"); m.run();
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
    assert.equal(opened, "turtles.B4", "the bar's wiki affordance dispatches wiki.open for the editing cell");
  } finally { cel._fn = orig; }
});
