import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../dist/index.js";

// origin — the starting point (origin-segment.md, accepted). The boot
// contract paints ONE visible cel; the entry gesture makes cels; a
// grid blooms from a formula and is swept when the formula goes.

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
const boxes = (root) => walk(root, (n) => n.tag === "div" && String(n.attrs.class ?? "").startsWith("cel"));
const boxByKey = (root, key) => boxes(root).find((b) => b.attrs["data-key"] === key);
const mockRaf = () => { const q = []; return { raf: (cb) => q.push(cb), caf: () => {}, run: () => { for (const cb of q.splice(0)) cb(); } }; };

// THE BOOT CONTRACT — two lines (plus the test painter).
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
  await resolveFn(state, "ensureSegments")(state, ["origin"]); // origin is a host choice (parked by default)
  await resolveFn(state, "hydrate")(state, [], []);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "plastron-dom.paint");
  m.run();
  return { state, root, m };
};

const type = async (state, root, m, source, target = "元") => {
  await resolveFn(state, "setValue")(state, "元.draft", source);
  await resolveFn(state, "origin.commit")(state, target);
  m.run();
};

test("boot contract: hydrate paints exactly one visible cel — the origin, readme inside", async () => {
  const { state, root } = await boot();
  const bs = boxes(root);
  assert.equal(bs.length, 1, "one visible cel above the invisible floor");
  assert.equal(bs[0].attrs["data-key"], "元");
  assert.match(txt(bs[0]), /you are at the origin/, "the readme is the value, rendered");
  // the floor exists but is invisible
  assert.ok(state.cels.get("setValue"), "kernel cels present");
  assert.ok(state.cels.get("genesis.commit"), "genesis in the firmware closure");
});

test("entry gesture: =1+1 becomes c1 showing 2; literals become ValueCels", async () => {
  const { state, root, m } = await boot();
  await type(state, root, m, "=1+1");
  assert.ok(boxByKey(root, "c1"), "c1 box appeared");
  assert.match(txt(boxByKey(root, "c1")), /2/, "computed value shown");
  assert.equal(state.cels.get("c1").metadata.segment, "freespace");

  await type(state, root, m, "hello");
  assert.equal(state.cels.get("c2").celType, "ValueCel");
  await type(state, root, m, "(+ 2 3)");
  assert.match(txt(boxByKey(root, "c3")), /5/, "s-expr sniffed");
});

test("grid bloom and sweep — the north-star invariant at the origin", async () => {
  const { state, root, m } = await boot();
  await type(state, root, m, '=grid(2, 2, "g")');
  assert.ok(state.cels.get("g.A1"), "grid bloomed from the typed formula");
  assert.equal(state.cels.get("g.A1").metadata.generatedBy, "c1");
  // bloom is INVISIBLE in freespace (layer segment, not freespace)
  assert.equal(boxByKey(root, "g.A1"), undefined, "grid cells are not freespace boxes");
  assert.ok(boxByKey(root, "c1"), "the generator cel is the visible thing");

  // delete the formula: open c1, commit empty
  await resolveFn(state, "origin.expand")(state, "c1"); m.run();
  await type(state, root, m, "", "c1");
  assert.equal(state.cels.get("c1"), undefined, "formula cel deleted");
  assert.equal(state.cels.get("g.A1"), undefined, "bloom swept");
  assert.equal(boxes(root).length, 1, "freespace is one cel again");
});

test("editing an open cel commits in place; cross-grid formulas work from freespace", async () => {
  const { state, root, m } = await boot();
  await type(state, root, m, '=grid(2, 1, "books")');
  await resolveFn(state, "setValue")(state, "books.A1", 7);
  await type(state, root, m, "=books!A1 * 3");
  assert.match(txt(boxByKey(root, "c2")), /21/);

  // edit c2 in place
  await resolveFn(state, "origin.expand")(state, "c2"); m.run();
  assert.equal(state.cels.get("元.draft").v, "=books!A1 * 3", "draft seeded with source");
  await type(state, root, m, "=books!A1 + 1", "c2");
  assert.match(txt(boxByKey(root, "c2")), /8/, "in-place edit recomputed");
});

test("=cels(\"sheet\") lists a segment; =load reports; unknown symbols show #NAME?", async () => {
  const { state, root, m } = await boot();
  await type(state, root, m, '=cels("sheet")');
  const listing = String(state.cels.get("c1").v);
  assert.match(listing, /grid\s+\[LockedLambdaCel/, "segment members listed");

  await type(state, root, m, "=nosuchthing(1)");
  assert.match(txt(boxByKey(root, "c2")), /#NAME\?/, "clean unknown-symbol display");
});

test("=checkpoint + restore round-trips freespace", async () => {
  const { state, root, m } = await boot();
  await type(state, root, m, "=40+2");
  await type(state, root, m, '=checkpoint("good")');
  await resolveFn(state, "drain")(state, "checkpoint.commit");
  await type(state, root, m, "=9000");
  assert.ok(boxByKey(root, "c3"));
  await resolveFn(state, "checkpoint.restore")(state, "good");
  await resolveFn(state, "drain")(state, "plastron-dom.paint"); m.run();
  assert.equal(state.cels.get("c3"), undefined, "post-snapshot cel gone after restore");
  assert.match(txt(boxByKey(root, "c1")), /42/, "pre-snapshot cel restored");
});

test("readme() makes a banner div above freespace; deleting the formula removes it", async () => {
  const { state, root, m } = await boot();
  const banner = () => boxes(root) && walk(root, (n) => String(n.attrs?.class ?? "") === "readme-banner")[0];

  assert.equal(banner(), undefined, "no banner before the formula");

  await type(state, root, m, "=readme()");
  assert.ok(state.cels.get("freespace.banner")?.v, "banner cel generated");
  assert.ok(banner(), "banner div painted above freespace");
  assert.match(txt(banner()), /you are at the origin/, "banner shows the readme text");

  // delete the generating formula → genesis sweep → banner gone
  await resolveFn(state, "origin.expand")(state, "c1"); m.run();
  await type(state, root, m, "", "c1");
  assert.equal(state.cels.get("freespace.banner")?.v, undefined, "banner cel swept");
  assert.equal(banner(), undefined, "banner div disappeared with its formula");
});
