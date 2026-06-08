import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";

// plastron-canvas — formula-authored 2d graphics (plastron-canvas.md, accepted).
// The vocabulary fns are pure: they return draw-op values; canvas() wraps them
// in a <canvas> vnode carrying a data-ops draw-spec the painter replays. (The
// replay onto a real 2d context is covered by the origin Playwright suite.)

test("vocabulary fns return draw-op values", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["plastron-canvas"]);
  await precomputeOptional(state);
  const rect = resolveFn(state, "rect");
  const text = resolveFn(state, "text");
  const line = resolveFn(state, "line");
  const circle = resolveFn(state, "circle");

  const r = rect(1, 2, 10, 20, "#fff", "#000", 2);
  assert.equal(r.op, "rect");
  assert.deepEqual([r.x, r.y, r.w, r.h, r.fill, r.stroke, r.lineWidth], [1, 2, 10, 20, "#fff", "#000", 2]);

  const t = text(5, 8, "hi", "#222", "12px system-ui");
  assert.deepEqual([t.op, t.x, t.y, t.text, t.fill, t.font], ["text", 5, 8, "hi", "#222", "12px system-ui"]);

  const l = line(0, 0, 10, 10, "#f00", 3);
  assert.equal(l.op, "line");
  assert.deepEqual(l.points, [[0, 0], [10, 10]]);

  const c = circle(50, 50, 8, "#0f0");
  assert.deepEqual([c.op, c.x, c.y, c.r, c.fill], ["circle", 50, 50, 8, "#0f0"]);
});

test("canvas() is a <canvas> vnode carrying its ops as a data-ops spec", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["plastron-canvas"]);
  await precomputeOptional(state);
  const rect = resolveFn(state, "rect");
  const text = resolveFn(state, "text");
  const canvas = resolveFn(state, "canvas");

  const cv = canvas(300, 80, rect(0, 0, 300, 80, "#222"), text(10, 40, "hi", "#fff"));
  assert.equal(cv.type, "el");
  assert.equal(cv.tag, "canvas");
  assert.equal(cv.attrs.width, 300);
  assert.equal(cv.attrs.height, 80);
  const ops = JSON.parse(cv.attrs["data-ops"]);
  assert.equal(ops.length, 2, "two ops");
  assert.equal(ops[0].op, "rect");
  assert.equal(ops[1].op, "text");

  // non-op args (a stray string) are filtered out of the spec
  const cv2 = canvas(10, 10, "junk", rect(0, 0, 10, 10, "#000"));
  assert.equal(JSON.parse(cv2.attrs["data-ops"]).length, 1, "only real ops kept");
});
