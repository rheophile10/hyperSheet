import { test } from "bun:test";
import { openTurtlesFixture } from "./_turtles-fixture.mjs";
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
  await resolveFn(state, "drain")(state, "dom.paint");
  m.run();
  return { state, root, m };
};

const put = async (state, root, m, src, key = "元") => {
  await resolveFn(state, "origin.edit")(state, key); m.run();
  await resolveFn(state, "setValue")(state, "元.draft", src);
  await resolveFn(state, "origin.run")(state, key);
  m.run();
};

// (the README-rich-content test was removed — the readme is now a STATIC
//  text file, starter/readme.f, with no .readme dom card / fx-code / try-it.)

test("A1 executes a formula: =1+1 shows 2; a literal 7 shows 7; clearing restores the desktop", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, "=1+1");
  assert.equal(state.cels.get("元").v, 2, "=1+1 -> 2 in A1");
  assert.equal(cellVal(root, "元"), "2", "A1 renders 2");
  await put(state, root, m, "7");
  assert.equal(cellVal(root, "元"), "7", "literal renders in A1");
  await put(state, root, m, "");
  assert.ok(state.cels.get("desktop.A1"), "empty 元 -> the minimal wallpaper desktop is restored");
});

test("A1 can render a dom object", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, '(dom "h2" "hi")');
  assert.equal(state.cels.get("元").v?.tag, "h2", "A1 value is an <h2> vnode");
  assert.ok(walk(root, (n) => n.tag === "h2").length > 0, "h2 rendered in the cell");
});

test("=cels(3,3) makes a 3x3 worksheet of cels, each editable like 元", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, "=cels(3, 3)");
  for (const a of ["g3x3.A1", "g3x3.C3", "g3x3.B2"]) assert.ok(state.cels.get(a), `${a} created`);
  assert.equal(cells(root).length, 10, "A1 + 9 grid cels");
  assert.ok(cellByKey(root, "g3x3.A1"), "grid cell g3x3.A1 rendered");
  await put(state, root, m, "10", "g3x3.A1");
  await put(state, root, m, "=g3x3!A1*2", "g3x3.B1"); // cross-sheet ref into the grid's namespace
  assert.equal(state.cels.get("g3x3.B1").v, 20, "g3x3.B1 computes from g3x3!A1*2 (bare-A1 scoping is a follow-up)");
  await put(state, root, m, "");
  assert.equal(state.cels.get("g3x3.A1"), undefined, "grid swept when its formula is gone");
  // empty 元 restores the minimal desktop seed (wallpaper) — A1 back, g3x3 gone.
  const back = cells(root).map((c) => c.attrs["data-key"]);
  assert.ok(back.includes("元"), "A1 back");
  assert.ok(state.cels.get("desktop.A1"), "minimal wallpaper desktop restored");
  assert.ok(!back.some((k) => k.startsWith("g3x3.")), "no g3x3 cells remain");
});

test("a syntax error surfaces under the editor instead of doing nothing", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, '=cels("in" 4 3)'); // infix wants commas — this won't compile
  assert.match(String(state.cels.get("元.error").v ?? ""), /expected|infix|\)/, "the parse error is captured");
  assert.equal(state.cels.get("元.editing").v, "元", "stays in the cell so it can be fixed");
  assert.ok(walk(root, (n) => String(n.attrs?.class ?? "") === "cell-error")[0], "error line is rendered");
  // fixing it (commas) clears the error and commits
  await put(state, root, m, '=cels("in", 4, 3)');
  assert.equal(state.cels.get("元.error").v, null, "error cleared on a good commit");
  assert.ok(state.cels.get("in.A1"), "the corrected formula ran");
});

test("editing a cell label opens an input seeded with its source", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, "=2+3");
  await resolveFn(state, "origin.edit")(state, "元"); m.run();
  assert.equal(state.cels.get("元.editing").v, "元", "A1 marked editing");
  assert.equal(state.cels.get("元.draft").v, "=2+3", "draft seeded with the cell source");
  assert.ok(walk(root, (n) => n.tag === "textarea").length > 0, "editor (textarea) shown for the active base cell");
});

test("=cels(sheet) lists a segment; unknown symbols show #NAME?", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, '=members("sheet")');
  assert.match(String(state.cels.get("元").v), /infix/, "segment members listed");
  await put(state, root, m, "=nope(1)");
  assert.match(txt(cellByKey(root, "元")), /#NAME\?/, "undefined symbol shows #NAME?");
});

