import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../dist/index.js";

afterEach(() => { delete globalThis.document; });

// dom-svg-namespace — an inline <svg> (the formula-bar gun icon) must be built
// with createElementNS(SVG_NS, …) so it actually renders; plain createElement
// makes inert HTML that never paints. The painter walks into the svg subtree
// using the NS path; html siblings keep using createElement. Driven through the
// REAL origin boot (the gun lives in the worksheet formula bar).

const mkEl = (tag, ns) => {
  const L = new Map();
  const el = {
    nodeType: 1, tag, tagName: String(tag).toUpperCase(), ns: ns ?? null, value: undefined, childNodes: [], attrs: {},
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
const SVG_NS = "http://www.w3.org/2000/svg";

test("the formula-bar gun svg paints via createElementNS (SVG namespace)", async () => {
  const root = mkEl("app");
  const nsCalls = [];
  globalThis.document = {
    createElement: (t) => mkEl(t, null),
    createElementNS: (ns, t) => { nsCalls.push([ns, t]); return mkEl(t, ns); },
    createTextNode: (s) => ({ nodeType: 3, data: s }),
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
  await resolveFn(state, "origin.commit")(state, "元");
  await resolveFn(state, "drain")(state, "dom.paint"); m.run();
  // select a turtles cell so a window formula bar (with the gun) renders
  await resolveFn(state, "origin.select")(state, "turtles.B4"); m.run();

  const fire = walk(root, (n) => /(^| )pl-fxbar-fire( |$)/.test(String(n.attrs?.class ?? "")))[0];
  assert.ok(fire, "the gun fire button rendered");
  const svg = walk(fire, (n) => n.tag === "svg")[0];
  assert.ok(svg, "the gun is an <svg>");
  assert.equal(svg.ns, SVG_NS, "svg created in the SVG namespace");
  const path = walk(svg, (n) => n.tag === "path")[0];
  assert.ok(path, "the svg has a <path>");
  assert.equal(path.ns, SVG_NS, "the path (svg descendant) is ALSO in the SVG namespace");
  assert.ok(path.attrs.d, "the path's d attribute was applied");
  assert.ok(nsCalls.some(([, t]) => t === "svg"), "svg went through createElementNS");
  assert.ok(!nsCalls.some(([, t]) => t === "div"), "html elements used plain createElement");
});
