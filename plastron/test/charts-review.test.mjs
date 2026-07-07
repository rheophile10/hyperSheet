import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// REVIEWER extension tests (card 35137405) — cover linechart x-label clamp
// promises from design §4 that the shipped charts.test does NOT exercise:
//   (a) the LEFT clamp actually fires — a long FIRST label that would spill
//       past the left edge under bare centering is left-anchored to the box.
//       (Shipped data's first label "Galápagos" never overflows left, so the
//       Math.max(lo, …) branch is untested by the delivered suite.)
//   (b) the clamp respects a NON-ZERO box origin b.x — labels stay within
//       [b.x, b.x+b.w], not [0, w]. All shipped usage passes x=0.
//   (c) barchart / piechart are untouched — labels still ellipsize via clip()
//       (the design's one-change discipline: only linechart changed).

const PX = 9, EM = 0.52;
const widthOf = (t) => t.length * PX * EM;

test("linechart: a long FIRST label is left-anchored into the box (left clamp fires)", () => {
  const s = createInitialState();
  // A long first label that SURVIVES clip() (2 points → generous per-label width
  // budget floor((w−52)/2/5.5)=38 chars) yet is wide enough that px(0)=padL=38
  // center-anchoring puts its left edge negative → the clamp must pin it to lo=b.x.
  const LABELS = ["Aldabra giant tortoise sea turtle", "Loggerhead"];
  const VALUES = [10, 40];
  const w = 480, h = 300;
  const ops = resolveFn(s, "linechart")(LABELS, VALUES, 0, 0, w, h);
  const xlabels = ops.filter((o) => o.op === "text" && o.y === h - 5);
  assert.equal(xlabels.length, 2, "one x-axis label per point");
  const first = xlabels[0];
  // it WOULD overflow left under bare centering (px(0)=38, half-width ~ 53 → x<0)
  const centeredFirst = 38 - widthOf(first.text) / 2;
  assert.ok(centeredFirst < 0, "the first label would spill past the left edge if bare-centered");
  // …and is instead pinned to the box's left edge, still fully inside on the right
  assert.ok(Math.abs(first.x - 0) < 1e-9, `first label left-anchored to box edge (x=${first.x})`);
  assert.ok(first.x + widthOf(first.text) <= w + 1e-9, "…and still fits within the box width");
  // every label stays in [0, w]
  for (const o of xlabels) {
    assert.ok(o.x >= -1e-9, `'${o.text}' left edge in box`);
    assert.ok(o.x + widthOf(o.text) <= w + 1e-9, `'${o.text}' right edge in box`);
  }
});

test("linechart: the x-label clamp respects a NON-ZERO box origin", () => {
  const s = createInitialState();
  const SPECIES = ["Galápagos", "Leatherback", "Green sea", "Box", "Snapping", "Painted", "Loggerhead"];
  const SPEED = [0.3, 35, 32, 0.5, 2, 1.5, 24];
  const bx = 120, by = 40, w = 480, h = 300;
  const ops = resolveFn(s, "linechart")(SPECIES, SPEED, bx, by, w, h);
  const xlabels = ops.filter((o) => o.op === "text" && o.y === by + h - 5);
  assert.equal(xlabels.length, 7, "one x-axis label per point");
  for (const o of xlabels) {
    assert.ok(o.x >= bx - 1e-9, `'${o.text}' left edge ≥ box origin ${bx} (x=${o.x})`);
    assert.ok(o.x + widthOf(o.text) <= bx + w + 1e-9, `'${o.text}' right edge ≤ ${bx + w} (right=${o.x + widthOf(o.text)})`);
  }
  // the terminal label right-anchored to the box's right edge (bx + w)
  const last = xlabels[6];
  assert.ok(Math.abs(last.x - (bx + w - widthOf(last.text))) < 1e-9, "terminal label right-anchored to bx+w");
});

test("barchart/piechart are untouched — long labels still ellipsize via clip()", () => {
  const s = createInitialState();
  // narrow bar slots → clip() shortens labels to fit, appending '…'. This pins
  // that the developer left barchart's label path alone (no centeredIn there).
  const LABELS = ["Aldabra giant tortoise", "Leatherback sea turtle", "Loggerhead sea turtle"];
  const bar = resolveFn(s, "barchart")(LABELS, [1, 2, 3], 0, 0, 200, 160);
  const barLabels = bar.filter((o) => o.op === "text" && o.font === "9px system-ui").map((o) => o.text);
  assert.ok(barLabels.some((t) => /…/.test(t)), "barchart still ellipsizes overlong labels (clip path intact)");
  // piechart legend clip() at 16 chars
  const pie = resolveFn(s, "piechart")(LABELS, [1, 2, 3], 0, 0, 300, 200);
  const legend = pie.filter((o) => o.op === "text" && /\(\d+%\)/.test(o.text));
  assert.ok(legend.some((o) => /…/.test(o.text)), "piechart legend still clips overlong labels");
});
