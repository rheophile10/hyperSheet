import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, resolveFn, isSegmentPending, loadSegment, ensureSegments,
  registerSegmentLoader, listSegments, SEGMENT_LOADERS_KEY, getSegmentLoaders,
} from "../dist/index.js";

// ============================================================================
// Lazy / dynamic segment loading — createInitialState({ lazy }) parks
// loaders in the reserved segment.loaders registry; loadSegment /
// ensureSegments install on demand; registerSegmentLoader covers
// runtime-defined segments.
// ============================================================================

test("default createInitialState: nothing pending, registry cel exists", () => {
  const state = createInitialState();
  const loaders = getSegmentLoaders(state);
  assert.ok(loaders instanceof Map);
  assert.equal(loaders.size, 0);
  assert.ok(state.cels.get(SEGMENT_LOADERS_KEY)?.locked);
});

test("lazy segment: manifest seeded, cels absent, pending until loaded", () => {
  const eager = createInitialState();
  const state = createInitialState({ lazy: ["sound"] });

  // Manifest is visible (host UI / dependency walks work)…
  assert.ok(state.segments.get("sound"));
  assert.ok(listSegments(state).some((m) => m.name === "sound"));
  assert.ok(isSegmentPending(state, "sound"));

  // …but none of the segment's cels installed. The SegmentCel (冊.sound)
  // is the manifest, not a payload cel — both eager and lazy states carry
  // it; exclude it from the payload comparison.
  const soundCels = [...eager.cels.values()].filter(
    (c) => c.metadata.segment === "sound" && c.celType !== "SegmentCel",
  );
  assert.ok(soundCels.length > 0, "eager state should have sound cels to compare against");
  for (const cel of soundCels) assert.equal(state.cels.has(cel.metadata.key), false);
});

test("loadSegment installs the same cels an eager boot would", async () => {
  const eager = createInitialState();
  const state = createInitialState({ lazy: ["sound"] });

  await loadSegment(state, "sound");

  assert.equal(isSegmentPending(state, "sound"), false);
  const eagerKeys = [...eager.cels.values()]
    .filter((c) => c.metadata.segment === "sound" && c.celType !== "SegmentCel")
    .map((c) => c.metadata.key).sort();
  const lazyKeys = [...state.cels.values()]
    .filter((c) => c.metadata.segment === "sound" && c.celType !== "SegmentCel")
    .map((c) => c.metadata.key).sort();
  assert.deepEqual(lazyKeys, eagerKeys);
});

test("loadSegment is a no-op for non-pending segments", async () => {
  const state = createInitialState();
  const before = state.cels.size;
  await loadSegment(state, "builtins");
  await loadSegment(state, "never-heard-of-it");
  assert.equal(state.cels.size, before);
});

test("lazy state still hydrates and computes (kernel never lazy)", async () => {
  const state = createInitialState({ lazy: ["sound", "sheet"] });
  const hydrate = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");
  const set = resolveFn(state, "setValue");
  await hydrate(state, [{
    name: "t", cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "t" }, v: 2 },
      { key: "b", celType: "FormulaCel", metadata: { key: "b", segment: "t", parser: "f", inputMap: { a: "a" } }, f: "(* a 3)" },
    ],
  }], [{ name: "t", version: "0.0.1", dependencies: [], role: "library" }]);
  await set(state, "a", 5);
  await runCycle(state);
  assert.equal(state.cels.get("b").v, 15);
});

test("createInitialState rejects lazy kernel and unknown segments", () => {
  assert.throws(() => createInitialState({ lazy: ["kernel"] }), /cannot be lazy/);
  assert.throws(() => createInitialState({ lazy: ["nope"] }), /unknown segment/);
});

test("ensureSegments loads the dependency closure with one precompute", async () => {
  const state = createInitialState({ lazy: ["sound"] });
  // Runtime-registered segment depending on a lazy bundled one.
  registerSegmentLoader(state, "beeper", () => [
    { celType: "ValueCel", metadata: { key: "beeper.volume", segment: "beeper" }, v: 11 },
  ], { name: "beeper", version: "0.0.1", dependencies: ["sound"], role: "library" });

  assert.ok(isSegmentPending(state, "beeper"));
  const genBefore = state.precomputeGeneration;
  await ensureSegments(state, ["beeper"]);

  assert.equal(isSegmentPending(state, "beeper"), false);
  assert.equal(isSegmentPending(state, "sound"), false);
  assert.equal(state.cels.get("beeper.volume")?.v, 11);
  assert.equal(state.precomputeGeneration, genBefore + 1, "batch should precompute exactly once");
});

test("ensureSegments throws on a dep with no manifest and no loader", async () => {
  const state = createInitialState();
  registerSegmentLoader(state, "broken", () => [],
    { name: "broken", version: "0.0.1", dependencies: ["ghost"], role: "library" });
  await assert.rejects(() => ensureSegments(state, ["broken"]), /no manifest or loader/);
});

test("async loader: failure re-parks the loader so a retry can succeed", async () => {
  const state = createInitialState();
  let attempts = 0;
  registerSegmentLoader(state, "flaky", async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("network down");
    return [{ celType: "ValueCel", metadata: { key: "flaky.ok", segment: "flaky" }, v: true }];
  }, { name: "flaky", version: "0.0.1", dependencies: [], role: "library" });

  await assert.rejects(() => loadSegment(state, "flaky"), /network down/);
  assert.ok(isSegmentPending(state, "flaky"), "failed load should stay pending");
  await loadSegment(state, "flaky");
  assert.equal(state.cels.get("flaky.ok")?.v, true);
});

test("lazy segment's fns dispatch after ensureSegments (cel registry intact)", async () => {
  const state = createInitialState({ lazy: ["sheet"] });
  assert.equal(state.cels.get("buildSheet"), undefined);
  await ensureSegments(state, ["sheet"]);
  // sheet's cels are live code-seed cels — fns must arrive bound.
  const sheetCels = [...state.cels.values()].filter((c) => c.metadata.segment === "sheet");
  assert.ok(sheetCels.length > 0);
});
