import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../dist/index.js";

// origin — the spreadsheet starting point (origin-segment.md, accepted).
// 元 is cell A1: put a formula/value, it executes and renders in place.
// grid() adds n×n cels, each like 元. A formula can also build dom.

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
    fire(t, ev = {}) { for (const fn of [...(L.get(t) ?? [])]) fn({ type: t, target: el, ...ev }); },
  };
  return el;
};
const walk = (n, p, o = []) => { if (n?.nodeType === 1) { if (p(n)) o.push(n); for (const c of n.childNodes) walk(c, p, o); } return o; };
const txt = (n) => (n.nodeType === 3 ? n.data : (n.childNodes ?? []).map(txt).join(""));
const cells = (root) => walk(root, (n) => (n.tag === "div" || n.tag === "td") && /(^| )cell( |$)/.test(String(n.attrs.class ?? "")) && n.attrs["data-key"]);
const cellByKey = (root, key) => cells(root).find((b) => b.attrs["data-key"] === key);
const cls = (root, c) => walk(root, (n) => String(n.attrs?.class ?? "") === c)[0];
const cellVal = (root, key) => { const c = cellByKey(root, key); const v = c && walk(c, (n)=>String(n.attrs?.class??"")==="cell-value")[0]; return v ? txt(v).replace("⤢","").trim() : ""; };
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
  await resolveFn(state, "drain")(state, "plastron-dom.paint");
  m.run();
  return { state, root, m };
};

const put = async (state, root, m, src, key = "元") => {
  await resolveFn(state, "origin.edit")(state, key); m.run();
  await resolveFn(state, "setValue")(state, "元.draft", src);
  await resolveFn(state, "origin.commit")(state, key);
  m.run();
};

test("boot: 元 holds a styled mount; the readme renders in the top region", async () => {
  const { state, root } = await boot();
  assert.deepEqual(cells(root).map((c) => c.attrs["data-key"]), ["元"], "one cell — 元");
  assert.equal(state.cels.get("元").v?.__mount, "top", "元's value is a mount placement");
  const rm = cls(root, "readme");
  assert.ok(rm, "readme rendered (in the region)");
  assert.ok(rm.style && Object.keys(rm.style.props).length > 0, "readme carries inline styles");
  assert.match(txt(rm), /every formula starts with =/);
});

test("A1 executes a formula: =1+1 shows 2; a literal 7 shows 7; clearing restores readme", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, "=1+1");
  assert.equal(state.cels.get("元").v, 2, "=1+1 -> 2 in A1");
  assert.equal(cellVal(root, "元"), "2", "A1 renders 2");
  await put(state, root, m, "7");
  assert.equal(cellVal(root, "元"), "7", "literal renders in A1");
  await put(state, root, m, "");
  assert.ok(cls(root, "readme"), "empty 元 -> readme back (un-deletable)");
  assert.equal(state.cels.get("元").v?.__mount, "top", "readme restored as a mount");
});

test("A1 can render a dom object", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, '(dom "h2" "hi")');
  assert.equal(state.cels.get("元").v?.tag, "h2", "A1 value is an <h2> vnode");
  assert.ok(walk(root, (n) => n.tag === "h2").length > 0, "h2 rendered in the cell");
});

test("=grid(3,3) makes a 3x3 worksheet of cels, each editable like 元", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, "=grid(3, 3)");
  for (const a of ["g3x3.A1", "g3x3.C3", "g3x3.B2"]) assert.ok(state.cels.get(a), `${a} created`);
  assert.equal(cells(root).length, 10, "A1 + 9 grid cels");
  assert.ok(cellByKey(root, "g3x3.A1"), "grid cell g3x3.A1 rendered");
  await put(state, root, m, "10", "g3x3.A1");
  await put(state, root, m, "=g3x3!A1*2", "g3x3.B1"); // cross-sheet ref into the grid's namespace
  assert.equal(state.cels.get("g3x3.B1").v, 20, "g3x3.B1 computes from g3x3!A1*2 (bare-A1 scoping is a follow-up)");
  await put(state, root, m, "");
  assert.equal(state.cels.get("g3x3.A1"), undefined, "grid swept when its formula is gone");
  assert.deepEqual(cells(root).map((c) => c.attrs["data-key"]), ["元"], "back to just A1");
});

