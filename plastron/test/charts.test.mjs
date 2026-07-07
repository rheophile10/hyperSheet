import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";
import { drawCanvases } from "../dist/甲骨坑/library/dom/utils/canvas.js";

// charts — barchart/linechart/piechart over the plastron-canvas draw-spec.
// The fns are pure (labels, values → op lists); canvas() concats op lists
// into one data-ops spec; the painter replays the new wedge op. The demo
// shape is the live contract: a grid sheet feeds a chart FORMULA through
// column ranges, and member edits re-render the chart.

const LABELS = ["Galapagos tortoise", "Leatherback", "Box turtle"];
const VALUES = [177, 50, 100];

test("barchart: bg + one bar/value/label per row + baseline; blanks drop out", () => {
  const s = createInitialState();
  const ops = resolveFn(s, "barchart")(LABELS, VALUES, 0, 0, 420, 260);
  assert.equal(ops[0].op, "rect");
  assert.deepEqual([ops[0].w, ops[0].h], [420, 260], "background covers the box");
  const bars = ops.slice(1).filter((o) => o.op === "rect");
  assert.equal(bars.length, 3, "one bar per row");
  const tallest = Math.max(...bars.map((o) => o.h));
  assert.equal(bars[0].h, tallest, "177 is the tallest bar");
  const texts = ops.filter((o) => o.op === "text").map((o) => o.text);
  assert.ok(texts.includes("177"), "value above the bar");
  assert.ok(texts.some((t) => t.startsWith("Leatherback") || t.includes("…")), "label below");
  // a blank row is skipped, not drawn as a zero bar
  const ops2 = resolveFn(s, "barchart")(["a", "", "c"], [1, "", 3]);
  assert.equal(ops2.filter((o) => o.op === "rect").length - 1, 2, "blank row dropped");
});

test("linechart: one polyline through all points + dots + gridlines", () => {
  const s = createInitialState();
  const ops = resolveFn(s, "linechart")(LABELS, VALUES, 0, 0, 420, 260);
  const lines = ops.filter((o) => o.op === "line");
  const poly = lines.find((o) => o.points.length === 3);
  assert.ok(poly, "the series polyline has one point per row");
  const ys = poly.points.map((p) => p[1]);
  assert.ok(ys[0] < ys[1], "177 sits higher (smaller y) than 50");
  assert.equal(ops.filter((o) => o.op === "circle").length, 3, "a dot per point");
  assert.ok(lines.length >= 4, "three gridlines + the series");
});

test("linechart: the terminal x-label is clamped inside the box (interior labels unchanged)", () => {
  const s = createInitialState();
  // the shipped seven species, longest-labelled last ("Loggerhead") — the story's
  // opening 'all' view; the terminal point sits at w−padR so its centered label
  // overflowed the right edge on the pre-clamp verb.
  const SPECIES = ["Galápagos", "Leatherback", "Green sea", "Box", "Snapping", "Painted", "Loggerhead"];
  const SPEED = [0.3, 35, 32, 0.5, 2, 1.5, 24];
  const w = 480, h = 300, PX = 9, EM = 0.52;           // EM = the verb's own em-width estimate (centered()/the clamp)
  const widthOf = (t) => t.length * PX * EM;
  const ops = resolveFn(s, "linechart")(SPECIES, SPEED, 0, 0, w, h);

  // the x-axis labels sit on the bottom row (y = h − 5), one per point, in order
  const xlabels = ops.filter((o) => o.op === "text" && o.y === h - 5);
  assert.equal(xlabels.length, 7, "one x-axis label per point");
  const poly = ops.find((o) => o.op === "line" && o.points.length === 7);
  const cx = poly.points.map((p) => p[0]);              // px(i) — the point x's the labels center under

  // (1) EVERY x-axis label lies fully within [0, w] — the §4 no-clip promise
  for (const o of xlabels) {
    assert.ok(o.x >= 0, `label '${o.text}' left edge in box (x=${o.x})`);
    assert.ok(o.x + widthOf(o.text) <= w + 1e-9, `label '${o.text}' right edge in box (right=${o.x + widthOf(o.text)})`);
  }

  // (2) the LAST label WOULD overflow if left center-anchored (this is what the
  //     pre-clamp verb did) and is now right-anchored to the box edge instead
  const last = xlabels[6];
  const centeredLast = cx[6] - widthOf(last.text) / 2;
  assert.ok(centeredLast + widthOf(last.text) > w, "the terminal label would overflow under bare centering");
  assert.ok(Math.abs(last.x - (w - widthOf(last.text))) < 1e-9, "the terminal label is right-anchored to the box edge");

  // (3) INTERIOR labels are untouched — still exactly center-anchored (clamp no-op)
  for (let i = 1; i <= 5; i++) {
    const expected = cx[i] - widthOf(xlabels[i].text) / 2;
    assert.ok(Math.abs(xlabels[i].x - expected) < 1e-9, `interior label ${i} ('${xlabels[i].text}') stays center-anchored`);
  }

  // (4) the FIRST label keeps its left edge in the box (left-clamp guard)
  assert.ok(xlabels[0].x >= 0, "first label left edge stays in box");
});

