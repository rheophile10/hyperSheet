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
// windows stay isolated. The "+" on the tab strip mints a new 10×10 blank sheet
// tabbed into the clicked window.
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
  await openTurtlesFixture(state, resolveFn);   // README bundle (readme + turtles + turtlecharts)
  await resolveFn(state, "drain")(state, "dom.paint");
  m.run();
  return { state, root, m };
};

test("turtle_charts reads turtle_data! and renders a canvas — as a SEPARATE window", async () => {
  const { state } = await boot();
  // the chart formula in turtle_charts resolves the turtle_data! cross-sheet range
  const a1 = state.cels.get("turtle_charts.A1")?.v;
  assert.ok(a1 && a1.tag === "canvas", "the chart formula resolved turtle_data! and produced a canvas (NOT #DENIED)");
  assert.ok(!isDenied(a1), "the chart value is not the #DENIED sentinel");
  // charts + data are TWO separate windows now (not tabbed): turtle_charts carries
  // no `host` — it has its own seeded geometry (charts on top, data below).
  assert.equal(state.cels.get("win.geom")?.v?.turtle_charts?.host, undefined, "turtle_charts is its own window, not tabbed");
});

// the readme renders nested dom vnodes (cards have children); a value-level
// walker over the {type:el} vnode tree finds a node matching a predicate.
const walkV = (n, p, o = []) => { if (n?.type === "el") { if (p(n)) o.push(n); for (const c of n.children ?? []) walkV(c, p, o); } else if (n?.type === "text" && p(n)) o.push(n); return o; };
const vtext = (n) => (n?.type === "text" ? (n.text ?? "") : (n?.children ?? []).map(vtext).join(""));

// NOTE: the README-behavior tests (TALL sheet / def+use rows / try-it ⚡
// targets) were removed — the readme is now a STATIC text file (starter/
// readme.f), opened by the 📖 Readme launcher; there are no per-row ⚡
// buttons or tryexample/ex any more. The turtles fixture (this suite) comes
// from the 📊 Turtles demo (starter/turtles.f) via _turtles-fixture.mjs.

// NOTE: the cloud chat-board tests (clients+chat worksheets, tabbed pair) were
// removed — the minimal desktop no longer boots that board (the 🖥 Local LLM
// launcher is the chat now). The chat machinery itself stays covered by
// client.test.mjs / client-rearm / origin-agentic-chat / origin-agentic-prompt.
