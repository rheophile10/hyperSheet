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

// ── consolidated from origin (canvas-notes §1): frames + dragdrop now live in
//    the single canvas vocabulary. These lock the op shapes the dom replay
//    switch (zone/draggable/frames cases) reads.

test("frames(): an animated trajectory op with the fields the replay reads", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["plastron-canvas"]);
  await precomputeOptional(state);
  const frames = resolveFn(state, "frames");

  const traj = [[10, 20], [30, 40], [50, 60]];
  const f = frames(traj, 12, 4);
  // dom/utils/canvas.ts `frames` case reads: frames, period, box, r, fill
  assert.equal(f.op, "frames");
  assert.deepEqual(f.frames, traj);
  assert.equal(f.r, 12);
  assert.equal(f.period, 4);
  assert.equal(f.fill, "#e91e63", "default dot fill");
  assert.ok(typeof f.box === "string", "default frame border");
  // defaults + a non-array trajectory degrade safely
  const d = frames();
  assert.deepEqual([d.r, d.period], [10, 4]);
  assert.deepEqual(d.frames, [], "non-array points → empty trajectory");
  // flattens into a canvas spec
  const cv = resolveFn(state, "canvas")(360, 280, f);
  assert.equal(JSON.parse(cv.attrs["data-ops"])[0].op, "frames");
});

test("dragdrop(): two zones + a draggable rect (the snap-target ops)", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["plastron-canvas"]);
  await precomputeOptional(state);
  const dragdrop = resolveFn(state, "dragdrop");

  const cv = dragdrop(420, 200);
  assert.equal(cv.tag, "canvas");
  assert.equal(cv.attrs.width, 420);
  const ops = JSON.parse(cv.attrs["data-ops"]);
  const zones = ops.filter((o) => o.op === "zone");
  const drag = ops.filter((o) => o.op === "draggable");
  assert.equal(zones.length, 2, "two drop zones");
  assert.deepEqual(zones.map((z) => z.label), ["A", "B"]);
  assert.equal(drag.length, 1, "one draggable rect");
  // each op carries the x/y/w/h the replay switch needs
  for (const o of ops) for (const k of ["x", "y", "w", "h"]) assert.ok(typeof o[k] === "number", `${o.op}.${k}`);
  // clamps tiny sizes to a usable minimum
  const tiny = dragdrop(1, 1);
  assert.ok(tiny.attrs.width >= 220 && tiny.attrs.height >= 120, "min size enforced");
});
