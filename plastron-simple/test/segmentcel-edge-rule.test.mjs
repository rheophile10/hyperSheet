import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// ============================================================================
// SegmentCel reification + the one-direction cross-segment edge rule.
//
// Segments are SegmentCels (冊.<name>) in state.cels; the segment
// dependency graph is DERIVED in precompute from live cel edges
// (inputMap / imports / channel) aggregated through each cel's live
// metadata.segment. Between two CODE-role segments, those edges may flow
// one way only — a two-way pair throws. User-space endpoints are exempt.
//
// Design: docs/1-design/3-accepted/00-ontology/derived-activity-working-set.md
// "The segment DAG"; audit: 2-roadmap/completed/one-direction-audit.md.
// ============================================================================

const boot = () => {
  const state = createInitialState();
  return { state, hydrate: resolveFn(state, "hydrate"), setCel: resolveFn(state, "setCel") };
};

const lib = (name) => ({ name, version: "0.0.1", description: "", dependencies: [], role: "library" });

// A FormulaCel in `seg` reading `target` (cross-segment when target's
// segment differs). The default parser auto-wires inputMap from the body.
const reader = (key, seg, target) => ({
  key, celType: "FormulaCel",
  metadata: { key, segment: seg, parser: "f" },
  f: `(+ ${target} 0)`,
});
const val = (key, seg, v) => ({ key, celType: "ValueCel", metadata: { key, segment: seg }, v });

// ── SegmentCel reification ───────────────────────────────────────────────────

test("a segment is a SegmentCel at 冊.<name> with its 冊 as v", () => {
  const { state } = boot();
  const cel = state.cels.get("冊.kernel");
  assert.ok(cel, "冊.kernel SegmentCel exists");
  assert.equal(cel.celType, "SegmentCel");
  assert.equal(cel.v.name, "kernel");
  assert.equal(cel.v.role, "kernel");
  assert.equal(cel.metadata.segment, "kernel", "metadata.segment = its own name");
});

// ── Derived adjacency in precompute ──────────────────────────────────────────

test("precompute derives cross-segment adjacency from inputMap edges", async () => {
  const { state, hydrate } = boot();
  await hydrate(
    state,
    [
      { name: "lo", cels: [val("lo.x", "lo", 1)] },
      { name: "hi", cels: [reader("hi.y", "hi", "lo.x")] },
    ],
    [lib("lo"), lib("hi")],
  );
  const idx = state.cels.get("precomputedStates").v;
  assert.ok(idx.segmentAdjacency.get("hi")?.has("lo"), "hi → lo observed");
  assert.ok(!idx.segmentAdjacency.get("lo"), "lo originates no edge (one-directional)");
  assert.equal(idx.segments.has("hi"), true, "segments index carries hi");
  assert.equal(idx.segmentRoles.get("hi"), "library");
});

// ── One-direction rule: two code-role segments ───────────────────────────────

test("hydrate batch creating a two-way library pair throws naming the pair", async () => {
  const { state, hydrate } = boot();
  await assert.rejects(
    hydrate(
      state,
      [
        { name: "alib", cels: [val("alib.x", "alib", 1), reader("alib.r", "alib", "blib.x")] },
        { name: "blib", cels: [val("blib.x", "blib", 2), reader("blib.r", "blib", "alib.x")] },
      ],
      [lib("alib"), lib("blib")],
    ),
    (e) => {
      assert.match(e.message, /one-direction rule/);
      assert.match(e.message, /alib/);
      assert.match(e.message, /blib/);
      return true;
    },
  );
});

test("the same shape with one endpoint user-space does NOT throw", async () => {
  const { state, hydrate } = boot();
  // app + a user-space doc under it; doc reads the app and the app reads
  // the doc → two-way, but one endpoint is user-space ⇒ exempt.
  await hydrate(
    state,
    [{ name: "uapp", cels: [] }],
    [{ name: "uapp", version: "0.0.1", description: "", dependencies: [], role: "application" }],
  );
  await assert.doesNotReject(
    hydrate(
      state,
      [
        { name: "uapp", cels: [val("uapp.x", "uapp", 1), reader("uapp.r", "uapp", "udoc.x")] },
        { name: "udoc", cels: [val("udoc.x", "udoc", 2), reader("udoc.r", "udoc", "uapp.x")] },
      ],
      [
        { name: "uapp", version: "0.0.1", description: "", dependencies: [], role: "application" },
        { name: "udoc", version: "0.0.1", description: "", dependencies: ["uapp"], role: "user-space", applications: ["uapp"] },
      ],
    ),
  );
});

