import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";

// dehydrate → JSON-serializable {segments, manifests}. Round-trip
// property: boot a state, mutate, dehydrate, build a fresh state,
// rehydrate, and observe the same cel values + same cascade behavior.
// The kernel segment is excluded from dehydrate output (re-seeded by
// createInitialState).

const mk = (name, dependencies = []) => ({
  name, version: "0.0.1", description: "test", dependencies,
});

test("dehydrate excludes the kernel segment", async () => {
  const state = createInitialState();
  const dehydrate = resolveFn(state, "dehydrate");
  const { segments, manifests } = await dehydrate(state);
  for (const m of manifests) assert.notEqual(m.name, "kernel");
  for (const s of segments)  assert.notEqual(s.name, "kernel");
});

test("user segment with value cels round-trips to identical values", async () => {
  const stateA = createInitialState();
  const hydrate   = resolveFn(stateA, "hydrate");
  const dehydrate = resolveFn(stateA, "dehydrate");
  const seg = {
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 42 } },
      { key: "b", celType: "ValueCel", metadata: { key: "b", segment: "user", v: "hello" } },
    ],
  };
  await hydrate(stateA, [seg], [mk("user")]);

  const dehydrated = await dehydrate(stateA);
  const json = JSON.parse(JSON.stringify(dehydrated));

  const stateB = createInitialState();
  const hydrateB = resolveFn(stateB, "hydrate");
  await hydrateB(stateB, json.segments, json.manifests);

  assert.equal(stateB.cels.get("a")?.v, 42);
  assert.equal(stateB.cels.get("b")?.v, "hello");
});

test("a FormulaCel round-trips and recomputes the same value", async () => {
  const stateA = createInitialState();
  const hydrate   = resolveFn(stateA, "hydrate");
  const dehydrate = resolveFn(stateA, "dehydrate");
  const runCycleA = resolveFn(stateA, "runCycle");
  const seg = {
    name: "user",
    cels: [
      { key: "x", celType: "ValueCel", metadata: { key: "x", segment: "user", v: 6 } },
      { key: "y", celType: "ValueCel", metadata: { key: "y", segment: "user", v: 7 } },
      {
        key: "prod",
        celType: "FormulaCel",
        metadata: { key: "prod", segment: "user", parser: "f" },
        f: "(* x y)",
      },
    ],
  };
  await hydrate(stateA, [seg], [mk("user")]);
  await precomputeOptional(stateA);
  await runCycleA(stateA);
  assert.equal(stateA.cels.get("prod")?.v, 42);

  const json = JSON.parse(JSON.stringify(await dehydrate(stateA)));

  const stateB = createInitialState();
  const hydrateB  = resolveFn(stateB, "hydrate");
  const runCycleB = resolveFn(stateB, "runCycle");
  await hydrateB(stateB, json.segments, json.manifests);
  await precomputeOptional(stateB);
  await runCycleB(stateB);
  assert.equal(stateB.cels.get("prod")?.v, 42, "formula recomputed after round-trip");
  assert.equal(stateB.cels.get("prod")?.f, "(* x y)", "source body preserved");
});

test("mutated state round-trips with the post-mutation values", async () => {
  const stateA = createInitialState();
  const hydrate   = resolveFn(stateA, "hydrate");
  const dehydrate = resolveFn(stateA, "dehydrate");
  const setA      = resolveFn(stateA, "setValue");
  const seg = {
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 1 } },
    ],
  };
  await hydrate(stateA, [seg], [mk("user")]);
  await setA(stateA, "a", 99);

  const json = JSON.parse(JSON.stringify(await dehydrate(stateA)));
  const stateB = createInitialState();
  const hydrateB = resolveFn(stateB, "hydrate");
  await hydrateB(stateB, json.segments, json.manifests);
  assert.equal(stateB.cels.get("a")?.v, 99, "post-mutation value carried through");
});

test("the manifest list round-trips with the dependencies preserved", async () => {
  const stateA = createInitialState();
  const hydrate   = resolveFn(stateA, "hydrate");
  const dehydrate = resolveFn(stateA, "dehydrate");
  const segs = [
    { name: "alpha", cels: [
      { key: "a1", celType: "ValueCel", metadata: { key: "a1", segment: "alpha", v: 1 } },
    ]},
    { name: "beta", cels: [
      { key: "b1", celType: "ValueCel", metadata: { key: "b1", segment: "beta", v: 1 } },
    ]},
  ];
  await hydrate(stateA, segs, [mk("alpha"), mk("beta", ["alpha"])]);

  const json = JSON.parse(JSON.stringify(await dehydrate(stateA)));
  const byName = new Map(json.manifests.map((m) => [m.name, m]));
  assert.deepEqual(byName.get("beta").dependencies, ["alpha"], "dependency edge preserved");
  assert.deepEqual(byName.get("alpha").dependencies, []);
});

