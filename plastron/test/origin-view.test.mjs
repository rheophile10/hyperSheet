import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, precomputeOptional, resolveFn, createPainter, setPainter,
} from "../dist/index.js";

// ============================================================================
// =view (aliases: =append two-arg, =domview deprecated) is a GENERATIVE
// formula: the formula SURVIVES in the cell (Excel contract — the bar shows
// the recipe when active, the grid shows the ⧉ token when not), effects are
// idempotent (re-fires re-open / re-contribute harmlessly, so a saved sheet
// re-creates its panes), and each contributing cell owns ONE keyed SLOT in
// the pane (re-fires replace, edits update).
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
  const r = (k) => resolveFn(state, k);
  await r("ensureSegments")(state, ["origin"]);
  await r("hydrate")(state, [], []);
  await precomputeOptional(state);
  await r("runCycle")(state);
  await r("origin.run")(state, "元");
  // a minimal workbook for domview to attach its pane to
  const g = r("wbopen")("t", "T", [{ ref: "tc.body", title: "S" }], []);
  await r("setCel")(state, "tc.body", { celType: "ValueCel", v: { type: "el", tag: "div", children: [] }, metadata: { segment: "tc" } });
  await r("setCelBatch")(state, g.cels);
  await r("runCycle")(state);
  const cycle = async () => { await r("runCycle")(state); await r("drain")(state, "origin.effects"); await r("drain")(state, "dom.paint"); m.run(); };
  return { state, r, cycle };
};

test("=view keeps its formula; the value is the ⧉ token; re-fires are idempotent", async () => {
  const { state, r, cycle } = await boot();
  await r("setCel")(state, "tst.a1", {
    celType: "FormulaCel", f: "=view('fishy')",
    metadata: { segment: "tst", name: "a1", parser: "infix", channel: ["origin.effects"] },
  });
  await cycle();

  const cel = state.cels.get("tst.a1");
  assert.equal(cel.celType, "FormulaCel", "the cell is STILL a FormulaCel (not materialized)");
  assert.equal(cel.f, "=view('fishy')", "the formula survives (the bar shows the recipe)");
  assert.deepEqual(cel.v, { view: "fishy" }, "the value is the pane token");
  assert.ok(state.cels.get("fishy.view"), "the pane's vnode-list cel exists");
  assert.ok(state.cels.get("win.t.view.fishy"), "the pane is attached to the workbook cardBook");

  // the grid renders the token as "⧉ fishy" (the ƒ-name convention for panes)
  const rendered = r("sheetcell")({ view: "fishy" });
  assert.equal(rendered.type, "text");
  assert.equal(rendered.text, "⧉ fishy");

  // idempotent re-fire: another full cycle re-runs the formula + drain
  await cycle();
  assert.equal(state.cels.get("tst.a1").celType, "FormulaCel");
  assert.deepEqual(state.cels.get("tst.a1").v, { view: "fishy" });

  // the deprecated =domview alias still evaluates (old saved sheets)
  await r("setCel")(state, "tst.old", {
    celType: "FormulaCel", f: "=domview('fishy')",
    metadata: { segment: "tst", name: "old", parser: "infix", channel: ["origin.effects"] },
  });
  await cycle();
  assert.deepEqual(state.cels.get("tst.old").v, { view: "fishy" }, "alias lands the same token");
});

test("=view with an item is a keyed CONTRIBUTION: no duplicates on re-fire, edits update in place", async () => {
  const { state, r, cycle } = await boot();
  // the two-arg form opens the pane if needed — no separate opener required
  await r("setCel")(state, "tst.a2", {
    celType: "FormulaCel", f: "=append('fishy', dom('h1', 'Hello'))",
    metadata: { segment: "tst", name: "a2", parser: "infix", channel: ["origin.effects"] },
  });
  await cycle();

  const kids = () => state.cels.get("fishy.view").v.children ?? [];
  const textOf = (n) => (n?.type === "text" ? n.text : (n?.children ?? []).map(textOf).join(""));
  assert.equal(kids().length, 1, "one contribution");
  assert.equal(kids()[0].attrs["data-cel"], "tst.a2", "the slot is keyed by the authoring cell");
  assert.ok(/Hello/.test(textOf(kids()[0])), "the item landed");
  const a2 = state.cels.get("tst.a2");
  assert.equal(a2.celType, "FormulaCel", "append cell keeps its formula too");
  assert.equal(a2.f, "=append('fishy', dom('h1', 'Hello'))");
  assert.deepEqual(a2.v, { view: "fishy", item: true });
  assert.ok(state.cels.get("fishy.view"), "the two-arg form opened the pane itself");

  // re-fire: STILL one contribution (replaced, not duplicated)
  await cycle();
  await cycle();
  assert.equal(kids().length, 1, "re-fires never duplicate the slot");

  // edit the formula → the SAME slot updates in place
  await r("setValue")(state, "tst.a2", "=append('fishy', dom('h1', 'Bye'))");
  await cycle();
  assert.equal(kids().length, 1, "editing keeps one slot");
  assert.ok(/Bye/.test(textOf(kids()[0])), "the slot updated to the new item");
  assert.equal(state.cels.get("tst.a2").f, "=append('fishy', dom('h1', 'Bye'))", "the edited formula survives");
});
