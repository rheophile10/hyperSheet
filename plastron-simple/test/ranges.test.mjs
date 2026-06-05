import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, resolveFn,
  parseA1, parseCoordinates, parseAddress, parseRange,
  isRangeNotation, addressToKey, rangeToKeys,
} from "../dist/index.js";

// ============================================================================
// Addresses & ranges — A1 + comma parsing, key enumeration, range
// literals in formulas (approach A: members wired into inputMap),
// named RangeCels, and the rangeToKeys/parseRange builtins.
// ============================================================================

// ── parsers ─────────────────────────────────────────────────────────────────

test("parseA1: [row, col] 1-based; bijective base-26 columns", () => {
  assert.deepEqual(parseA1("A1"), [1, 1]);
  assert.deepEqual(parseA1("B3"), [3, 2]);
  assert.deepEqual(parseA1("Z9"), [9, 26]);
  assert.deepEqual(parseA1("AA10"), [10, 27]);
  assert.equal(parseA1("A0"), undefined);   // no row 0 in Excel
  assert.equal(parseA1("1A"), undefined);
  assert.equal(parseA1("A"), undefined);
});

test("parseCoordinates: A1 form or comma form, single int allowed", () => {
  assert.deepEqual(parseCoordinates("B3"), [3, 2]);
  assert.deepEqual(parseCoordinates("1,1"), [1, 1]);
  assert.deepEqual(parseCoordinates("3,-2,7"), [3, -2, 7]);
  assert.deepEqual(parseCoordinates("5"), [5]);
  assert.equal(parseCoordinates("a,b"), undefined);
});

test("parseAddress: optional Seg! prefix", () => {
  assert.deepEqual(parseAddress("grid!A1"), { segment: "grid", coordinates: [1, 1] });
  assert.deepEqual(parseAddress("grid!1,2"), { segment: "grid", coordinates: [1, 2] });
  assert.deepEqual(parseAddress("1,2"), { coordinates: [1, 2] });
  assert.equal(parseAddress("bad seg!1,2"), undefined);
});

test("parseRange: corners normalize; dims must agree; n-dim works", () => {
  assert.deepEqual(parseRange("A1:B3"), { at: { coordinates: [1, 1] }, shape: [3, 2] });
  assert.deepEqual(parseRange("B3:A1"), { at: { coordinates: [1, 1] }, shape: [3, 2] });
  assert.deepEqual(parseRange("grid!1,1:2,2"), { at: { segment: "grid", coordinates: [1, 1] }, shape: [2, 2] });
  assert.deepEqual(parseRange("1,1,1:2,2,2"), { at: { coordinates: [1, 1, 1] }, shape: [2, 2, 2] });
  assert.equal(parseRange("A1:1,1,1"), undefined);  // 2-dim vs 3-dim
  assert.equal(parseRange("A1B3"), undefined);
  assert.ok(isRangeNotation("grid!A1:B3"));
  assert.ok(!isRangeNotation("http://x"));
});

test("addressToKey + rangeToKeys: row-major comma keys, segment-qualified", () => {
  assert.equal(addressToKey({ segment: "g", coordinates: [1, 2] }), "g!1,2");
  assert.equal(addressToKey({ coordinates: [1, 2] }), "1,2");
  assert.deepEqual(rangeToKeys("1,1:2,2"), ["1,1", "1,2", "2,1", "2,2"]);
  assert.deepEqual(rangeToKeys("g!A1:B2"), ["g!1,1", "g!1,2", "g!2,1", "g!2,2"]);
  assert.deepEqual(rangeToKeys("1:3"), ["1", "2", "3"]);  // 1-dim
});

// ── formulas ────────────────────────────────────────────────────────────────

const grid = (cells) => Object.entries(cells).map(([key, v]) => ({
  key, celType: "ValueCel", metadata: { key, segment: "grid" }, v,
}));

const boot = async (cels) => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{ name: "grid", cels }], [{ name: "grid", version: "0.0.1", dependencies: [], role: "library" }]);
  return state;
};

