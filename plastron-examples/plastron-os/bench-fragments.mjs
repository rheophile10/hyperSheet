// Fragment-vs-monolithic Sheets bench (vnode-valuecel-collapse.md).
// Wall-time only — run per-world in a fresh process: `bun bench-fragments.mjs frag|mono`
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../../plastron/dist/index.js";
import { buildSheetsApp } from "./sheets.ts";

const mkEl = (tag) => {
  const L = new Map();
  const el = { nodeType: 1, tag, childNodes: [], attrs: {}, style: { props: {}, setProperty(p, v) { this.props[p] = v; }, removeProperty(p) { delete this.props[p]; } },
    get firstChild() { return this.childNodes[0] ?? null; }, get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; },
    setAttribute(n, v) { this.attrs[n] = v; }, removeAttribute(n) { delete this.attrs[n]; },
    appendChild(c) { this.childNodes.push(c); return c; }, removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; },
    replaceChild(n, o) { const i = this.childNodes.indexOf(o); if (i >= 0) this.childNodes[i] = n; return o; },
    insertBefore(n, r) { const i = r ? this.childNodes.indexOf(r) : -1; if (i >= 0) this.childNodes.splice(i, 0, n); else this.childNodes.push(n); return n; },
    replaceChildren(...c) { this.childNodes = [...c]; },
    addEventListener(t, fn) { (L.get(t) ?? L.set(t, new Set()).get(t)).add(fn); }, removeEventListener(t, fn) { L.get(t)?.delete(fn); }, fire() {} };
  return el;
};
const mockRaf = () => { const q = []; return { raf: (cb) => q.push(cb), caf: () => {}, run: () => { for (const cb of q.splice(0)) cb(); } }; };
const CELLS = { A1: "Item", B1: "Qty", C1: "Price", D1: "Total", A2: "Widget", B2: "3", C2: "4", D2: "=B2*C2", A3: "Gadget", B3: "5", C3: "2", D3: "=B3*C3", D4: "=D2+D3" };

const run = async (monolithic) => {
  const root = mkEl("app");
  globalThis.document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }), querySelector: (s) => (s === "#app" ? root : null) };
  const m = mockRaf();
  const state = createInitialState();
  setPainter(state, createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: true, doc: globalThis.document, resolveMount: (x) => (x === "#app" ? root : null) }));
  await buildSheetsApp(state, { rows: 8, cols: 5, cells: CELLS, monolithicToolbar: monolithic });
  await precomputeOptional(state);
  await resolveFn(state, "setValue")(state, "os.active", "sheets");
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "dom.paint"); m.run();
  const commit = resolveFn(state, "sheet.commit-cell");
  const click = resolveFn(state, "sheet.click");
  const drain = async () => { await resolveFn(state, "drain")(state, "dom.paint"); m.run(); };
  const phase = async (n, fn) => { const t0 = performance.now(); for (let i = 0; i < n; i++) await fn(i); return +(performance.now() - t0).toFixed(1); };
  return {
    edit:   await phase(100, async (i) => { await commit(state, { addr: "B2", input: String(i + 1) }); await drain(); }),
    noop:   await phase(100, async () => { await commit(state, { addr: "B2", input: "100" }); await drain(); }),
    select: await phase(60, async (i) => { await click(state, i % 2 ? "A1" : "C3"); await drain(); }),
  };
};

const world = process.argv[2] === "mono";
await run(world);                        // warmup, discarded
console.log(process.argv[2], JSON.stringify(await run(world)));
