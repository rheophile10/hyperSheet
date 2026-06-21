import { test } from "bun:test";
import { openTurtlesFixture } from "./_turtles-fixture.mjs";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../dist/index.js";

// worksheet-window-fixes — three origin/sheet-host fixes:
//   A) editing a windowed worksheet data cell persists AND the window re-renders
//      (origin.edit must runCycle before paint so the editor swap lands in one
//       gesture; commit already re-fires the view).
//   B) worksheet windows have a red ✕ close button → winsheet.close sets
//      win.geom[seg].closed; frameOf hides it; winsheet.restore brings it back
//      (元 is never destroyed).
//   C) the boot seeds a `turtle_charts` worksheet tabbed with `turtle_data`
//      (win.geom[turtle_charts].host === "turtle_data") instead of 3 chart windows.

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
const cellByKey = (root, key) => walk(root, (n) => (n.tag === "div" || n.tag === "td") && /(^| )cell( |$)/.test(String(n.attrs.class ?? "")) && n.attrs["data-key"] === key)[0];
const cellVal = (root, key) => { const c = cellByKey(root, key); const v = c && walk(c, (n) => String(n.attrs?.class ?? "") === "cell-value")[0]; return v ? txt(v).replace("⤢", "").trim() : ""; };
const hasEditor = (root, key) => { const c = cellByKey(root, key); return !!(c && walk(c, (n) => n.tag === "textarea")[0]); };
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
  // open the README bundle (turtle_data + turtle_charts) as the fixture — the desktop
  // no longer auto-opens worksheets (they're launcher-driven now).
  await openTurtlesFixture(state, resolveFn);
  await resolveFn(state, "drain")(state, "dom.paint");
  m.run();
  return { state, root, m };
};

// ── FIX A ────────────────────────────────────────────────────────────────────

test("FIX A: clicking a windowed worksheet cell opens the editor in ONE gesture", async () => {
  const { state, root, m } = await boot();
  assert.equal(cellVal(root, "turtle_data.B4"), "75", "B4 shows its seeded value");
  assert.ok(!hasEditor(root, "turtle_data.B4"), "no editor before the click");
  // the click→origin.edit gesture (a single dispatch). The editor must render
  // after this one call — no extra runCycle/drain from the caller.
  await resolveFn(state, "origin.edit")(state, "turtle_data.B4");
  m.run();
  assert.equal(state.cels.get("元.editing")?.v, "turtle_data.B4", "the cell is now editing");
  assert.ok(hasEditor(root, "turtle_data.B4"), "the editor textarea rendered in the SAME gesture (paint landed)");
});

test("FIX A: editing a windowed worksheet cell persists AND the window re-renders the new value", async () => {
  const { state, root, m } = await boot();
  assert.equal(state.cels.get("turtle_data.B4")?.v, 75, "seed value");
  assert.equal(cellVal(root, "turtle_data.B4"), "75", "rendered seed value");
  // drive the real gesture: edit → draft → commit
  await resolveFn(state, "origin.edit")(state, "turtle_data.B4"); m.run();
  await resolveFn(state, "setValue")(state, "元.draft", "7900");
  await resolveFn(state, "origin.run")(state, "turtle_data.B4"); m.run();
  assert.equal(state.cels.get("turtle_data.B4")?.v, 7900, "the cel value persisted");
  assert.equal(cellVal(root, "turtle_data.B4"), "7900", "the window re-rendered the new value");
});

// ── FIX B ────────────────────────────────────────────────────────────────────

test("FIX B: winsheet.close hides a worksheet window; frameOf returns the stub; restore brings it back", async () => {
  const { state, root, m } = await boot();
  const geom = () => state.cels.get("win.geom")?.v ?? {};
  const turtle_dataWin = () => walk(root, (n) => String(n.attrs?.class ?? "").includes("pl-window") && n.attrs["data-win"] === "turtle_data")[0];
  const turtle_dataShown = () => { const w = turtle_dataWin(); return !!w && !String(w.attrs?.class ?? "").includes("pl-window-closed"); };

  assert.ok(turtle_dataShown(), "turtle_data window visible before close");
  await resolveFn(state, "winsheet.close")(state, "turtle_data"); m.run();
  assert.equal(geom().turtle_data?.closed, 1, "win.geom[turtle_data].closed set");
  assert.ok(!turtle_dataShown(), "frameOf hides the closed window (stub)");

  // (the bottom taskbar was removed — a closed worksheet restores via its launcher
  // / winsheet.restore, which the next lines exercise.)
  await resolveFn(state, "winsheet.restore")(state, "turtle_data"); m.run();
  assert.ok(!geom().turtle_data?.closed, "restore cleared closed");
  assert.ok(!geom().turtle_data?.min, "restore cleared min");
  assert.ok(turtle_dataShown(), "the window is back");
});

test("FIX B: 元 is restorable after close (never permanently destroyed)", async () => {
  const { state, m } = await boot();
  const geom = () => state.cels.get("win.geom")?.v ?? {};
  await resolveFn(state, "winsheet.close")(state, "元"); m.run();
  assert.equal(geom()["元"]?.closed, 1, "元 marked closed");
  assert.ok(state.cels.get("元"), "the 元 cel itself was NOT deleted");
  await resolveFn(state, "winsheet.restore")(state, "元"); m.run();
  assert.ok(!geom()["元"]?.closed, "元 restored");
});

// ── the turtles demo: charts + data as TWO SEPARATE windows ──────────────────

test("the turtles demo opens turtle_charts + turtle_data as SEPARATE windows", async () => {
  const { state, root } = await boot();
  // the charts live in their own worksheet, rendering the chart verbs from the
  // turtle_data data (cross-sheet turtle_data! ranges).
  assert.ok(state.cels.get("turtle_charts.A1"), "turtle_charts.A1 chart cell materialized");
  assert.ok(state.cels.get("turtle_charts.B1"), "turtle_charts.B1");
  assert.ok(state.cels.get("turtle_charts.C1"), "turtle_charts.C1");
  // the canvas verb produced a vnode value (the chart renders)
  assert.equal(state.cels.get("turtle_charts.A1")?.v?.tag, "canvas", "A1 holds a chart canvas vnode");
  // NOT tabbed: turtle_charts carries no host — it's its own window (charts on top,
  // data below, via the seeded win.geom positions).
  assert.equal(state.cels.get("win.geom")?.v?.turtle_charts?.host, undefined, "turtle_charts is NOT tabbed (no host)");
  assert.equal(state.cels.get("win.geom")?.v?.turtle_data?.host, undefined, "turtle_data is NOT tabbed (no host)");
  // BOTH render as standalone top-level windows.
  const topWins = walk(root, (n) => String(n.attrs?.class ?? "").includes("pl-window") && n.attrs["data-win"] && !n.attrs["data-win"].includes(".state")).map((n) => n.attrs["data-win"]);
  assert.ok(topWins.includes("turtle_charts"), "turtle_charts is its own window");
  assert.ok(topWins.includes("turtle_data"), "turtle_data is its own window");
});
