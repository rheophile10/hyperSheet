import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

const baseManifest = { name: "user", version: "0.0.1", description: "test", dependencies: [] };

// ── cache cel is seeded ─────────────────────────────────────────────────────

test("kernel seeds the compile.cache cel as an empty Map", () => {
  const state = createInitialState();
  const cache = state.cels.get("compile.cache");
  assert.ok(cache, "compile.cache cel missing");
  assert.equal(cache.celType, "ValueCel");
  assert.equal(cache.locked, true);
  assert.ok(cache.v instanceof Map);
  assert.equal(cache.v.size, 0);
});

// ── identical source compiles once across two cels ─────────────────────────

test("two cels with identical source share a single compiled envelope (cache hit)", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const SRC =
    "(module (func (export \"main\") (param $a i32) (result i32) " +
    "local.get $a i32.const 1 i32.add))";

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "inc-a", celType: "EditableLambdaCel",
        metadata: { key: "inc-a", segment: "user", kind: "wat" }, f: SRC },
      { key: "inc-b", celType: "EditableLambdaCel",
        metadata: { key: "inc-b", segment: "user", kind: "wat" }, f: SRC },
    ],
  }], [baseManifest]);

  const a = state.cels.get("inc-a");
  const b = state.cels.get("inc-b");
  // Cache hit means both cels' _fn references the same Function.
  assert.equal(a._fn, b._fn, "identical sources should share _fn via cache");
  assert.equal(a._wasm, b._wasm, "identical sources should share _wasm via cache");

  const cache = state.cels.get("compile.cache").v;
  // firmware seed compiles (origin's 元.view) occupy slots from boot —
  // count only this test's wat entries.
  const watEntries = [...cache.keys()].filter((k) => k.startsWith("wat:")).length;
  assert.equal(watEntries, 1, "cache should hold exactly one entry for the shared source");
});

// ── different sources produce different envelopes ─────────────────────────

test("distinct sources produce distinct compiled envelopes", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  const SRC_ADD =
    "(module (func (export \"main\") (param $a i32) (param $b i32) (result i32) " +
    "local.get $a local.get $b i32.add))";
  const SRC_MUL =
    "(module (func (export \"main\") (param $a i32) (param $b i32) (result i32) " +
    "local.get $a local.get $b i32.mul))";

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "add", celType: "EditableLambdaCel",
        metadata: { key: "add", segment: "user", kind: "wat" }, f: SRC_ADD },
      { key: "mul", celType: "EditableLambdaCel",
        metadata: { key: "mul", segment: "user", kind: "wat" }, f: SRC_MUL },
    ],
  }], [baseManifest]);

  const add = state.cels.get("add");
  const mul = state.cels.get("mul");
  assert.notEqual(add._fn, mul._fn, "different sources should not share _fn");
  assert.equal([...state.cels.get("compile.cache").v.keys()].filter((k) => k.startsWith("wat:")).length, 2); // firmware seed slots excluded
});

// ── different KINDS with the same source don't collide ─────────────────────

test("same source under different compiler kinds caches separately", async () => {
  const state = createInitialState();
  const register = ((st, a) => resolveFn(st, "setCel")(st, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, f: a.source, dispose: a.dispose, metadata: { segment: a.segment, kind: a.kind, inputSchema: a.inputSchema, outputSchema: a.outputSchema } }));

  // A JS function source and an identical (but textually distinct)
  // WAT source — registered under their respective kinds. Verify the
  // cache keys differ by checking distinct cache entries exist.
  await register(state, {
    key: "js-id",
    source: "(x) => x",
    kind: "js",
  });

  // registerLambda doesn't go through compileCelBody, so it bypasses
  // the cache. Use the declarative hydrate path for the actual test.
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{
    name: "user",
    cels: [
      // Same string "(x)" — but as JS-source vs WAT-source they'd
      // resolve to different compiler keys; not both valid for either
      // language. So instead, just verify the cache key prefix includes
      // the kind by populating cache via two different-kind cels.
      { key: "js-doubler", celType: "EditableLambdaCel",
        metadata: { key: "js-doubler", segment: "user", kind: "js" },
        f: "(x) => x * 2" },
      { key: "wat-doubler", celType: "EditableLambdaCel",
        metadata: { key: "wat-doubler", segment: "user", kind: "wat" },
        f: "(module (func (export \"main\") (param $a i32) (result i32) " +
           "local.get $a i32.const 2 i32.mul))" },
    ],
  }], [baseManifest]);

  const cache = state.cels.get("compile.cache").v;
  // At least two entries: one per (kind, source) pair.
  assert.ok(cache.size >= 2, `cache.size = ${cache.size}, expected >= 2`);
  // Keys are prefixed with the resolved compiler key so they don't collide.
  const keys = [...cache.keys()];
  assert.ok(keys.some((k) => k.startsWith("js:")), `no js: entry in ${keys.join(", ")}`);
  assert.ok(keys.some((k) => k.startsWith("wat:")), `no wat: entry in ${keys.join(", ")}`);
});