test("a freshly dehydrated archive carries the formatVersion marker and round-trips", async () => {
  const stateA = createInitialState();
  const hydrate   = resolveFn(stateA, "hydrate");
  const dehydrate = resolveFn(stateA, "dehydrate");
  const seg = {
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 5 } },
    ],
  };
  await hydrate(stateA, [seg], [mk("user")]);

  const dehydrated = await dehydrate(stateA);
  // (a) the marker is present and is the current numeric version.
  assert.equal(typeof dehydrated.formatVersion, "number", "formatVersion is a number");
  assert.equal(dehydrated.formatVersion, 1, "formatVersion is the current version (1)");

  // …and the full archive (marker included) round-trips through JSON +
  // a fresh state, passing the version through hydrate's read-path arg.
  const json = JSON.parse(JSON.stringify(dehydrated));
  assert.equal(json.formatVersion, 1, "marker survives JSON serialization");

  const stateB = createInitialState();
  const hydrateB = resolveFn(stateB, "hydrate");
  await hydrateB(stateB, json.segments, json.manifests, json.formatVersion);
  assert.equal(stateB.cels.get("a")?.v, 5, "value round-trips with the marker passed through hydrate");
});

test("an archive with the marker stripped (a legacy/old archive) still hydrates", async () => {
  const stateA = createInitialState();
  const hydrate   = resolveFn(stateA, "hydrate");
  const dehydrate = resolveFn(stateA, "dehydrate");
  const seg = {
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 7 } },
    ],
  };
  await hydrate(stateA, [seg], [mk("user")]);

  const json = JSON.parse(JSON.stringify(await dehydrate(stateA)));
  // Simulate a pre-versioning archive: drop the marker entirely.
  delete json.formatVersion;
  assert.equal(json.formatVersion, undefined, "marker removed (legacy archive)");

  const stateB = createInitialState();
  const hydrateB = resolveFn(stateB, "hydrate");
  // No formatVersion arg — the back-compat (legacy) path. Must not throw.
  await hydrateB(stateB, json.segments, json.manifests);
  assert.equal(stateB.cels.get("a")?.v, 7, "legacy (unmarked) archive still hydrates");
});

test("checkFormatVersion: legacy=0, same=silent, newer=warns, never throws", async () => {
  const { checkFormatVersion, CURRENT_FORMAT_VERSION } = await import("../dist/kernel/dehydrate/index.js");
  assert.equal(CURRENT_FORMAT_VERSION, 1, "current version constant exported");

  const notes = [];
  const log = (m) => notes.push(m);

  // Unmarked → treated as legacy v0, logs a note.
  assert.equal(checkFormatVersion({}, log), 0, "unmarked archive resolves to v0");
  assert.equal(checkFormatVersion(undefined, log), 0, "missing archive resolves to v0");
  // Same version → silent normal path.
  const before = notes.length;
  assert.equal(checkFormatVersion({ formatVersion: CURRENT_FORMAT_VERSION }, log), CURRENT_FORMAT_VERSION);
  assert.equal(notes.length, before, "same-version load is silent");
  // Newer than ours → warns but returns the version (no throw).
  assert.equal(checkFormatVersion({ formatVersion: CURRENT_FORMAT_VERSION + 1 }, log), CURRENT_FORMAT_VERSION + 1);
  assert.ok(notes.some((m) => m.includes("NEWER")), "newer-version load logs a warning");
});

test("source-bearing registerLambda cels land in 'default' and dehydrate with a synthesized manifest; native husks are skipped", async () => {
  const state = createInitialState();
  const register  = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));
  const dehydrate = resolveFn(state, "dehydrate");

  // Source-bearing lambda (js kind): carries an `f` body, so it survives
  // dehydrate as a re-hydratable cel.
  await register(state, { key: "srcFn", source: "x => x + 1", kind: "js" });
  // Native-bodied lambda: `_fn` set, no `f` source. Roadmap 02's husk
  // skip drops it from dehydrate output — a code seed re-seeds from the
  // host bundle, so the husk carries no information.
  await register(state, { key: "huskFn", fn: (x) => x + 1 });

  const { segments, manifests } = await dehydrate(state);
  const defaultSeg = segments.find((s) => s.name === "default");
  assert.ok(defaultSeg, "default segment exists in dehydrate output");
  assert.ok(defaultSeg.cels.some((c) => c.key === "srcFn"), "source-bearing srcFn dehydrates under default");
  assert.ok(!defaultSeg.cels.some((c) => c.key === "huskFn"), "native husk huskFn is skipped");

  const defaultManifest = manifests.find((m) => m.name === "default");
  assert.ok(defaultManifest, "synthesized manifest exists so rehydrate accepts the segment");
});