test("mount(selector) targets an existing view node (.origin); no match places nothing", async () => {
  const { state, root, m } = await boot();
  const hello = () => walk(root, (n) => String(n.attrs?.class ?? "").split(/\s+/).includes("hello"))[0];
  await put(state, root, m, '(mount ".origin" (dom "h2.hello" "pinned"))'); // replaces 元's readme mount
  assert.ok(hello(), "dom placed under .origin, not in the cell");
  assert.match(txt(hello()), /pinned/);
  // a selector that matches no view node places nothing (regions are gone)
  await put(state, root, m, '(mount "nowhere" (dom "h2.ghost" "x"))');
  assert.equal(walk(root, (n) => String(n.attrs?.class ?? "") === "ghost")[0], undefined, "unmatched selector → nothing placed");
  await put(state, root, m, ""); // clear 元 → readme mount restored
  assert.equal(hello(), undefined, "the pinned dom is gone with its formula");
});

test("mount(selector, content) splices under any element of the view (e.g. .sheet)", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, "=cels(3, 3)"); // gives the view a .sheet with cells + a grid
  await put(state, root, m, '(mount ".origin" (dom "div.under" "below the cells"))', "g3x3.A1");
  const sheet = walk(root, (n) => String(n.attrs?.class ?? "") === "origin")[0];
  assert.ok(sheet, "the .origin desktop rendered");
  const hasUnder = (n) => String(n.attrs?.class ?? "").split(/\s+/).includes("under");
  const under = walk(sheet, hasUnder)[0];
  assert.ok(under, "the dom is spliced UNDER .origin");
  assert.match(txt(under), /below the cells/);
  await put(state, root, m, "", "g3x3.A1"); // clear the formula
  assert.equal(walk(root, hasUnder)[0], undefined, "gone with its formula");
});

test("mount returns a selector handle; another cel mounts INSIDE it", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, "=cels(2, 2)"); // a grid with addressable cells
  // A: place a parent under .origin → its returned value is the handle selector
  await put(state, root, m, '=mount(".origin", dom("div.parent", "P"))', "g2x2.A1");
  // B: mount a child INTO whatever A1 returned (compose by the returned handle)
  await put(state, root, m, '=mount(g2x2.A1, dom("p.child", "C"))', "g2x2.B1");

  const hasClass = (c) => (n) => String(n.attrs?.class ?? "").split(/\s+/).includes(c);
  const parent = walk(root, hasClass("parent"))[0];
  assert.ok(parent, "A's parent rendered under .origin");
  const child = walk(parent, hasClass("child"))[0];
  assert.ok(child, "B's child rendered INSIDE A's parent — composed via the returned selector");
  assert.match(txt(child), /C/);

  // the returned VALUE is a human-readable selector string, not an object.
  const aVal = state.cels.get("g2x2.A1").v;
  assert.equal(typeof aVal, "string", "mount returns a selector string");
  assert.match(String(aVal), /^[.#]/, "…a class/id selector handle");
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
  assert.match(fnsrc, /registerMount/, "shows the actual fn body");
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
  await put(state, root, m, "=cels(3, 3)");
  await put(state, root, m, '=inspect("mount")', "g3x3.A1");      // result lands back in A1
  assert.ok(state.cels.get("g3x3.A1").metadata.generatedBy, "A1 still owned by the grid generator");
  // reference A1's yaml from B1 and pin it under .sheet as a <pre>
  await put(state, root, m, '(mount ".origin" (dom "pre.pinned" g3x3.A1))', "g3x3.B1");
  assert.equal((state.cels.get("errors")?.v ?? []).filter((e) => /generator/.test(String(e.message))).length, 0, "no genesis ownership refusal");
  const sheet = walk(root, (n) => String(n.attrs?.class ?? "") === "origin")[0];
  const pin = walk(sheet, (n) => n.tag === "pre" && /pinned/.test(String(n.attrs?.class ?? "")))[0];
  assert.ok(pin, "the inspect yaml is pinned under .sheet as a <pre>");
  assert.match(txt(pin), /name: mount/, "the pinned pre holds the referenced cell's yaml");
});

test("grid default name is g<r>x<c> — nested + different-shape grids don't collide", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, "=cels(5, 5)");
  assert.ok(state.cels.get("g5x5.A1"), "first sheet g5x5");
  await put(state, root, m, "=cels(4, 5)", "g5x5.A1"); // nested grid in a grid cell
  assert.ok(state.cels.get("g4x5.A1"), "nested grid g4x5 created — different shape, no collision");
  assert.equal((state.cels.get("errors")?.v ?? []).filter((e) => /generated by/.test(String(e.message))).length, 0, "no ownership refusal");
});

test("grid(name,r,c,…) makes a workbook of named grids in one formula", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, '=cels("budget", 3, 3, "actuals", 3, 3)'); // string first arg → workbook
  assert.ok(state.cels.get("budget.A1") && state.cels.get("actuals.C3"), "both sheets created");
  await put(state, root, m, "");
  assert.equal(state.cels.get("budget.A1"), undefined, "deleting the formula sweeps all sheets");
});

