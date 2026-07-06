import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";
import { buffers_dehydrate, buffers_hydrate, buffers_isChanged } from "../dist/甲骨坑/library/buffer-schema/index.js";

// buffer-schema — the 'buffers' SchemaCel: snapshot a struct of multi-dtype
// typed arrays + JSON-native fields. Tier-A on the protocol fns; Tier-B drives
// the FULL kernel path (a cel bound via metadata.schema round-trips dehydrate→
// JSON→hydrate). No browser; deterministic.

const mk = (name, dependencies = []) => ({ name, version: "0.0.1", description: "test", dependencies });
const roundtrip = (v) => buffers_hydrate(JSON.parse(JSON.stringify(buffers_dehydrate(v))));

// ── Tier-A: the protocol fns ─────────────────────────────────────────────────

test("round-trips multiple typed-array dtypes with identical contents", () => {
  const v = {
    positions: new Float32Array([0, 1.5, -2.25, 3]),
    indices: new Uint32Array([0, 1, 2, 4000000000]),
    health: new Uint16Array([1, 2, 65535]),
    signed: new Int32Array([-7, 0, 7]),
  };
  const h = roundtrip(v);
  assert.ok(h.positions instanceof Float32Array && h.indices instanceof Uint32Array);
  assert.ok(h.health instanceof Uint16Array && h.signed instanceof Int32Array);
  assert.deepEqual([...h.positions], [0, 1.5, -2.25, 3]);
  assert.deepEqual([...h.indices], [0, 1, 2, 4000000000]);
  assert.deepEqual([...h.health], [1, 2, 65535]);
  assert.deepEqual([...h.signed], [-7, 0, 7]);
});

test("JSON-native fields (scalars, arrays, strings) pass through unchanged — incl. RNG state", () => {
  const v = { cells: new Uint16Array([9]), gen: 42, name: "world", dims: [64, 64, 64], rng: { rNums: [1, 2, 3], rC: 7, cC: 11 } };
  const d = buffers_dehydrate(v);
  // the dehydrated form is pure JSON — typed arrays encoded, the rest verbatim
  assert.equal(d.gen, 42);
  assert.equal(d.name, "world");
  assert.deepEqual(d.dims, [64, 64, 64]);
  assert.deepEqual(d.rng, { rNums: [1, 2, 3], rC: 7, cC: 11 });
  assert.equal(d.cells.__ta, "Uint16Array");
  assert.equal(typeof d.cells.b64, "string");
  const h = roundtrip(v);
  assert.equal(h.gen, 42);
  assert.deepEqual(h.rng, { rNums: [1, 2, 3], rC: 7, cC: 11 }, "RNG state survives for deterministic replay");
  assert.deepEqual([...h.cells], [9]);
});

test("the dehydrated form is genuinely JSON-serializable (no typed arrays leak)", () => {
  const d = buffers_dehydrate({ a: new Float64Array([1, 2]), b: 3 });
  const s = JSON.stringify(d);
  assert.ok(!s.includes("Float64Array") || s.includes("__ta"), "only the dtype tag, not a live instance");
  assert.deepEqual(JSON.parse(s), d, "stringify/parse is identity on the dehydrated form");
});

test("a typed array that's a VIEW into a larger buffer round-trips just its slice", () => {
  const big = new Float32Array([9, 0, 1, 2, 3, 9]);
  const view = big.subarray(1, 5); // [0,1,2,3], byteOffset 4
  const h = roundtrip({ v: view });
  assert.ok(h.v instanceof Float32Array);
  assert.deepEqual([...h.v], [0, 1, 2, 3]);
});

test("defensive: non-object input and unknown dtypes pass through, don't throw", () => {
  assert.equal(buffers_dehydrate(42), 42);
  assert.equal(buffers_hydrate("x"), "x");
  assert.equal(buffers_dehydrate(null), null);
  // an unknown __ta tag is left encoded rather than crashing
  const weird = buffers_hydrate({ q: { __ta: "Float128Array", b64: "AAA" } });
  assert.equal(weird.q.__ta, "Float128Array");
});

test("isChanged is ref-eq (host mutates in place + signals via a generation cel)", () => {
  const buf = new Uint16Array([1, 2, 3]);
  const struct = { buf };
  assert.equal(buffers_isChanged(struct, struct), false, "same ref → unchanged");
  buf[0] = 99; // mutated in place, same ref
  assert.equal(buffers_isChanged(struct, struct), false, "in-place mutation is NOT a change (by design)");
  assert.equal(buffers_isChanged(struct, { buf }), true, "a new struct ref → changed");
});

// ── Tier-B: the full kernel path via metadata.schema:"buffers" ───────────────

test("a cel bound to schema 'buffers' survives dehydrate → JSON → hydrate", async () => {
  const stateA = createInitialState();
  await resolveFn(stateA, "ensureSegments")(stateA, ["buffer-schema"]);
  const mesh = { positions: new Float32Array([0, 1, 2, 3, 4, 5]), indices: new Uint32Array([0, 1, 2]), gen: 7, rng: [11, 22, 33] };
  const seg = {
    name: "user",
    cels: [{ key: "geo.mesh", celType: "ValueCel", metadata: { key: "geo.mesh", segment: "user", schema: "buffers", v: mesh } }],
  };
  await resolveFn(stateA, "hydrate")(stateA, [seg], [mk("user", ["buffer-schema"])]);

  // dehydrate → must be pure JSON (would throw / lose the typed arrays without the schema)
  const json = JSON.parse(JSON.stringify(await resolveFn(stateA, "dehydrate")(stateA)));

  const stateB = createInitialState();
  await resolveFn(stateB, "ensureSegments")(stateB, ["buffer-schema"]);
  await resolveFn(stateB, "hydrate")(stateB, json.segments, json.manifests);

  const m = stateB.cels.get("geo.mesh")?.v;
  assert.ok(m, "the cel rehydrated");
  assert.ok(m.positions instanceof Float32Array, "typed array reconstructed (proves the schema fired)");
  assert.deepEqual([...m.positions], [0, 1, 2, 3, 4, 5]);
  assert.ok(m.indices instanceof Uint32Array);
  assert.deepEqual([...m.indices], [0, 1, 2]);
  assert.equal(m.gen, 7);
  assert.deepEqual(m.rng, [11, 22, 33]);
});