test("range literal in a formula: nested values, members wired, reactive", async () => {
  const state = await boot([
    ...grid({ "1,1": 1, "1,2": 2, "2,1": 3, "2,2": 4 }),
    { key: "snap", celType: "FormulaCel", metadata: { key: "snap", segment: "grid", parser: "f" }, f: "1,1:2,2" },
  ]);
  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  assert.deepEqual(state.cels.get("snap").v, [[1, 2], [3, 4]]);

  // Members landed in inputMap — approach A wiring.
  const im = state.cels.get("snap").metadata.inputMap;
  assert.deepEqual(Object.keys(im).sort(), ["1,1", "1,2", "2,1", "2,2"]);

  // Partial invalidation: one member write recomputes the consumer.
  await resolveFn(state, "setValue")(state, "2,2", 40);
  assert.deepEqual(state.cels.get("snap").v, [[1, 2], [3, 40]]);
});

test("named RangeCel: expands to member values; RangeCel itself is a dep", async () => {
  const state = await boot([
    ...grid({ "1,1": 10, "1,2": 20 }),
    { key: "row1", celType: "RangeCel", metadata: { key: "row1", segment: "grid" }, v: "1,1:1,2" },
    { key: "viaName", celType: "FormulaCel", metadata: { key: "viaName", segment: "grid", parser: "f" }, f: "row1" },
  ]);
  await resolveFn(state, "runCycle")(state);
  assert.deepEqual(state.cels.get("viaName").v, [[10, 20]]);

  // RangeCel.v parsed from notation at hydrate.
  assert.deepEqual(state.cels.get("row1").v, { at: { coordinates: [1, 1] }, shape: [1, 2] });

  const im = state.cels.get("viaName").metadata.inputMap;
  assert.ok("row1" in im, "named range definition is a dep");
  assert.ok("1,1" in im && "1,2" in im, "members are deps");

  await resolveFn(state, "setValue")(state, "1,2", 21);
  assert.deepEqual(state.cels.get("viaName").v, [[10, 21]]);
});

test("range values feed arithmetic through a lambda", async () => {
  const state = await boot([
    ...grid({ "1,1": 1, "1,2": 2, "2,1": 3, "2,2": 4 }),
    { key: "total", celType: "FormulaCel", metadata: { key: "total", segment: "grid", parser: "f" }, f: "(sumGrid 1,1:2,2)" },
  ]);
  await ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }))(state, {
    key: "sumGrid", kind: "custom",
    fn: (g) => g.flat(Infinity).reduce((a, b) => a + Number(b), 0),
  });
  // total compiled before sumGrid existed; the definition-generation
  // stamp recompiles it at the next cycle automatically.
  await resolveFn(state, "runCycle")(state);
  assert.equal(state.cels.get("total").v, 10);
});

test("builtins: (rangeToKeys …) and (parseRange …) from formulas", async () => {
  const state = await boot([
    { key: "keys", celType: "FormulaCel", metadata: { key: "keys", segment: "grid", parser: "f" }, f: '(rangeToKeys "g!1,1:1,2")' },
    { key: "parsed", celType: "FormulaCel", metadata: { key: "parsed", segment: "grid", parser: "f" }, f: '(parseRange "A1:B2")' },
  ]);
  await resolveFn(state, "runCycle")(state);
  assert.deepEqual(state.cels.get("keys").v, ["g!1,1", "g!1,2"]);
  assert.deepEqual(state.cels.get("parsed").v, { at: { coordinates: [1, 1] }, shape: [2, 2] });
});

test("URL-ish tokens with colons stay symbols (no false range parse)", async () => {
  const state = await boot([
    { key: "http://x", celType: "ValueCel", metadata: { key: "http://x", segment: "grid" }, v: "weird but legal" },
    { key: "echo", celType: "FormulaCel", metadata: { key: "echo", segment: "grid", parser: "f" }, f: "http://x" },
  ]);
  await resolveFn(state, "runCycle")(state);
  assert.equal(state.cels.get("echo").v, "weird but legal");
});

test("segment-qualified coordinate keys get coordinates", async () => {
  const state = await boot([
    { key: "g!3,4", celType: "ValueCel", metadata: { key: "g!3,4", segment: "grid" }, v: 0 },
  ]);
  assert.deepEqual(state.cels.get("g!3,4").metadata.coordinates, [3, 4]);
});

// ── named-range definition changes (rangeUsage recompile protocol) ──────────

