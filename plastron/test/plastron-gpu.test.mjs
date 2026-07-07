import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";
import { dirtyIndices, dollyDistance } from "../dist/甲骨坑/library/plastron-gpu/index.js";

// Tier A — plastron-gpu's vocabulary is PURE (01-rendering.md): every
// constructor returns a plain spec object (JSON before a pixel exists),
// scene() returns a <canvas data-scene> vnode whose attr round-trips the
// spec, instances() carries the buffer CEL KEY (not the data), and the
// instance dirty-diff is a pure fn over two typed arrays. Mirrors the
// shipped plastron-canvas.test.mjs assertions.

const boot = () => {
  const state = createInitialState();
  return { state, f: (k) => resolveFn(state, k) };
};

test("geometry/material/light/camera constructors return pure spec nodes", () => {
  const { f } = boot();
  assert.deepEqual(f("box")(1, 2, 3), { spec: "box", w: 1, h: 2, d: 3 });
  assert.deepEqual(f("sphere")(0.5), { spec: "sphere", r: 0.5 });
  assert.deepEqual(f("material")("#e67"), { spec: "material", color: "#e67" });
  const l = f("light")(5, 8, 3);
  assert.equal(l.spec, "light"); assert.equal(l.x, 5); assert.equal(l.intensity, 1);
  assert.deepEqual(f("camera")(0, 4, 8), { spec: "camera", x: 0, y: 4, z: 8 });
  // optional trailing args carry the AUTHORED wheel-dolly policy on the surface
  assert.deepEqual(f("camera")(0, 4, 8, 2, 40, 0.002),
    { spec: "camera", x: 0, y: 4, z: 8, minDistance: 2, maxDistance: 40, zoomSpeed: 0.002 });
  // partial: only some optionals supplied → only those keys appear
  assert.deepEqual(f("camera")(0, 4, 8, 2),
    { spec: "camera", x: 0, y: 4, z: 8, minDistance: 2 });
});

test("dollyDistance directs (up=in, down=out) and clamps to [minD, maxD]", () => {
  // no scroll → distance unchanged
  assert.equal(dollyDistance(10, 0, 1, 100, 0.001), 10);
  // scroll-up (deltaY < 0) → smaller distance → zoom IN
  assert.ok(dollyDistance(10, -100, 1, 100, 0.001) < 10);
  // scroll-down (deltaY > 0) → larger distance → zoom OUT
  assert.ok(dollyDistance(10, 100, 1, 100, 0.001) > 10);
  // a mid-range notch lands exactly at distance·exp(deltaY·speed)
  assert.equal(dollyDistance(10, 200, 1, 100, 0.001), 10 * Math.exp(0.2));
  // a large scroll-in saturates at minDistance (never punches through the scene)
  assert.equal(dollyDistance(10, -100000, 2, 100, 0.001), 2);
  // a large scroll-out saturates at maxDistance (never recedes to infinity)
  assert.equal(dollyDistance(10, 100000, 2, 40, 0.001), 40);
});

test("mesh() nests geometry + material specs; instances() carries the buffer cel KEY", () => {
  const { f } = boot();
  const m = f("mesh")(f("box")(1, 1, 1), f("material")("#4a90d9"));
  assert.equal(m.spec, "mesh");
  assert.equal(m.geometry.spec, "box");
  assert.equal(m.material.color, "#4a90d9");
  const inst = f("instances")(f("box")(0.1, 0.1, 0.3), f("material")("#4fc3f7"), 10000, "fish.buffers");
  assert.equal(inst.spec, "instances");
  assert.equal(inst.count, 10000);
  assert.equal(inst.key, "fish.buffers"); // a key STRING — dehydrates cleanly
  assert.equal(typeof inst.key, "string");
});

test("scene() returns a <canvas data-scene> vnode whose attr round-trips the spec", () => {
  const { f } = boot();
  const v = f("scene")(720, 480,
    f("camera")(0, 8, 30),
    f("light")(10, 20, 10),
    f("instances")(f("box")(0.1, 0.1, 0.3), f("material")("#4fc3f7"), 100, "sim.buffers"));
  assert.equal(v.type, "el");
  assert.equal(v.tag, "canvas");
  assert.equal(v.attrs.width, 720);
  assert.equal(v.attrs.height, 480);
  const nodes = JSON.parse(v.attrs["data-scene"]);
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes.map((n) => n.spec), ["camera", "light", "instances"]);
  assert.equal(nodes[2].key, "sim.buffers");
});

test("scene() flattens spec ARRAYS in place (compose-by-concat, like canvas())", () => {
  const { f } = boot();
  const pair = [f("light")(1, 1, 1), f("light")(2, 2, 2)];
  const v = f("scene")(100, 100, f("camera")(0, 0, 5), pair);
  assert.equal(JSON.parse(v.attrs["data-scene"]).length, 3);
});

test("sceneframe() is the {key, gen} channel payload", () => {
  const { f } = boot();
  assert.deepEqual(f("sceneframe")("sim.buffers", 42), { key: "sim.buffers", gen: 42 });
});

test("dirtyIndices marks exactly the changed instances; missing prev → null (full upload)", () => {
  const a = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]);
  const b = new Float32Array([0, 0, 0, 1, 5, 1, 2, 2, 2]);
  assert.deepEqual(dirtyIndices(a, b, 3), [1]);
  assert.deepEqual(dirtyIndices(a, a.slice(), 3), []);
  assert.equal(dirtyIndices(undefined, b, 3), null);
  assert.equal(dirtyIndices(new Float32Array(3), b, 3), null); // length mismatch → full
  const c = b.slice(); c[0] = 9; c[8] = 9;
  assert.deepEqual(dirtyIndices(b, c, 3), [0, 2]);
});
