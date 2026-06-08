import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../../plastron/dist/index.js";
import { buildSheetsApp } from "./sheets.ts";

// Fragment-cels regression guards (vnode-valuecel-collapse.md):
//   1. DOM-fingerprint identity — the fragmented sheet view paints the
//     IDENTICAL DOM to the monolithic (string-inlined) form across a
//     randomized edit/select script. Permanent stale-UI guard: both
//     spike pitfalls (inverted predicate, shallow compare) flip this.
//   2. Fragment locality — toolbar work is zero for grid edits and
//     vice versa, observable through cel-value reference stability.

const mkEl = (tag) => {
  const L = new Map();
  const el = {
    nodeType: 1, tag, tagName: tag.toUpperCase(), value: undefined, childNodes: [], attrs: {}, _L: L,
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
const fingerprint = (n) => {
  if (n.nodeType === 3) return JSON.stringify(n.data);
  const attrs = Object.entries(n.attrs ?? {}).sort().map(([k, v]) => `${k}=${v}`).join(",");
  return `<${n.tag} ${attrs}>[${(n.childNodes ?? []).map(fingerprint).join("")}]`;
};
const mockRaf = () => { const q = []; return { raf: (cb) => q.push(cb), caf: () => {}, run: () => { for (const cb of q.splice(0)) cb(); } }; };

const CELLS = { A1: "10", B1: "=A1*2", A2: "x", B2: "3" };

const boot = async (monolithicToolbar) => {
  const root = mkEl("app");
  globalThis.document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }), querySelector: (s) => (s === "#app" ? root : null) };
  const m = mockRaf();
  const state = createInitialState();
  if (state.cels.get("元.mount")) state.cels.get("元.mount").v = null; // host owns #app (origin opt-out until roadmap 08)
  setPainter(state, createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: true, doc: globalThis.document, resolveMount: (x) => (x === "#app" ? root : null) }));
  await buildSheetsApp(state, { rows: 4, cols: 3, cells: CELLS, monolithicToolbar });
  await precomputeOptional(state);
  await resolveFn(state, "setValue")(state, "os.active", "sheets");
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "plastron-dom.paint");
  m.run();
  const drain = async () => { await resolveFn(state, "drain")(state, "plastron-dom.paint"); m.run(); };
  return { root, state, drain };
};

// Deterministic pseudo-random script (no Math.random — reproducible).
const SCRIPT = [];
let seed = 42;
const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
for (let i = 0; i < 40; i++) {
  const kind = rnd(3);
  if (kind === 0) SCRIPT.push({ op: "edit", addr: ["A1", "B2", "A2"][rnd(3)], input: String(rnd(50)) });
  else if (kind === 1) SCRIPT.push({ op: "select", addr: ["A1", "B1", "B2", "C3"][rnd(4)] });
  else SCRIPT.push({ op: "noop-edit", addr: "B2" });
}

const runScript = async ({ state, drain }) => {
  const commit = resolveFn(state, "sheet.commit-cell");
  const click = resolveFn(state, "sheet.click");
  let last = "7";
  for (const step of SCRIPT) {
    if (step.op === "edit") { last = step.input; await commit(state, { addr: step.addr, input: step.input }); }
    else if (step.op === "noop-edit") await commit(state, { addr: step.addr, input: last });
    else await click(state, step.addr);
    await drain();
  }
};

test("DOM-fingerprint identity: fragmented ≡ monolithic across a randomized script", async () => {
  const frag = await boot(false);
  await runScript(frag);
  const mono = await boot(true);
  await runScript(mono);
  assert.equal(fingerprint(frag.root), fingerprint(mono.root), "fragment and monolithic worlds painted different DOM");
});

test("fragment locality: grid edits never recompute the toolbar; doc changes never recompute cell views", async () => {
  const { state, drain } = await boot(false);
  const commit = resolveFn(state, "sheet.commit-cell");
  const setValue = resolveFn(state, "setValue");

  const toolbarBefore = state.cels.get("sheet.toolbar.view").v;
  const cellViewBefore = state.cels.get("sheet.A1.view").v;

  // 10 grid edits — toolbar fragment must keep its reference.
  for (let i = 0; i < 10; i++) { await commit(state, { addr: "A1", input: String(i) }); await drain(); }
  assert.equal(state.cels.get("sheet.toolbar.view").v, toolbarBefore, "toolbar recomputed on grid edits");

  // a doc change — toolbar recomputes, untouched cell views keep refs.
  const a2Before = state.cels.get("sheet.A2.view").v;
  await setValue(state, "os.doc", "budget.csv"); await drain();
  assert.notEqual(state.cels.get("sheet.toolbar.view").v, toolbarBefore, "toolbar must reflect the doc name");
  assert.equal(state.cels.get("sheet.A2.view").v, a2Before, "cell views refired on a doc change");
  assert.notEqual(cellViewBefore, undefined);
});
