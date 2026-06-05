import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, coordinatesFromKey } from "../dist/index.js";

// ============================================================================
// Coordinate keys — comma-separated-integer cel keys auto-populate
// metadata.coordinates (number[], n dimensions) at the two creation
// chokepoints: hydrate's inflateCel and 契's registerLambda.
// ============================================================================

test("coordinatesFromKey: parses n-dim integer keys, rejects everything else", () => {
  assert.deepEqual(coordinatesFromKey("3,1"), [3, 1]);
  assert.deepEqual(coordinatesFromKey("0,-2,7"), [0, -2, 7]);
  assert.deepEqual(coordinatesFromKey("10,20,30,40"), [10, 20, 30, 40]);
  assert.equal(coordinatesFromKey("5"), undefined);          // no comma — ordinary key
  assert.equal(coordinatesFromKey("a,b"), undefined);
  assert.equal(coordinatesFromKey("1,2.5"), undefined);      // integers only
  assert.equal(coordinatesFromKey("1,"), undefined);
  assert.equal(coordinatesFromKey(",1"), undefined);
  assert.equal(coordinatesFromKey("sheet.A1"), undefined);
  assert.equal(coordinatesFromKey("os.active,doc"), undefined);
});

test("hydrate: coordinate keys populate metadata.coordinates; explicit wins", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{
    name: "grid", cels: [
      { key: "0,0", celType: "ValueCel", metadata: { key: "0,0", segment: "grid" }, v: 1 },
      { key: "0,1", celType: "ValueCel", metadata: { key: "0,1", segment: "grid" }, v: 2 },
      { key: "2,-3,4", celType: "ValueCel", metadata: { key: "2,-3,4", segment: "grid" }, v: 3 },
      // Explicit coordinates win over the key-derived vector.
      { key: "9,9", celType: "ValueCel", metadata: { key: "9,9", segment: "grid", coordinates: [1, 1] }, v: 4 },
      // Non-coordinate key stays bare.
      { key: "grid.title", celType: "ValueCel", metadata: { key: "grid.title", segment: "grid" }, v: "t" },
    ],
  }], [{ name: "grid", version: "0.0.1", dependencies: [], role: "library" }]);

  assert.deepEqual(state.cels.get("0,0").metadata.coordinates, [0, 0]);
  assert.deepEqual(state.cels.get("0,1").metadata.coordinates, [0, 1]);
  assert.deepEqual(state.cels.get("2,-3,4").metadata.coordinates, [2, -3, 4]);
  assert.deepEqual(state.cels.get("9,9").metadata.coordinates, [1, 1]);
  assert.equal(state.cels.get("grid.title").metadata.coordinates, undefined);
});

test("definition cels never carry coordinates — even at coordinate keys", async () => {
  const state = createInitialState();
  const setCel = resolveFn(state, "setCel");
  // A lambda at a coordinate-looking key: legal, but NOT positioned.
  await setCel(state, "4,2", { celType: "LockedLambdaCel", locked: true, fn: () => 42, metadata: { segment: "grid", kind: "custom" } });
  assert.equal(state.cels.get("4,2").metadata.coordinates, undefined);
  // Explicit coordinates on a definition cel are an authoring error.
  await assert.rejects(
    () => setCel(state, "named", { celType: "RangeCel", v: "1,1:2,2", metadata: { segment: "grid", coordinates: [1, 1] } }),
    /only Value\/Formula cels carry coordinates/,
  );
});

test("coordinates round-trip dehydrate → hydrate", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const dehydrate = resolveFn(state, "dehydrate");
  await hydrate(state, [{
    name: "grid", cels: [
      { key: "1,2", celType: "ValueCel", metadata: { key: "1,2", segment: "grid" }, v: 7 },
    ],
  }], [{ name: "grid", version: "0.0.1", dependencies: [], role: "library" }]);

  const out = dehydrate(state, { onlySegments: ["grid"] });
  const fresh = createInitialState();
  await resolveFn(fresh, "hydrate")(fresh, out.segments, out.manifests);
  assert.deepEqual(fresh.cels.get("1,2").metadata.coordinates, [1, 2]);
});

// ── coordinate-space conveniences ───────────────────────────────────────────

test("valueAt / celAt / valuesInRange read coordinate space", async () => {
  const { valueAt, celAt, valuesInRange } = await import("../dist/index.js");
  const state = createInitialState();
  await resolveFn(state, "hydrate")(state, [{
    name: "grid", cels: [
      { key: "1,1", celType: "ValueCel", metadata: { key: "1,1", segment: "grid" }, v: 10 },
      { key: "1,2", celType: "ValueCel", metadata: { key: "1,2", segment: "grid" }, v: 20 },
      { key: "2,1", celType: "ValueCel", metadata: { key: "2,1", segment: "grid" }, v: 30 },
    ],
  }], [{ name: "grid", version: "0.0.1", dependencies: [], role: "library" }]);

  assert.equal(valueAt(state, [1, 2]), 20);
  assert.equal(valueAt(state, "B1"), 20);            // A1 form: row 1, col B=2
  assert.equal(celAt(state, "1,1").v, 10);
  assert.deepEqual(valuesInRange(state, "1,1:2,2"), [[10, 20], [30, undefined]]);
});

test("neighborsOf: Moore vs von Neumann, holes skipped by default", async () => {
  const { neighborsOf } = await import("../dist/index.js");
  const state = createInitialState();
  const cels = [];
  for (const [r, c, v] of [[1,1,1],[1,2,2],[2,1,3],[2,2,4],[3,3,9]]) {
    const key = `${r},${c}`;
    cels.push({ key, celType: "ValueCel", metadata: { key, segment: "grid" }, v });
  }
  await resolveFn(state, "hydrate")(state, [{ name: "grid", cels }],
    [{ name: "grid", version: "0.0.1", dependencies: [], role: "library" }]);

  const moore = neighborsOf(state, "2,2");
  assert.deepEqual(moore.map((n) => n.key).sort(), ["1,1", "1,2", "2,1", "3,3"]);

  const vonNeumann = neighborsOf(state, "2,2", { diagonal: false });
  assert.deepEqual(vonNeumann.map((n) => n.key).sort(), ["1,2", "2,1"]);

  const withEmpty = neighborsOf(state, "2,2", { includeEmpty: true });
  assert.equal(withEmpty.length, 8, "full Moore shell when holes included");

  // From bare coordinates (no cel needed at the origin).
  const fromCoords = neighborsOf(state, [3, 2], { diagonal: false });
  assert.deepEqual(fromCoords.map((n) => n.key).sort(), ["2,2", "3,3"]);
});