test("a syntax error surfaces under the editor instead of doing nothing", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, '=grid("in" 4 3)'); // infix wants commas — this won't compile
  assert.match(String(state.cels.get("元.error").v ?? ""), /expected|infix|\)/, "the parse error is captured");
  assert.equal(state.cels.get("元.editing").v, "元", "stays in the cell so it can be fixed");
  assert.ok(walk(root, (n) => String(n.attrs?.class ?? "") === "cell-error")[0], "error line is rendered");
  // fixing it (commas) clears the error and commits
  await put(state, root, m, '=grid("in", 4, 3)');
  assert.equal(state.cels.get("元.error").v, null, "error cleared on a good commit");
  assert.ok(state.cels.get("in.A1"), "the corrected formula ran");
});

test("editing a cell label opens an input seeded with its source", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, "=2+3");
  await resolveFn(state, "origin.edit")(state, "元"); m.run();
  assert.equal(state.cels.get("元.editing").v, "元", "A1 marked editing");
  assert.equal(state.cels.get("元.draft").v, "=2+3", "draft seeded with the cell source");
  assert.ok(walk(root, (n) => n.tag === "input").length > 0, "input shown for the active cell");
});

test("=cels(sheet) lists a segment; unknown symbols show #NAME?", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, '=cels("sheet")');
  assert.match(String(state.cels.get("元").v), /infix/, "segment members listed");
  await put(state, root, m, "=nope(1)");
  assert.match(txt(cellByKey(root, "元")), /#NAME\?/, "undefined symbol shows #NAME?");
});

test("mount(region, content) places a dom in a region; deleting removes it", async () => {
  const { state, root, m } = await boot();
  const hello = () => walk(root, (n) => String(n.attrs?.class ?? "") === "hello")[0];
  await put(state, root, m, '(mount "top" (dom "h2.hello" "pinned"))'); // replaces 元's readme mount
  assert.ok(hello(), "dom placed in the region, not the cell");
  assert.match(txt(hello()), /pinned/);
  await put(state, root, m, ""); // clear 元 → readme mount restored
  assert.equal(hello(), undefined, "the pinned dom is gone with its formula");
});

test("mount(selector, content) splices under any element of the view (e.g. .sheet)", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, "=grid(3, 3)"); // gives the view a .sheet with cells + a grid
  await put(state, root, m, '(mount ".sheet" (dom "div.under" "below the cells"))', "g3x3.A1");
  const sheet = walk(root, (n) => String(n.attrs?.class ?? "") === "sheet")[0];
  assert.ok(sheet, "the .sheet node rendered");
  const under = walk(sheet, (n) => String(n.attrs?.class ?? "") === "under")[0];
  assert.ok(under, "the dom is spliced UNDER .sheet, not appended to a region");
  assert.match(txt(under), /below the cells/);
  await put(state, root, m, "", "g3x3.A1"); // clear the formula
  assert.equal(walk(root, (n) => String(n.attrs?.class ?? "") === "under")[0], undefined, "gone with its formula");
});