// ── hot-reload: setCel with a new f recompiles and re-fires ────────────────

test("setCel({ f: newSource }) hot-reloads the lambda; cascade re-fires", async () => {
  const state = createInitialState();
  const hydrate  = resolveFn(state, "hydrate");
  const setCel   = resolveFn(state, "setCel");
  const precompute = resolveFn(state, "precompute");
  const runCycle = resolveFn(state, "runCycle");
  const precomputeOptional = resolveFn(state, "precomputeOptional");

  const initial =
    "(module (func (export \"main\") (param $a i32) (param $b i32) (result i32) " +
    "local.get $a local.get $b i32.add))";

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user", v: 6 } },
      { key: "b", celType: "ValueCel", metadata: { key: "b", segment: "user", v: 4 } },
      { key: "op", celType: "EditableLambdaCel",
        metadata: { key: "op", segment: "user", kind: "wat" }, f: initial },
      { key: "out", celType: "FormulaCel",
        metadata: { key: "out", segment: "user", parser: "f" }, f: "(op a b)" },
    ],
  }], [baseManifest]);
  await precomputeOptional?.(state);
  await runCycle(state);
  assert.equal(state.cels.get("out").v, 10);

  // Hot-reload: swap in multiply. setCel recompiles (cache miss for
  // the new source) and re-fires the cascade.
  const replaced =
    "(module (func (export \"main\") (param $a i32) (param $b i32) (result i32) " +
    "local.get $a local.get $b i32.mul))";
  await setCel(state, "op", { celType: "EditableLambdaCel", f: replaced, metadata: { segment: "user", kind: "wat" } });
  assert.equal(state.cels.get("out").v, 24);

  // Reverting to the original is a cache hit — no compile work, same
  // result.
  const cacheBefore = state.cels.get("compile.cache").v.size;
  await setCel(state, "op", { celType: "EditableLambdaCel", f: initial, metadata: { segment: "user", kind: "wat" } });
  const cacheAfter = state.cels.get("compile.cache").v.size;
  assert.equal(cacheAfter, cacheBefore, "reverting to a known source should hit the cache");
  assert.equal(state.cels.get("out").v, 10);
});

// ── compile errors are NOT cached (re-attempting recompiles) ───────────────

test("a compile error doesn't pollute the cache; fixing the source recompiles", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const setCel  = resolveFn(state, "setCel");

  await hydrate(state, [{
    name: "user",
    cels: [
      { key: "op", celType: "EditableLambdaCel",
        metadata: { key: "op", segment: "user", kind: "wat" },
        f: "(module (func not-a-real-instruction))" },
    ],
  }], [baseManifest]);
  const cache = state.cels.get("compile.cache").v;
  assert.equal([...cache.keys()].filter((k) => k.startsWith("wat:")).length, 0, "failed compile should not enter the cache (firmware seed slots excluded)");

  // Fix the source — replacing the definition triggers a fresh compile.
  await setCel(state, "op", {
    celType: "EditableLambdaCel", metadata: { segment: "user", kind: "wat" },
    f: "(module (func (export \"main\") (result i32) i32.const 42))",
  });
  assert.equal(typeof state.cels.get("op")._fn, "function", "valid source should compile");
  assert.equal([...cache.keys()].filter((k) => k.startsWith("wat:")).length, 1, "successful compile should populate the cache (firmware seed slots excluded)");
});
