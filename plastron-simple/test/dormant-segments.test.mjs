import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, resolveFn, installDormant, getPrecomputedIndexes,
  assertOneDirection, dormantSegmentOf,
} from "../dist/index.js";

// ============================================================================
// Dormant segments (design phase 2).
//
// A dormant segment's cels live ONLY as dehydrated data (a 甲骨 payload)
// hung on its SegmentCel's `_dormant` runtime field; state.cels holds no
// live entry for them. Topology still sees their edges (precompute reads
// _dormant into dormantKeys + segmentAdjacency); getCel returns a read-only
// view of the dehydrated value; writes throw naming the cel + segment; the
// cascade never fires them; dehydrate passes their payload through.
//
// Wake/sleep/forget are roadmap 05 — here installDormant (internal helper)
// constructs a dormant segment for these tests.
//
// Test-design: docs/3-test-design/00-ontology/dormant-segments.md
// Design: docs/1-design/3-accepted/00-ontology/derived-activity-working-set.md
// ============================================================================

const boot = () => {
  const state = createInitialState();
  return {
    state,
    hydrate: resolveFn(state, "hydrate"),
    setValue: resolveFn(state, "setValue"),
    setValueBatch: resolveFn(state, "setValueBatch"),
    setCel: resolveFn(state, "setCel"),
    setCelBatch: resolveFn(state, "setCelBatch"),
    getCel: resolveFn(state, "getCel"),
    runCycle: resolveFn(state, "runCycle"),
    dehydrate: resolveFn(state, "dehydrate"),
  };
};

const lib = (name, deps = []) => ({
  name, version: "0.0.1", description: "", dependencies: deps, role: "library",
});

// A DehydratedCel (authored-seed shape: v at top level).
const dval = (key, seg, v) => ({ key, celType: "ValueCel", metadata: { key, segment: seg }, v });
const dformula = (key, seg, f, v) => ({
  key, celType: "FormulaCel",
  metadata: { key, segment: seg, parser: "f", v },
  f,
});

// ── Representation invariants ────────────────────────────────────────────────

test("R1+R2: installDormant hangs payload on SegmentCel; state.cels stays clean; dormantKeys maps keys→segment", () => {
  const { state } = boot();
  installDormant(state, { name: "doc", cels: [dval("doc.a", "doc", 1), dval("doc.b", "doc", 2)] });

  const segCel = state.cels.get("冊.doc");
  assert.equal(segCel.celType, "SegmentCel");
  assert.ok(segCel._dormant, "payload hung on _dormant");
  assert.equal(segCel._dormant.cels.length, 2);
  assert.equal(state.cels.has("doc.a"), false, "no live cel for dormant key");
  assert.equal(state.cels.has("doc.b"), false);

  const dk = getPrecomputedIndexes(state).dormantKeys;
  assert.equal(dk.get("doc.a"), "doc");
  assert.equal(dk.get("doc.b"), "doc");
});

test("R3: _dormant never rides dehydrate output (it carries the payload, which emits as cels, not as a field)", () => {
  const { state, dehydrate } = boot();
  installDormant(state, { name: "doc", cels: [dval("doc.a", "doc", 1)] });
  const dumped = dehydrate(state);
  // No emitted cel/manifest carries a `_dormant` field — the payload is
  // unpacked into the segment's `cels`, never serialized as a runtime field.
  for (const seg of dumped.segments)
    for (const c of seg.cels) assert.ok(!("_dormant" in c), "no _dormant on dehydrated cel");
  for (const m of dumped.manifests) assert.ok(!("_dormant" in m), "no _dormant on dehydrated manifest");
  // The manifest's 冊 (v) — what collectManifests emits — has no _dormant.
  const man = dumped.manifests.find((mm) => mm.name === "doc");
  assert.ok(man && !("_dormant" in man), "_dormant is a cel runtime field, not part of the 冊");
});

test("R4: an awake-only state has an empty dormantKeys index", async () => {
  const { state, hydrate } = boot();
  await hydrate(state, [{ name: "s", cels: [dval("s.x", "s", 1)] }], [lib("s")]);
  assert.equal(getPrecomputedIndexes(state).dormantKeys.size, 0);
});

// ── Topology over dormant edges ──────────────────────────────────────────────

test("T1: a dormant cel reading an awake cel feeds segmentAdjacency (dormant→awake)", async () => {
  const { state, hydrate } = boot();
  await hydrate(state, [{ name: "lo", cels: [dval("lo.x", "lo", 1)] }], [lib("lo")]);
  // dormant `hi` whose cel reads lo.x (inputMap edge hi→lo).
  installDormant(state, {
    name: "hi",
    cels: [{
      key: "hi.y", celType: "FormulaCel",
      metadata: { key: "hi.y", segment: "hi", inputMap: { a: "lo.x" }, v: 0 },
      f: "(+ a 0)",
    }],
  });
  const idx = getPrecomputedIndexes(state);
  assert.ok(idx.segmentAdjacency.get("hi")?.has("lo"), "dormant hi → awake lo");
});