test("piechart: wedges close the circle, shares match, legend rows", () => {
  const s = createInitialState();
  const ops = resolveFn(s, "piechart")(LABELS, VALUES, 0, 0, 420, 260);
  const wedges = ops.filter((o) => o.op === "wedge");
  assert.equal(wedges.length, 3);
  assert.ok(Math.abs(wedges[0].a0 - -Math.PI / 2) < 1e-9, "starts at 12 o'clock");
  for (let i = 1; i < wedges.length; i++) assert.equal(wedges[i].a0, wedges[i - 1].a1, "wedges are contiguous");
  assert.ok(Math.abs(wedges[2].a1 - wedges[0].a0 - Math.PI * 2) < 1e-9, "wedges close the circle");
  const share = (wedges[0].a1 - wedges[0].a0) / (Math.PI * 2);
  assert.ok(Math.abs(share - 177 / 327) < 1e-9, "wedge angle ∝ value");
  const legend = ops.filter((o) => o.op === "text" && /\(\d+%\)/.test(o.text));
  assert.equal(legend.length, 3, "a legend row per slice");
  // non-positive values drop out of the pie
  const ops2 = resolveFn(s, "piechart")(["a", "b"], [5, -1]);
  assert.equal(ops2.filter((o) => o.op === "wedge").length, 1);
});

test("canvas() flattens chart op lists into the data-ops spec", () => {
  const s = createInitialState();
  const cv = resolveFn(s, "canvas")(420, 260, resolveFn(s, "barchart")(LABELS, VALUES));
  assert.equal(cv.tag, "canvas");
  const ops = JSON.parse(cv.attrs["data-ops"]);
  assert.ok(ops.length > 5, "op list flattened in");
  assert.equal(ops[0].op, "rect");
});

test("painter replays the wedge op onto the 2d context", () => {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_, p) => (p === "fillStyle" || p === "strokeStyle" || p === "lineWidth" || p === "font"
      ? undefined : (...args) => { calls.push([p, args]); }),
    set: () => true,
  });
  const fake = {
    nodeType: 1, tagName: "CANVAS", width: 100, height: 100, childNodes: [],
    getAttribute: (n) => (n === "data-ops" ? JSON.stringify([{ op: "wedge", cx: 50, cy: 50, r: 40, a0: 0, a1: 1, fill: "#f00" }]) : null),
    getContext: () => ctx,
  };
  drawCanvases(fake);
  const names = calls.map(([p]) => p);
  assert.ok(names.includes("moveTo"), "starts at the center");
  assert.ok(names.includes("arc") && names.includes("closePath") && names.includes("fill"), "arc → close → fill");
});

// ── the live demo shape: a grid feeds a chart formula through ranges ─────────

const genesisFlush = async (state) => {
  await resolveFn(state, "drain")(state, "genesis.commit");
  await resolveFn(state, "genesis.drain")([], state);
};

test("a chart formula over sheet ranges renders and tracks member edits", async () => {
  const state = createInitialState();
  const setCel = resolveFn(state, "setCel"), setValue = resolveFn(state, "setValue"), runCycle = resolveFn(state, "runCycle");
  await setCel(state, "maker", { celType: "FormulaCel", f: '(cels 3 2 "t")', metadata: { segment: "user" } });
  await runCycle(state);
  await genesisFlush(state);
  await setValue(state, "t.A1", "leatherback"); await setValue(state, "t.B1", 50);
  await setValue(state, "t.A2", "box turtle");  await setValue(state, "t.B2", 100);
  await setValue(state, "t.A3", "snapper");     await setValue(state, "t.B3", 47);
  await setCel(state, "chart", {
    celType: "FormulaCel", f: "=canvas(300, 200, barchart(t!A1:A3, t!B1:B3))",
    metadata: { segment: "user", parser: "infix" },
  });
  await precomputeOptional(state);
  await runCycle(state);
  const cv = state.cels.get("chart").v;
  assert.equal(cv.tag, "canvas", "the formula's value is a canvas vnode");
  const bars = JSON.parse(cv.attrs["data-ops"]).slice(1).filter((o) => o.op === "rect");
  assert.equal(bars.length, 3, "one bar per sheet row");
  const h100 = bars[1].h;
  await setValue(state, "t.B2", 200); // edit a member → the chart re-renders
  const bars2 = JSON.parse(state.cels.get("chart").v.attrs["data-ops"]).slice(1).filter((o) => o.op === "rect");
  assert.ok(bars2[1].h >= h100, "edited bar at least as tall");
  assert.ok(bars2[0].h < bars[0].h, "other bars rescale against the new max");
});
