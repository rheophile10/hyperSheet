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

// ── 3) the fire (gun) button ──────────────────────────────────────────────────

test("fire: the bar's lightning-bolt (SVG) button dispatches origin.fire; bar order is [W wiki][bolt][textarea]", async () => {
  const { state, root, m } = await boot();
  await resolveFn(state, "origin.select")(state, "turtles.B4"); m.run();
  const bar = fxbarOf(root, "turtles");
  const fire = byClass(bar, "pl-fxbar-fire")[0];
  assert.ok(fire, "the formula bar has a fire button");
  // the fire icon is an inline SVG lightning bolt, not the 🔫 emoji
  const svg = walk(fire, (n) => n.tag === "svg")[0];
  assert.ok(svg, "the fire button holds an inline <svg> bolt (not the emoji)");
  assert.ok(walk(svg, (n) => n.tag === "path" && !!n.attrs?.d)[0], "the svg has a <path> with a d");
  assert.ok(!/🔫/.test(txt(fire)), "no water-pistol emoji");
  // left-to-right order in the bar: W wiki, fire, then the textarea (the 🛡 trust
  // badge was removed with the 信 model — security is the session consent panel).
  const kids = bar.childNodes.filter((n) => n.nodeType === 1);
  const cls = (n) => String(n.attrs?.class ?? "");
  assert.ok(cls(kids[0]).includes("pl-fxbar-wiki"), "W wiki is leftmost");
  assert.ok(cls(kids[1]).includes("pl-fxbar-fire"), "fire is next");
  assert.ok(cls(kids[2]).includes("pl-fxbar-input"), "the formula textarea is last");
  // spy on origin.fire — clicking the button must dispatch it with the selected key
  const cel = state.cels.get("origin.fire");
  let fired = null;
  const orig = cel._fn;
  cel._fn = (st, payload) => { fired = payload; return st; };
  try {
    fire.fire("click");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(fired, "turtles.B4", "the fire button dispatches origin.fire with the selected cell key");
  } finally { cel._fn = orig; }
  // there is NO ƒx label any more
  assert.ok(!byClass(bar, "pl-fxbar-label")[0], "the ƒx label is gone");
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

// ── 3b) object / array cell values render as pretty JSON (not "[object Object]") ─

test("object/array value: renders as pretty-printed JSON in a <pre class=cell-pre>, NOT \"[object Object]\"", async () => {
  const { state, root, m } = await boot();
  // a chat-messages-style array of objects (the clients.C1 shape)
  const msgs = [{ from: "me", text: "hi" }, { from: "claude", text: "hello" }];
  await resolveFn(state, "setValue")(state, "turtles.B4", msgs);
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "dom.paint"); m.run();
  const td = cellByKey(root, "turtles.B4");
  const pre = walk(td, (n) => n.tag === "pre" && hasClass(n, "cell-pre"))[0];
  assert.ok(pre, "an object/array value renders inside a <pre class=cell-pre>");
  const shown = txt(pre);
  assert.ok(!/\[object Object\]/.test(shown), "NOT String()'d to [object Object]");
  assert.equal(shown, JSON.stringify(msgs, null, 2), "pretty-printed JSON, full text reachable");
  assert.match(shown, /\n {2}/, "two-space indented (pretty)");
  // the <pre> wraps so long content is reachable on expand
  assert.match(String(pre.attrs?.style ?? ""), /white-space:pre-wrap/, "the pre wraps");
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

test("wiki: the formula bar carries a W wiki affordance dispatching wiki.open for the selected cell", async () => {
  const { state, root, m } = await boot();
  await resolveFn(state, "origin.select")(state, "turtles.B4"); m.run();
  const cel = state.cels.get("wiki.open");
  let opened = null;
  const orig = cel._fn;
  cel._fn = (st, payload) => { opened = payload; return st; };
  try {
    const bar = fxbarOf(root, "turtles");
    const wiki = byClass(bar, "pl-fxbar-wiki")[0];
    assert.ok(wiki, "the formula bar has a W wiki affordance");
    assert.equal(txt(wiki), "W", "the wiki glyph is W");
    wiki.fire("click");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(opened, "turtles.B4", "the bar's wiki affordance dispatches wiki.open for the selected cell");
  } finally { cel._fn = orig; }
});

// ── 6) formula bar default height + wrapping ─────────────────────────────────

test("formula bar: default is a TALL multi-line box that wraps (no horizontal scrollbar)", async () => {
  const { state, root, m } = await boot();
  await resolveFn(state, "origin.select")(state, "turtles.B4"); m.run();
  const input = fxInput(root, "turtles");
  assert.ok(input, "the bar has a textarea");
  const style = String(input.attrs?.style ?? "");
  assert.match(style, /min-height:7\.5rem/, "default min-height is substantially tall (~7.5rem)");
  assert.match(style, /white-space:pre-wrap/, "text wraps (pre-wrap)");
  assert.match(style, /overflow-x:hidden/, "no horizontal scrollbar");
  assert.match(style, /word-break:break-word/, "long tokens break");
  assert.match(style, /resize:vertical/, "still user-resizable (vertical)");
  assert.doesNotMatch(style, /max-height/, "no max-height cap — drag it as tall as you like");
});

// ── 7) tab drag: reorder + tear-off ──────────────────────────────────────────

test("tab reorder: dragging a tab over a sibling rewrites win.geom order; the strip renders by it", async () => {
  const { state, m } = await boot();
  // tab a fresh blank sheet into turtles so the strip is [turtles | turtlecharts | tab1]
  await resolveFn(state, "winsheet.newtab")(state, "turtles"); m.run();
  const sibs = () => Object.keys(state.cels.get("win.geom").v).filter((k) => k === "turtles" || state.cels.get("win.geom").v[k]?.host === "turtles");
  const tabs = sibs();
  assert.ok(tabs.length >= 3, "turtles now hosts >=2 tabs");
  // stub elementsFromPoint so tabAtPoint(...) reports we're hovering turtles' chip
  const hovered = "turtles";
  globalThis.document.elementsFromPoint = () => [{ closest: (s) => (s === ".pl-tab" ? { getAttribute: () => hovered } : null) }];
  const dragged = tabs.find((t) => t !== "turtles"); // drag a non-turtles tab onto turtles' slot
  await resolveFn(state, "winsheet.tabGrab")(state, { host: "turtles", tab: dragged }, { clientX: 0, clientY: 0, pointerId: 1 });
  await resolveFn(state, "winsheet.tabMove")(state, { host: "turtles", tab: dragged }, { clientX: 10, clientY: 0 });
  const geom = state.cels.get("win.geom").v;
  assert.equal(typeof geom[dragged]?.order, "number", "the dragged tab got an explicit order");
  // dragged should now sort before turtles (it took turtles' slot)
  const ordered = sibs().sort((a, b) => (geom[a]?.order ?? 99) - (geom[b]?.order ?? 99));
  assert.ok(ordered.indexOf(dragged) < ordered.indexOf("turtles"), "the dragged tab moved ahead of turtles");
  delete globalThis.document.elementsFromPoint;
});

test("tab tear-off (drag): releasing a tab OFF its window clears its host → standalone window", async () => {
  const { state, m } = await boot();
  await resolveFn(state, "winsheet.newtab")(state, "turtles"); m.run();
  const tab = Object.keys(state.cels.get("win.geom").v).find((k) => state.cels.get("win.geom").v[k]?.host === "turtles");
  assert.ok(tab, "a tab hosted by turtles exists");
  // no elementsFromPoint on the mock document → drop lands in empty space → tear off
  await resolveFn(state, "winsheet.tabGrab")(state, { host: "turtles", tab }, { clientX: 0, clientY: 0, pointerId: 1 });
  await resolveFn(state, "winsheet.tabDrop")(state, { host: "turtles", tab }, { clientX: 900, clientY: 600 });
  assert.equal(state.cels.get("win.geom").v[tab]?.host, undefined, "the torn-off tab has no host (standalone)");
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

// ── 8) grab does NOT snap the window under the mouse (read the live rect) ─────

test("grab: offset is measured from the window's ACTUAL position (offsetLeft/Top), so the first move doesn't jump", async () => {
  const { state, m } = await boot();
  // a geom-less window renders staggered by index (~gnum(g.x, 40+i*34)), NOT at the
  // grab default 60. Stub the grabbed titlebar's currentTarget.closest(".pl-window")
  // to report the window's .origin-relative offset; wsGrab computes ox/oy from THAT.
  const win = { offsetLeft: 137, offsetTop: 211 };
  const event = {
    clientX: 200, clientY: 250, pointerId: 1,
    currentTarget: {
      setPointerCapture() {},
      closest: (s) => (s === ".pl-window" ? win : null),
    },
  };
  await resolveFn(state, "winsheet.grab")(state, "turtles", event); m.run();
  const d = state.cels.get("winsheet.drag")?.v;
  assert.ok(d, "a drag started");
  assert.equal(d.ox, event.clientX - win.offsetLeft, "ox is grab.clientX − offsetLeft (from where the window SITS)");
  assert.equal(d.oy, event.clientY - win.offsetTop, "oy is grab.clientY − offsetTop");
  // and a move places the window so its origin = pointer − offset = the live spot,
  // i.e. it does NOT snap to the 60 default.
  await resolveFn(state, "winsheet.move")(state, "turtles", { clientX: 200, clientY: 250 }); m.run();
  const g = state.cels.get("win.geom")?.v?.turtles;
  assert.equal(g.x, win.offsetLeft, "no jump: the window stays where it was grabbed (x = offsetLeft)");
  assert.equal(g.y, win.offsetTop, "no jump: y = offsetTop");
});

test("grab: with NO live rect (off-DOM) wsGrab falls back to win.geom default 60", async () => {
  const { state, m } = await boot();
  // no currentTarget.closest → fall back to win.geom (default 60) — the test path.
  await resolveFn(state, "winsheet.grab")(state, "turtles", { clientX: 100, clientY: 100, pointerId: 1 }); m.run();
  const d = state.cels.get("winsheet.drag")?.v;
  const g = state.cels.get("win.geom")?.v?.turtles ?? {};
  const baseX = Number.isFinite(g.x) ? g.x : 60, baseY = Number.isFinite(g.y) ? g.y : 60;
  assert.equal(d.ox, 100 - baseX, "fallback ox from win.geom (default 60)");
  assert.equal(d.oy, 100 - baseY, "fallback oy from win.geom (default 60)");
});

// ── 9) formula-bar icons are comfortably large ───────────────────────────────

test("formula-bar icons: the W wiki + fire buttons are noticeably larger (glyphBtn ~1.1rem, bolt svg 22px)", async () => {
  const { root } = await boot();
  const bar = fxbarOf(root, "turtles");
  const wiki = byClass(bar, "pl-fxbar-wiki")[0];
  const fire = byClass(bar, "pl-fxbar-fire")[0];
  assert.ok(wiki && fire, "wiki + fire buttons present");
  // glyphBtn font-size bumped from .72rem → ~1.1rem on both buttons
  assert.match(String(wiki.attrs?.style ?? ""), /font:600 1\.1rem/, "W wiki button uses the larger ~1.1rem glyphBtn font");
  assert.match(String(fire.attrs?.style ?? ""), /font:600 1\.1rem/, "gun button uses the larger ~1.1rem glyphBtn font");
  assert.ok(!/\.72rem/.test(String(wiki.attrs?.style ?? "")), "no longer the tiny .72rem size");
  // the gun svg is 22px (was 16)
  const svg = walk(fire, (n) => n.tag === "svg")[0];
  assert.equal(String(svg.attrs?.width), "22", "gun svg width is 22px");
  assert.equal(String(svg.attrs?.height), "22", "gun svg height is 22px");
});

// ── 10) the dragged tab chip highlights in the drop-target blue ──────────────

test("dragged tab: while winsheet.tabdrag is set, the matching chip highlights blue (.drop-target)", async () => {
  const { state, root, m } = await boot();
  // tab a fresh sheet into turtles so there is a tab strip with >1 chip
  await resolveFn(state, "winsheet.newtab")(state, "turtles"); m.run();
  const chipFor = (seg) => walk(root, (n) => hasClass(n, "pl-tab") && n.attrs["data-tab"] === seg)[0];
  // before any drag, no chip carries the drop-target highlight
  assert.ok(chipFor("turtles") && !hasClass(chipFor("turtles"), "drop-target"), "no highlight before a drag");
  // start dragging the turtlecharts tab → its chip (and ONLY its chip) lights up
  await resolveFn(state, "winsheet.tabGrab")(state, { host: "turtles", tab: "turtlecharts" }, { clientX: 0, clientY: 0, pointerId: 1 }); m.run();
  assert.equal(state.cels.get("winsheet.tabdrag")?.v?.tab, "turtlecharts", "winsheet.tabdrag records the dragged tab");
  const dragged = chipFor("turtlecharts");
  assert.ok(hasClass(dragged, "drop-target"), "the dragged chip gets the .drop-target class");
  // it uses the SAME blue as the window glow (#4a90d9 outline + box-shadow)
  assert.match(String(dragged.attrs?.style ?? ""), /outline:3px solid #4a90d9/, "the chip outline is the drop-target blue");
  assert.match(String(dragged.attrs?.style ?? ""), /box-shadow:0 0 0 3px #4a90d955/, "the chip's box-shadow matches the window glow");
  // a sibling chip is NOT highlighted
  const sibling = chipFor("turtles");
  assert.ok(sibling && !hasClass(sibling, "drop-target"), "a non-dragged sibling chip stays plain");
  // dropping over the host (elementsFromPoint absent → not a tear-off) clears the
  // drag → the highlight is gone.
  globalThis.document.elementsFromPoint = () => [{ closest: (s) => (s === ".pl-window" ? { getAttribute: () => "turtles" } : null) }];
  try {
    await resolveFn(state, "winsheet.tabDrop")(state, { host: "turtles", tab: "turtlecharts" }, { clientX: 0, clientY: 0 }); m.run();
  } finally { delete globalThis.document.elementsFromPoint; }
  assert.equal(state.cels.get("winsheet.tabdrag")?.v, null, "drop cleared winsheet.tabdrag");
  const afterDrop = chipFor("turtlecharts");
  assert.ok(afterDrop && !hasClass(afterDrop, "drop-target"), "the highlight cleared after drop");
});