test("set() a new extent on a RangeCel: consumers recompile and rewire", async () => {
  const state = await boot([
    ...grid({ "1,1": 1, "1,2": 2, "1,3": 3 }),
    { key: "row1", celType: "RangeCel", metadata: { key: "row1", segment: "grid" }, v: "1,1:1,2" },
    { key: "viaName", celType: "FormulaCel", metadata: { key: "viaName", segment: "grid", parser: "f" }, f: "row1" },
  ]);
  const set = resolveFn(state, "setValue");
  await resolveFn(state, "runCycle")(state);
  assert.deepEqual(state.cels.get("viaName").v, [[1, 2]]);

  // GROW the extent — a definition change, so it goes through setCel
  // (replace the RangeCel); consumers recompile via the staleness check.
  await resolveFn(state, "setCel")(state, "row1", { celType: "RangeCel", v: "1,1:1,3", metadata: { segment: "grid" } });
  assert.deepEqual(state.cels.get("viaName").v, [[1, 2, 3]], "recomputed over the NEW members");
  const im = state.cels.get("viaName").metadata.inputMap;
  assert.ok("1,3" in im, "new member wired into inputMap");

  // New member is live: writing it refires the consumer.
  await set(state, "1,3", 30);
  assert.deepEqual(state.cels.get("viaName").v, [[1, 2, 30]]);
});

test("setCel shrink: stale members pruned; old member writes no longer refire", async () => {
  const state = await boot([
    ...grid({ "1,1": 1, "1,2": 2, "1,3": 3 }),
    { key: "row1", celType: "RangeCel", metadata: { key: "row1", segment: "grid" }, v: "1,1:1,3" },
    { key: "viaName", celType: "FormulaCel", metadata: { key: "viaName", segment: "grid", parser: "f" }, f: "row1" },
  ]);
  const set = resolveFn(state, "setValue");
  await resolveFn(state, "runCycle")(state);
  assert.deepEqual(state.cels.get("viaName").v, [[1, 2, 3]]);

  await resolveFn(state, "setCel")(state, "row1", { celType: "RangeCel", v: "1,1:1,2", metadata: { segment: "grid" } });
  assert.deepEqual(state.cels.get("viaName").v, [[1, 2]], "recomputed over the SHRUNK extent");
  const im = state.cels.get("viaName").metadata.inputMap;
  assert.ok(!("1,3" in im), "stale member pruned from inputMap");

  // A write to the dropped member must not change the consumer.
  await set(state, "1,3", 999);
  assert.deepEqual(state.cels.get("viaName").v, [[1, 2]]);
});

test("range redefinition + value writes: definition via setCel, data via setValueBatch", async () => {
  const state = await boot([
    ...grid({ "1,1": 1, "1,2": 2, "2,1": 3, "2,2": 4 }),
    { key: "zone", celType: "RangeCel", metadata: { key: "zone", segment: "grid" }, v: "1,1:1,2" },
    { key: "snap", celType: "FormulaCel", metadata: { key: "snap", segment: "grid", parser: "f" }, f: "zone" },
  ]);
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "setValueBatch")(state, [["1,1", 10], ["2,2", 40]]);
  await resolveFn(state, "setCel")(state, "zone", { celType: "RangeCel", v: "1,1:2,2", metadata: { segment: "grid" } });
  assert.deepEqual(state.cels.get("snap").v, [[10, 2], [3, 40]]);
});

test("named ranges are topology edges: children index reaches consumers", async () => {
  const state = await boot([
    ...grid({ "1,1": 1 }),
    { key: "r", celType: "RangeCel", metadata: { key: "r", segment: "grid" }, v: "1,1:1,1" },
    { key: "user", celType: "FormulaCel", metadata: { key: "user", segment: "grid", parser: "f" }, f: "r" },
  ]);
  const { getPrecomputedIndexes } = await import("../dist/index.js");
  const idx = getPrecomputedIndexes(state);
  assert.ok(idx.children.get("r")?.has("user"), "RangeCel → consumer is a children edge");
});

test("RangeCels are definition-plane: setValue refuses; junk replacement throws", async () => {
  const state = await boot([
    { key: "r", celType: "RangeCel", metadata: { key: "r", segment: "grid" }, v: "1,1:1,2" },
  ]);
  // Data tier refuses the definition cel outright.
  await assert.rejects(
    () => resolveFn(state, "setValue")(state, "r", "1,1:9,9"),
    /definitions are replaced via setCel/,
  );
  // Replacing with junk throws from inflate; old definition intact.
  await assert.rejects(
    () => resolveFn(state, "setCel")(state, "r", { celType: "RangeCel", v: "not-a-range", metadata: { segment: "grid" } }),
    /not a Range or parseable range notation/,
  );
  assert.deepEqual(state.cels.get("r").v, { at: { coordinates: [1, 1] }, shape: [1, 2] });
});