test("introspection: inspect / segments / vocab return readable values", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, "=42");                 // give A1 a known value first via a grid? no — inspect 元 itself
  await put(state, root, m, '=inspect("元")');
  const ins = String(state.cels.get("元").v);
  assert.match(ins, /^name: 元$/m, "inspect returns a readable yaml doc");
  assert.match(ins, /^type: FormulaCel/m, "shows the cel type");

  // a function cel (mount) inspects to signature + about + source (yaml)
  await put(state, root, m, '=inspect("mount")');
  const fnsrc = String(state.cels.get("元").v);
  assert.match(fnsrc, /^type: LockedLambdaCel \(locked, native\)$/m, "type with tags");
  assert.match(fnsrc, /^signature: \(target content\)$/m, "signature split out of the doc");
  assert.match(fnsrc, /^about: \|$/m, "about is a wrapped literal block");
  assert.match(fnsrc, /\nsource: /, "source comes last");
  assert.match(fnsrc, /__mount/, "shows the actual fn body");
  assert.match(fnsrc, /selector/, "shows the (updated) description");
  // multi-line value renders as a <pre> so it's not jumbled into one line
  assert.ok(walk(root, (n) => n.tag === "pre" && /cell-pre/.test(String(n.attrs?.class ?? "")))[0],
    "inspect output renders in a <pre>, not a flat text node");

  await put(state, root, m, "=segments()");
  assert.match(String(state.cels.get("元").v), /origin/, "segments lists loaded segments");

  await put(state, root, m, '=vocab("origin")');
  const v = String(state.cels.get("元").v);
  assert.match(v, /functions/, "vocab lists functions");
  assert.match(v, /\bdom\b/, "dom is listed as usable");
  assert.match(v, /\bgrid\b/, "grid is listed as usable");
});

test("inspect into a grid cell keeps its generator stamp; another cell can pin it", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, "=grid(3, 3)");
  await put(state, root, m, '=inspect("mount")', "g3x3.A1");      // result lands back in A1
  assert.ok(state.cels.get("g3x3.A1").metadata.generatedBy, "A1 still owned by the grid generator");
  // reference A1's yaml from B1 and pin it under .sheet as a <pre>
  await put(state, root, m, '(mount ".sheet" (dom "pre.pinned" g3x3.A1))', "g3x3.B1");
  assert.equal((state.cels.get("errors")?.v ?? []).filter((e) => /generator/.test(String(e.message))).length, 0, "no genesis ownership refusal");
  const sheet = walk(root, (n) => String(n.attrs?.class ?? "") === "sheet")[0];
  const pin = walk(sheet, (n) => n.tag === "pre" && /pinned/.test(String(n.attrs?.class ?? "")))[0];
  assert.ok(pin, "the inspect yaml is pinned under .sheet as a <pre>");
  assert.match(txt(pin), /name: mount/, "the pinned pre holds the referenced cell's yaml");
});

test("grid default name is g<r>x<c> — nested + different-shape grids don't collide", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, "=grid(5, 5)");
  assert.ok(state.cels.get("g5x5.A1"), "first sheet g5x5");
  await put(state, root, m, "=grid(4, 5)", "g5x5.A1"); // nested grid in a grid cell
  assert.ok(state.cels.get("g4x5.A1"), "nested grid g4x5 created — different shape, no collision");
  assert.equal((state.cels.get("errors")?.v ?? []).filter((e) => /generated by/.test(String(e.message))).length, 0, "no ownership refusal");
});

test("grid(name,r,c,…) makes a workbook of named grids in one formula", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, '=grid("budget", 3, 3, "actuals", 3, 3)'); // string first arg → workbook
  assert.ok(state.cels.get("budget.A1") && state.cels.get("actuals.C3"), "both sheets created");
  await put(state, root, m, "");
  assert.equal(state.cels.get("budget.A1"), undefined, "deleting the formula sweeps all sheets");
});

test("def(name, kind, source) defines a callable JS function", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, '=def("double", "js", "x => x * 2")');
  assert.equal(state.cels.get("double")?.celType, "EditableLambdaCel", "the function cel is created");
  assert.match(String(state.cels.get("元").v), /defined "double"/, "the def cell confirms");
  await put(state, root, m, "=double(21)");
  assert.equal(state.cels.get("元").v, 42, "the defined function is callable from a formula");
});