test("T2: dormant cels' imports/channel edges also feed segmentAdjacency", async () => {
  const { state, hydrate } = boot();
  await hydrate(state, [{ name: "prov", cels: [dval("prov.p", "prov", 0)] }], [lib("prov")]);
  installDormant(state, {
    name: "rt",
    cels: [{
      key: "rt.w", celType: "ValueCel",
      metadata: { key: "rt.w", segment: "rt", imports: "prov.p" }, v: 0,
    }],
  });
  assert.ok(getPrecomputedIndexes(state).segmentAdjacency.get("rt")?.has("prov"), "imports edge rt → prov");
});

test("T3: no dormant cel appears in waveCascade / children / dynamicCascade", async () => {
  const { state, hydrate } = boot();
  await hydrate(state, [{ name: "lo", cels: [dval("lo.x", "lo", 1)] }], [lib("lo")]);
  installDormant(state, {
    name: "hi",
    cels: [{
      key: "hi.y", celType: "FormulaCel",
      metadata: { key: "hi.y", segment: "hi", inputMap: { a: "lo.x" }, dynamic: true, v: 0 },
      f: "(+ a 0)",
    }],
  });
  const idx = getPrecomputedIndexes(state);
  for (const levels of idx.waveCascade.values())
    for (const level of levels)
      assert.ok(!level.includes("hi.y"), "dormant cel not in waveCascade");
  assert.ok(!idx.dynamicCascade.has("hi.y"), "dormant cel not dynamic-cascaded even with dynamic:true");
  // children indexes dependents — hi.y must not appear as a dependent of lo.x.
  assert.ok(!(idx.children.get("lo.x")?.has("hi.y")), "dormant cel not a live dependent");
});

test("T4: segments name-set + segmentRoles include the dormant segment", () => {
  const { state } = boot();
  installDormant(state, { name: "doc", cels: [dval("doc.a", "doc", 1)] });
  const idx = getPrecomputedIndexes(state);
  assert.ok(idx.segments.has("doc"), "dormant segment in name-set");
  assert.equal(idx.segmentRoles.get("doc"), "library");
});

// ── One-direction rule over awake ∪ dormant edges ────────────────────────────

test("O1: two-way code-role pair via a dormant edge + an awake edge throws", async () => {
  const { state, hydrate } = boot();
  // awake `alib` reads blib.x; dormant `blib` reads alib.x → two-way, both libraries.
  await hydrate(
    state,
    [{ name: "alib", cels: [dval("alib.x", "alib", 1), {
      key: "alib.r", celType: "FormulaCel",
      metadata: { key: "alib.r", segment: "alib", inputMap: { a: "blib.x" }, v: 0 }, f: "(+ a 0)",
    }] }],
    [lib("alib")],
  );
  // installDormant re-runs precompute; the one-direction rule is enforced at
  // hydrate/setCel, so trigger it explicitly via setCel after the dormant edge
  // exists. Here we assert the derived two-way pair is detectable.
  installDormant(state, {
    name: "blib",
    cels: [{
      key: "blib.x", celType: "ValueCel", metadata: { key: "blib.x", segment: "blib" }, v: 2,
    }, {
      key: "blib.r", celType: "FormulaCel",
      metadata: { key: "blib.r", segment: "blib", inputMap: { a: "alib.x" }, v: 0 }, f: "(+ a 0)",
    }],
  });
  assert.throws(() => assertOneDirection(state), /one-direction rule/);
});

test("O2: same two-way shape with a user-space endpoint does NOT throw", async () => {
  const { state, hydrate } = boot();
  await hydrate(
    state,
    [{ name: "uapp", cels: [dval("uapp.x", "uapp", 1), {
      key: "uapp.r", celType: "FormulaCel",
      metadata: { key: "uapp.r", segment: "uapp", inputMap: { a: "udoc.x" }, v: 0 }, f: "(+ a 0)",
    }] }],
    [{ name: "uapp", version: "0.0.1", description: "", dependencies: [], role: "application" }],
  );
  installDormant(
    state,
    {
      name: "udoc",
      cels: [
        { key: "udoc.x", celType: "ValueCel", metadata: { key: "udoc.x", segment: "udoc" }, v: 2 },
        { key: "udoc.r", celType: "FormulaCel",
          metadata: { key: "udoc.r", segment: "udoc", inputMap: { a: "uapp.x" }, v: 0 }, f: "(+ a 0)" },
      ],
    },
    { role: "user-space" },
  );
  assert.doesNotThrow(() => assertOneDirection(state));
});

