import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// viz-core — the medium-agnostic encoding layer. Scales are pure DATA SPECS;
// scaleapply/bandwidth/ticks/scaleinvert/colorapply consume them. All pure +
// deterministic → these are Tier-A unit tests, no DOM, no browser.

const fn = (s, k) => resolveFn(s, k);

test("linscale: linear map, inverted range, degenerate domain", () => {
  const s = createInitialState();
  const lin = fn(s, "linscale")(0, 100, 0, 400);
  assert.equal(lin.t, "lin");
  assert.equal(fn(s, "scaleapply")(lin, 0), 0);
  assert.equal(fn(s, "scaleapply")(lin, 100), 400);
  assert.equal(fn(s, "scaleapply")(lin, 50), 200, "midpoint");
  assert.equal(fn(s, "scaleapply")(lin, 200), 800, "un-clamped beyond domain");
  // inverted range (screen y grows down): hi value → small y
  const y = fn(s, "linscale")(0, 100, 380, 0);
  assert.ok(fn(s, "scaleapply")(y, 100) < fn(s, "scaleapply")(y, 0), "100 sits higher (smaller y)");
  // degenerate domain doesn't divide by zero
  const deg = fn(s, "linscale")(5, 5, 0, 400);
  assert.equal(fn(s, "scaleapply")(deg, 5), 0);
});

test("scaleinvert: linear is the exact inverse of scaleapply", () => {
  const s = createInitialState();
  const lin = fn(s, "linscale")(10, 50, 100, 300);
  for (const v of [10, 22, 37, 50]) {
    const px = fn(s, "scaleapply")(lin, v);
    assert.ok(Math.abs(fn(s, "scaleinvert")(lin, px) - v) < 1e-9, `invert(apply(${v}))===${v}`);
  }
});

test("bandscale: even bands, start + width, padding", () => {
  const s = createInitialState();
  const band = fn(s, "bandscale")(["a", "b", "c", "d"], 0, 400, 0); // no pad
  assert.equal(band.t, "band");
  assert.equal(fn(s, "bandwidth")(band), 100, "4 bands across 400, no pad → 100 wide");
  assert.equal(fn(s, "scaleapply")(band, "a"), 0);
  assert.equal(fn(s, "scaleapply")(band, "c"), 200, "by label");
  assert.equal(fn(s, "scaleapply")(band, 1), 100, "by 0-based index");
  // padding shrinks the bar and offsets its start toward the slot center
  const padded = fn(s, "bandscale")(["a", "b"], 0, 200, 0.2);
  assert.ok(fn(s, "bandwidth")(padded) < 100, "pad shrinks bandwidth");
  assert.ok(fn(s, "scaleapply")(padded, "a") > 0, "pad offsets the start");
  assert.equal(fn(s, "bandwidth")(fn(s, "linscale")(0, 1, 0, 1)), 0, "non-band → 0 width");
});

test("scaleinvert: band returns the label nearest a pixel", () => {
  const s = createInitialState();
  const band = fn(s, "bandscale")(["jan", "feb", "mar"], 0, 300, 0);
  assert.equal(fn(s, "scaleinvert")(band, 10), "jan");
  assert.equal(fn(s, "scaleinvert")(band, 150), "feb");
  assert.equal(fn(s, "scaleinvert")(band, 295), "mar");
});

test("ticks: linear gives nice round values within domain; positions track the scale", () => {
  const s = createInitialState();
  const lin = fn(s, "linscale")(0, 100, 0, 500);
  const tk = fn(s, "ticks")(lin, 5);
  assert.ok(tk.length >= 4, "several ticks");
  const vals = tk.map((t) => t.v);
  assert.deepEqual(vals, [0, 20, 40, 60, 80, 100], "nice step of 20");
  // each tick's pos is exactly scaleapply(value)
  for (const t of tk) assert.equal(t.pos, fn(s, "scaleapply")(lin, t.v));
  // an ugly domain still yields round ticks, all within [lo,hi]
  const ugly = fn(s, "ticks")(fn(s, "linscale")(3, 97, 0, 100), 5);
  for (const t of ugly) assert.ok(t.v >= 3 && t.v <= 97, `tick ${t.v} within domain`);
});

test("ticks: band gives one centered tick per label", () => {
  const s = createInitialState();
  const band = fn(s, "bandscale")(["x", "y", "z"], 0, 300, 0);
  const tk = fn(s, "ticks")(band);
  assert.equal(tk.length, 3);
  assert.deepEqual(tk.map((t) => t.label), ["x", "y", "z"]);
  // centered: start (0) + half bandwidth (50) = 50
  assert.equal(tk[0].pos, 50);
});

test("nice: rounds an interval outward to a 1/2/5 step", () => {
  const s = createInitialState();
  assert.deepEqual(fn(s, "nice")(0, 97, 5), [0, 100, 20]);
  const [lo, hi, step] = fn(s, "nice")(3, 47, 5);
  assert.ok(lo <= 3 && hi >= 47 && step > 0, "endpoints engulf the data");
  assert.equal((hi - lo) % step, 0, "span is a whole number of steps");
});

test("extent: min/max over finite numbers in a nested range; blanks/junk ignored", () => {
  const s = createInitialState();
  assert.deepEqual(fn(s, "extent")([3, 1, 4, 1, 5, 9, 2, 6]), [1, 9]);
  assert.deepEqual(fn(s, "extent")([[10], [20], ["", null, "x"], [5]]), [5, 20], "flattens + drops non-numbers");
  assert.deepEqual(fn(s, "extent")([]), [0, 1], "empty → unit");
});

test("colorscale + colorapply: RGB lerp between endpoints, clamped", () => {
  const s = createInitialState();
  const cs = fn(s, "colorscale")(0, 100, "#000000", "#ffffff");
  assert.equal(fn(s, "colorapply")(cs, 0), "#000000", "domain lo → c0");
  assert.equal(fn(s, "colorapply")(cs, 100), "#ffffff", "domain hi → c1");
  assert.equal(fn(s, "colorapply")(cs, 50), "#808080", "midpoint → mid gray");
  assert.equal(fn(s, "colorapply")(cs, -50), "#000000", "below domain clamps to c0");
  assert.equal(fn(s, "colorapply")(cs, 999), "#ffffff", "above domain clamps to c1");
  // defaults produce a valid hex
  assert.match(fn(s, "colorapply")(fn(s, "colorscale")(0, 1), 0.5), /^#[0-9a-f]{6}$/);
});

test("ordinalcolor: categorical palette, by index or by key membership, wraps", () => {
  const s = createInitialState();
  const c0 = fn(s, "ordinalcolor")(0), c1 = fn(s, "ordinalcolor")(1);
  assert.match(c0, /^#[0-9a-f]{6}$/);
  assert.notEqual(c0, c1, "distinct indices → distinct colors");
  assert.equal(fn(s, "ordinalcolor")(10), c0, "palette of 10 wraps at 10");
  // by key against a key list → stable per category
  const keys = ["apac", "emea", "amer"];
  assert.equal(fn(s, "ordinalcolor")("emea", keys), fn(s, "ordinalcolor")(1));
  assert.equal(fn(s, "ordinalcolor")("amer", keys), fn(s, "ordinalcolor")(2));
});

test("scales are plain serialisable data (survive a JSON round-trip)", () => {
  const s = createInitialState();
  const lin = fn(s, "linscale")(0, 100, 0, 400);
  const reborn = JSON.parse(JSON.stringify(lin));
  assert.equal(fn(s, "scaleapply")(reborn, 25), fn(s, "scaleapply")(lin, 25), "spec is just data");
});