test("editing 元's formula RE-DRAINS genesis: a genesis-producing formula re-creates its windows/cels", async () => {
  const { state, root, m } = await boot();
  await resolveFn(state, "origin.run")(state, "元"); m.run(); // minimal boot desktop
  // the minimal boot materializes the wallpaper `desktop` sheet (owned by 元).
  assert.ok(state.cels.get("desktop.A1"), "boot materialized the wallpaper desktop sheet");
  // edit 元 to a DIFFERENT genesis formula → its windows must appear and the
  // old desktop's sheet (owned by 元) sweeps
  await put(state, root, m, '=winapp("hello", "Hello", "(dom \\"p\\" \\"hi\\")")');
  assert.ok(state.cels.get("win.hello.state"), "the edited genesis re-created its window state cel");
  assert.ok(state.cels.get("win.hello.frame"), "…and its frame");
  assert.ok(!state.cels.get("desktop.A1"), "the old desktop sheet swept (元 is authoritative)");
  // clear 元 → the minimal desktop seed restores its sheet again
  await put(state, root, m, "");
  assert.ok(state.cels.get("desktop.A1"), "clearing 元 re-drains the desktop genesis (wallpaper back)");
  assert.ok(!state.cels.get("win.hello.state"), "the interim window is gone with its formula");
});

test("def(name, kind, source) defines a callable JS function", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, '=def("double", "js", "x => x * 2")');
  assert.equal(state.cels.get("double")?.celType, "EditableLambdaCel", "the function cel is created");
  assert.match(String(state.cels.get("元").v), /defined "double"/, "the def cell confirms");
  await put(state, root, m, "=double(21)");
  assert.equal(state.cels.get("元").v, 42, "the defined function is callable from a formula");
});

test("xlsx wiring: xlsxexport(\"turtle_data\") exports the boot turtle_data sheet, round-trips back via xlsximport", async () => {
  const { state, root, m } = await boot();
  await resolveFn(state, "origin.run")(state, "元"); m.run(); // minimal boot
  await openTurtlesFixture(state, resolveFn); m.run();   // README bundle → turtle_data sheet
  // the broken =xlsxsave("turtle_data") readme row was removed — the xlsx verbs take
  // `state` as their first arg, which formula evaluation can't supply, so they
  // run only via resolveFn (host wiring), not as a readme formula. The export
  // is still wired and round-trips here through the direct resolveFn path.
  assert.ok(!walk(root, (n) => /(^| )fx-code( |$)/.test(String(n.attrs?.class ?? "")) && /xlsxsave/.test(txt(n)))[0], "the broken xlsxsave example is gone from the readme");
  // the xlsx verbs still loaded with origin's closure
  assert.ok(state.cels.get("xlsxexport"), "xlsxexport in the origin closure");
  assert.ok(state.cels.get("turtle_data.A1"), "boot turtle_data sheet present to export");
  // export the live turtle_data sheet, then import the bytes back — addresses + values match
  const b64 = await resolveFn(state, "xlsxexport")(state, "turtle_data");
  assert.equal(typeof b64, "string");
  const req = await resolveFn(state, "xlsximport")(state, b64);
  assert.equal(req.genesis, true, "import returns a genesis worksheet");
  assert.equal(req.cels["xlsx.A1"].v, state.cels.get("turtle_data.A1").v, "A1 text round-trips");
  assert.equal(req.cels["xlsx.B2"].v, state.cels.get("turtle_data.B2").v, "B2 number round-trips");
});

test("a nav launcher reopens a window the ✕ closed (re-click the same icon)", async () => {
  const { state, root, m } = await boot();
  await resolveFn(state, "origin.run")(state, "元"); m.run(); // minimal boot desktop
  const navOpen = resolveFn(state, "origin.navOpen"), winClose = resolveFn(state, "winx.close");
  const action = '=winapp("hello", "Hello", "(dom \\"p\\" \\"hi\\")")';
  const closedOf = () => state.cels.get("win.hello.state")?.v?.closed;
  // click the icon → the window opens (visible)
  await navOpen(state, action); m.run();
  assert.ok(state.cels.get("win.hello.state"), "the launcher opened the window");
  assert.ok(!closedOf(), "window starts visible");
  // ✕ closes it
  await winClose(state, "win.hello.state");
  assert.equal(closedOf(), 1, "✕ marked the window closed");
  // re-click the SAME icon → it must come back (the bug: it stayed hidden)
  await navOpen(state, action); m.run();
  assert.ok(!closedOf(), "re-clicking the icon reopened the closed window");
  // and it didn't mint a churn of conflicting app-segment generators / trap errors
  assert.ok(!state.cels.get("app2.元"), "no app1/app2 churn — a stable nav segment is reused");
});