// ── Reads ────────────────────────────────────────────────────────────────────

test("D1: getCel of a dormant ValueCel returns {celType,metadata,v}; no inflation/caching", () => {
  const { state, getCel } = boot();
  installDormant(state, { name: "doc", cels: [dval("doc.a", "doc", 42)] });
  const view = getCel(state, "doc.a");
  assert.equal(view.celType, "ValueCel");
  assert.equal(view.v, 42, "dehydrated v");
  assert.equal(view.metadata.key, "doc.a");
  assert.equal(view._fn, undefined, "no compiled artifacts");
  assert.equal(state.cels.has("doc.a"), false, "getCel did not inflate/cache a live cel");
});

test("D2: getCel of a dormant FormulaCel returns its last dehydrated value; _fn absent", () => {
  const { state, getCel } = boot();
  installDormant(state, { name: "doc", cels: [dformula("doc.f", "doc", "(+ 1 2)", 3)] });
  const view = getCel(state, "doc.f");
  assert.equal(view.celType, "FormulaCel");
  assert.equal(view.v, 3, "last dehydrated value (metadata.v)");
  assert.equal(view._fn, undefined);
  assert.equal(view._evaluate, undefined);
});

test("D3: getCel of an awake key is unchanged (live Cel)", async () => {
  const { state, hydrate, getCel } = boot();
  await hydrate(state, [{ name: "s", cels: [dval("s.x", "s", 7)] }], [lib("s")]);
  const cel = getCel(state, "s.x");
  assert.equal(cel, state.cels.get("s.x"), "same live cel object");
});

test("D4: getCel of an unknown key returns undefined", () => {
  const { state, getCel } = boot();
  installDormant(state, { name: "doc", cels: [dval("doc.a", "doc", 1)] });
  assert.equal(getCel(state, "nope.nope"), undefined);
});

// ── Writes throw ─────────────────────────────────────────────────────────────

const dormantWriteState = () => {
  const { state, ...fns } = boot();
  installDormant(state, { name: "doc", cels: [dval("doc.a", "doc", 1)] });
  return { state, ...fns };
};

test("W1: setValue against a dormant key throws naming cel + segment", async () => {
  const { state, setValue } = dormantWriteState();
  await assert.rejects(setValue(state, "doc.a", 9), (e) => {
    assert.match(e.message, /doc\.a/);
    assert.match(e.message, /doc/);
    assert.match(e.message, /dormant/i);
    return true;
  });
});

test("W2: setCel against a dormant key throws naming cel + segment", async () => {
  const { state, setCel } = dormantWriteState();
  await assert.rejects(
    setCel(state, "doc.a", { celType: "ValueCel", metadata: { key: "doc.a", segment: "doc" }, v: 9 }),
    (e) => { assert.match(e.message, /doc\.a/); assert.match(e.message, /"doc"/); return true; },
  );
});

test("W3: setValueBatch with a dormant key throws and leaves no awake cel mutated", async () => {
  const { state, hydrate, setValueBatch } = boot();
  await hydrate(state, [{ name: "s", cels: [dval("s.x", "s", 1)] }], [lib("s")]);
  installDormant(state, { name: "doc", cels: [dval("doc.a", "doc", 1)] });
  await assert.rejects(setValueBatch(state, [["s.x", 99], ["doc.a", 5]]), /dormant/i);
  assert.equal(state.cels.get("s.x").v, 1, "awake write rolled back (never applied)");
});

test("W4: setCelBatch with a dormant key throws before any spec installs", async () => {
  const { state, setCelBatch } = dormantWriteState();
  await assert.rejects(
    setCelBatch(state, {
      "new.ok": { celType: "ValueCel", metadata: { key: "new.ok", segment: "x" }, v: 1 },
      "doc.a": { celType: "ValueCel", metadata: { key: "doc.a", segment: "doc" }, v: 2 },
    }),
    /dormant/i,
  );
  assert.equal(state.cels.has("new.ok"), false, "no partial install");
});

test("W5: the SegmentCel key (冊.<name>) of a dormant segment is NOT itself dormant — writes to OTHER segments still work", async () => {
  const { state, setValue } = dormantWriteState();
  // Over-broad dormant matching would wrongly flag the live manifest cel.
  assert.equal(dormantSegmentOf(state, "冊.doc"), undefined, "the manifest cel is live, not dormant");
  // And an awake cel in a different segment writes fine alongside the dormant one.
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{ name: "s", cels: [dval("s.x", "s", 1)] }], [lib("s")]);
  await setValue(state, "s.x", 8);
  assert.equal(state.cels.get("s.x").v, 8);
});

