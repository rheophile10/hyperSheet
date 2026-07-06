import { test } from "bun:test";
import { openTurtlesFixture } from "./_turtles-fixture.mjs";
import assert from "node:assert/strict";
import {
  createInitialState, precomputeOptional, resolveFn,
  createPainter, setPainter, isDenied,
} from "../dist/index.js";

// ============================================================================
// turtles-pattern — every app is a WINDOW = one or more SHEETS (tabs); each
// window-sheet is a CLOSURE (minted get:["origin"], so only the host view reads
// it — peer formulas can't). A tab/host relationship BUNDLES the segments (the
// one opener of shared memory), so tabbed sheets read each other while separate
// windows stay isolated.
//
// FORMULA-FIRST + collections doctrine (this session): turtle_charts holds the
// =rows() hub-form pivot (B1), the species filter cell (B2), the =FILTER
// derivation (B3), and ONE =view("🐢 dashboard", …) formula (B4) whose select +
// bar/line/pie pane is CONTRIBUTED to a view pane of the active workbook (the
// cell's value is the ⧉ token). The suite opens a workbook first
// (origin.newsheet) so the =view formula has a cardBook to land in, then
// asserts the split: recipe in the cells, pixels in the pane.
// ============================================================================

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
  };
  return el;
};
const walk = (n, p, o = []) => { if (n?.nodeType === 1) { if (p(n)) o.push(n); for (const c of n.childNodes) walk(c, p, o); } return o; };
const mockRaf = () => { const q = []; return { raf: (cb) => q.push(cb), caf: () => {}, run: () => { for (const cb of q.splice(0)) cb(); } }; };

// land request→effect formulas (=view): runCycle re-fires, origin.effects applies.
const settle = async (state) => {
  const drain = resolveFn(state, "drain"), runCycle = resolveFn(state, "runCycle");
  for (let i = 0; i < 4; i++) {
    await runCycle(state);
    if (state.cels.get("origin.effects")) await drain(state, "origin.effects");
  }
};

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
  await resolveFn(state, "origin.run")(state, "元"); // minimal boot (wallpaper only)
  await resolveFn(state, "origin.newsheet")(state);  // a WORKBOOK for the =view panes to land in
  await openTurtlesFixture(state, resolveFn);   // turtles + turtle_charts (=view chart formulas)
  await settle(state);                          // land the =view tokens the last runCycle re-enqueued
  await resolveFn(state, "drain")(state, "dom.paint");
  m.run();
  return { state, root, m };
};

// the dashboard slot's charts row (the div holding the three canvases)
const dashCanvases = (state) => {
  const slot = state.cels.get("dashboard.view")?.v?.children?.[0]?.children?.[0];
  const row = slot?.children?.find((r) => r.children?.some?.((c) => c.tag === "canvas"));
  return row?.children?.filter((c) => c.tag === "canvas") ?? [];
};

test("the dashboard cells KEEP their formulas; the select + charts land in the workbook's VIEW pane, not the cells", async () => {
  const { state } = await boot();
  // the pivot + filter + derivation: visible sources, plain values
  const b1 = state.cels.get("turtle_charts.B1");
  assert.ok(b1?.f?.startsWith("=rows("), "B1 keeps its =rows() pivot source");
  assert.ok(!isDenied(b1.v), "the pivot resolved turtle_data! (not #DENIED)");
  assert.equal(Array.isArray(b1.v) && b1.v.length, 7, "B1 is the hub form: 7 dicts");
  const b3 = state.cels.get("turtle_charts.B3");
  assert.ok(b3?.f?.startsWith("=FILTER("), "B3 keeps its =FILTER source");
  assert.equal(b3.v?.length, 7, "filter='all' → all rows");
  // the =view cell: recipe survives, value is the ⧉ token — NOT a vnode
  const b4 = state.cels.get("turtle_charts.B4");
  assert.ok(b4?.f?.startsWith('=view("🐢 dashboard"'), "B4 keeps its visible =view source");
  assert.notEqual(b4.v?.tag, "div", "no vnode renders inside the grid cell");
  assert.deepEqual(b4.v, { view: "dashboard", item: true }, "B4's value is the view-pane token (emoji sanitized out of the ref)");
  // the pane: ONE dashboard tab holding all three canvases
  const wb = state.cels.get("win.sheet1.state")?.v;
  assert.deepEqual((wb?.views ?? []).map((t) => t.title), ["🐢 dashboard"], "one dashboard view tab on the active workbook");
  assert.equal(dashCanvases(state).length, 3, "the pane holds the three chart canvases");
  // charts + data are TWO separate windows still (not tabbed): turtle_charts carries
  // no `host` — it has its own seeded geometry (charts on top, data below).
  assert.equal(state.cels.get("win.geom")?.v?.turtle_charts?.host, undefined, "turtle_charts is its own window, not tabbed");
});

test("the species filter (param.set → B2) re-derives B3 and the pane charts", async () => {
  const { state } = await boot();
  await resolveFn(state, "param.set")(state, "turtle_charts.B2", { target: { value: "Box" } });
  await settle(state);
  assert.equal(state.cels.get("turtle_charts.B2")?.v, "Box", "the filter cell took the select's value");
  assert.equal(state.cels.get("turtle_charts.B3")?.v?.length, 1, "B3 filtered to the one species");
  const bars = JSON.parse(dashCanvases(state)[0].attrs["data-ops"]).filter((o) => o.op === "rect");
  assert.equal(bars.length - 1, 1, "the pane barchart shows one bar");
});

test("editing turtle_data re-renders the dashboard through the =rows pivot", async () => {
  const { state } = await boot();
  const barOps = () => JSON.parse(dashCanvases(state)[0].attrs["data-ops"]).filter((o) => o.op === "rect");
  const before = barOps()[2].h; // Leatherback bar (not the max, so a rescale moves it)
  await resolveFn(state, "setValue")(state, "turtle_data.B2", 500);
  await settle(state);
  assert.equal(state.cels.get("turtle_charts.B1")?.v?.[0]?.lifespan, 500, "the edit flowed into the hub-form dataset");
  assert.notEqual(barOps()[2].h, before, "…and through =FILTER + =view to the pane canvas");
});

// the readme renders nested dom vnodes (cards have children); a value-level
// walker over the {type:el} vnode tree finds a node matching a predicate.
const walkV = (n, p, o = []) => { if (n?.type === "el") { if (p(n)) o.push(n); for (const c of n.children ?? []) walkV(c, p, o); } else if (n?.type === "text" && p(n)) o.push(n); return o; };
const vtext = (n) => (n?.type === "text" ? (n.text ?? "") : (n?.children ?? []).map(vtext).join(""));

// NOTE: the README-behavior tests (TALL sheet / def+use rows / try-it ⚡
// targets) were removed — the readme is now an origin-user document, opened
// by the 📖 Readme launcher; there are no per-row ⚡ buttons or tryexample/ex
// any more. The turtles fixture (this suite) comes from the 📊 Turtles
// document via _turtles-fixture.mjs.

// NOTE: the cloud chat-board tests (clients+chat worksheets, tabbed pair) were
// removed — the minimal desktop no longer boots that board (the 🖥 Local LLM
// launcher is the chat now). The chat machinery itself stays covered by
// client.test.mjs / client-rearm / origin-agentic-chat / origin-agentic-prompt.