test("doom-style imports edge counts: two-way via imports one way + inputMap the other throws", async () => {
  const { state, hydrate } = boot();
  // rt (a runtime library) has a wasm-style cel naming an imports provider
  // in segment `prov`; prov has a cel reading back into rt via inputMap.
  // imports rt→prov, inputMap prov→rt ⇒ two-way between two libraries.
  await assert.rejects(
    hydrate(
      state,
      [
        {
          name: "rt",
          cels: [
            val("rt.export", "rt", 0),
            // a cel in rt that imports a provider cel living in prov
            { key: "rt.w", celType: "ValueCel", metadata: { key: "rt.w", segment: "rt", imports: "prov.provider" }, v: 0 },
          ],
        },
        {
          name: "prov",
          cels: [val("prov.provider", "prov", 0), reader("prov.r", "prov", "rt.export")],
        },
      ],
      [lib("rt"), lib("prov")],
    ),
    (e) => {
      assert.match(e.message, /one-direction rule/);
      return true;
    },
  );
});

// ── Segment state observable by formulas ─────────────────────────────────────

test("a formula can read a SegmentCel's v", async () => {
  const { state, hydrate, setCel } = boot();
  await hydrate(
    state,
    [{ name: "lo", cels: [val("lo.x", "lo", 1)] }],
    [{ name: "lo", version: "9.9.9", description: "", dependencies: [], role: "library" }],
  );
  // A native head fn that pulls .version off whatever it's handed.
  await setCel(state, "seg-version", {
    celType: "LockedLambdaCel",
    metadata: { key: "seg-version", segment: "probe", kind: "js" },
    fn: (manifest) => manifest?.version,
  });
  // A formula reading the SegmentCel 冊.lo as an input and projecting its
  // version — proves SegmentCel state is observable through the cascade.
  await hydrate(
    state,
    [{ name: "probe", cels: [{
      key: "probe.ver", celType: "FormulaCel",
      metadata: { key: "probe.ver", segment: "probe", parser: "f" },
      f: "(seg-version 冊.lo)",
    }] }],
    [lib("probe")],
  );
  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  assert.equal(state.cels.get("probe.ver").v, "9.9.9", "formula read 冊.lo.v.version");
});

// ── Round-trip: dehydrate → hydrate preserves manifests ──────────────────────

test("dehydrate → hydrate preserves SegmentCel manifests", async () => {
  const { state, hydrate } = boot();
  await hydrate(
    state,
    [{ name: "keep", cels: [val("keep.x", "keep", 7)] }],
    [{ name: "keep", version: "1.2.3", description: "round-trip", dependencies: [], role: "library" }],
  );
  const dehydrate = resolveFn(state, "dehydrate");
  const dumped = dehydrate(state);
  const keepMan = dumped.manifests.find((m) => m.name === "keep");
  assert.ok(keepMan, "keep manifest emitted");
  assert.equal(keepMan.version, "1.2.3");
  // No SegmentCel leaked into the segment payload.
  const keepSeg = dumped.segments.find((s) => s.name === "keep");
  assert.ok(!keepSeg.cels.some((c) => c.celType === "SegmentCel"), "no SegmentCel in payload");

  const fresh = createInitialState();
  const hydrate2 = resolveFn(fresh, "hydrate");
  await hydrate2(fresh, dumped.segments, dumped.manifests);
  assert.equal(fresh.cels.get("冊.keep")?.v.version, "1.2.3", "manifest restored as SegmentCel");
  assert.equal(fresh.cels.get("keep.x")?.v, 7, "payload restored");
});