// ── Dispatch-path write surfaces as a logged listener error ──────────────────

test("X1: a dispatch-path dormant write is logged via reportError, not an unhandled rejection", async () => {
  const { state } = dormantWriteState();
  const { compileAction } = await import("../dist/甲骨坑/library/plastron-dom/utils/events.js");

  const origError = console.error;
  let logged = null;
  console.error = (...args) => { logged = args; };
  try {
    const handler = compileAction('(set doc.a 5)', state);
    handler({ type: "click", target: {} });
    // setValue is awaited inside the handler via Promise.resolve().catch —
    // let the microtask run.
    await new Promise((r) => setTimeout(r, 10));
  } finally {
    console.error = origError;
  }
  assert.ok(logged, "reportError logged the dormant write failure");
  assert.ok(String(logged.join(" ")).includes("plastron-dom"), "logged through reportError path");
});

// ── Cascade never fires a dormant cel ────────────────────────────────────────

test("C1: write to an awake upstream does not fire its dormant downstream", async () => {
  const { state, hydrate, setValue } = boot();
  await hydrate(state, [{ name: "a", cels: [dval("a.x", "a", 1)] }], [lib("a")]);
  // dormant d.y reads a.x (dormant sits ABOVE awake — legal).
  installDormant(state, {
    name: "d",
    cels: [{
      key: "d.y", celType: "FormulaCel",
      metadata: { key: "d.y", segment: "d", inputMap: { a: "a.x" }, v: 111 },
      f: "(+ a 1000)",
    }],
  });
  await setValue(state, "a.x", 5); // succeeds, runs cascade
  assert.equal(state.cels.get("a.x").v, 5, "awake write landed");
  assert.equal(state.cels.has("d.y"), false, "dormant cel never inflated/fired");
  // its dehydrated value is untouched (still 111, NOT 5+1000).
  const view = resolveFn(state, "getCel")(state, "d.y");
  assert.equal(view.v, 111, "dormant value unchanged by the cascade");
});

test("C2: runCycle over a state with a dormant downstream does not touch it", async () => {
  const { state, hydrate, runCycle } = boot();
  await hydrate(state, [{ name: "a", cels: [dval("a.x", "a", 1)] }], [lib("a")]);
  installDormant(state, {
    name: "d",
    cels: [{
      key: "d.y", celType: "FormulaCel",
      metadata: { key: "d.y", segment: "d", inputMap: { a: "a.x" }, v: 111 }, f: "(+ a 1000)",
    }],
  });
  await runCycle(state);
  assert.equal(state.cels.has("d.y"), false, "dormant cel still absent after runCycle");
});

// ── Dehydrate pass-through ───────────────────────────────────────────────────

test("H1: dehydrate emits the dormant segment's payload cels + its manifest", () => {
  const { state, dehydrate } = boot();
  installDormant(state, { name: "doc", cels: [dval("doc.a", "doc", 1), dval("doc.b", "doc", 2)] });
  const dumped = dehydrate(state);
  const seg = dumped.segments.find((s) => s.name === "doc");
  assert.ok(seg, "dormant segment emitted");
  assert.equal(seg.cels.length, 2);
  assert.deepEqual(seg.cels.map((c) => c.key).sort(), ["doc.a", "doc.b"]);
  assert.ok(dumped.manifests.find((m) => m.name === "doc"), "manifest emitted");
});

test("H2: round-trip rehydrates the dormant payload as LIVE cels", async () => {
  const { state, dehydrate } = boot();
  installDormant(state, { name: "doc", cels: [dval("doc.a", "doc", 5)] });
  const dumped = dehydrate(state);

  const fresh = createInitialState();
  const hydrate2 = resolveFn(fresh, "hydrate");
  await hydrate2(fresh, dumped.segments, dumped.manifests);
  assert.equal(fresh.cels.get("doc.a")?.v, 5, "payload rehydrated as a live cel");
  // hydrate has no dormancy — the rehydrated segment is awake.
  assert.equal(getPrecomputedIndexes(fresh).dormantKeys.has("doc.a"), false);
});

test("H3: onlySegments filtering includes/excludes a dormant segment", () => {
  const { state, dehydrate } = boot();
  installDormant(state, { name: "doc", cels: [dval("doc.a", "doc", 1)] });
  installDormant(state, { name: "other", cels: [dval("other.z", "other", 9)] });
  const only = dehydrate(state, { onlySegments: ["doc"] });
  assert.ok(only.segments.find((s) => s.name === "doc"), "doc included");
  assert.ok(!only.segments.find((s) => s.name === "other"), "other excluded");
});
