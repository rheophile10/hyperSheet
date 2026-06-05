import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, resolveFn, installDormant, getPrecomputedIndexes,
  dormantSegmentOf, isSegmentPending,
} from "../dist/index.js";
import { createPainter, setPainter, getPainter } from "../dist/甲骨坑/library/plastron-dom/utils/paint.js";

// ============================================================================
// wake / sleep / forget — the three lifecycle verbs (design phase 3).
//
// wake(state, name)      — inflate + compile a dormant segment + its dormant
//                          dependency closure, settle once. Idempotent.
// sleep(state, name, o?) — dehydrate-in-place; refuse-with-list on awake
//                          dependents unless { cascade: true }; user-space
//                          SCCs sleep as a unit; native-bodied cels refuse;
//                          kernel never sleeps.
// forget(state, name, o?)— dormant ⇒ persist-to-sink + delete; awake ⇒
//                          sleep-then-forget (delegates to flush).
//
// Test-design: docs/3-test-design/00-ontology/dormant-segments.md (verb
//   semantics section). Design: derived-activity-working-set.md.
// ============================================================================

const boot = () => {
  const state = createInitialState();
  return {
    state,
    hydrate: resolveFn(state, "hydrate"),
    setValue: resolveFn(state, "setValue"),
    getCel: resolveFn(state, "getCel"),
    runCycle: resolveFn(state, "runCycle"),
    wake: resolveFn(state, "wake"),
    sleep: resolveFn(state, "sleep"),
    forget: resolveFn(state, "forget"),
    dehydrate: resolveFn(state, "dehydrate"),
  };
};

const lib = (name, deps = []) => ({
  name, version: "0.0.1", description: "", dependencies: deps, role: "library",
});
const user = (name, apps, deps = []) => ({
  name, version: "0.0.1", description: "", dependencies: deps,
  role: "user-space", applications: apps,
});
const app = (name, deps = []) => ({
  name, version: "0.0.1", description: "", dependencies: deps, role: "application",
});

const dval = (key, seg, v) => ({ key, celType: "ValueCel", metadata: { key, segment: seg }, v });
const dformula = (key, seg, f, inputMap = {}) => ({
  key, celType: "FormulaCel",
  metadata: { key, segment: seg, parser: "f", inputMap },
  f,
});

// ── wake: inflate + compile + settle ─────────────────────────────────────────

test("wake: a dormant segment's cels go live, formulas recompute against current inputs", async () => {
  const { state, wake, getCel } = boot();
  // dormant 'doc' with a value and a formula reading it.
  installDormant(state, { name: "doc", cels: [
    dval("doc.n", "doc", 3),
    dformula("doc.dbl", "doc", "(* doc.n 2)", { "doc.n": "doc.n" }),
  ] }, { dependencies: ["builtins"] });

  assert.equal(dormantSegmentOf(state, "doc.n"), "doc", "dormant before wake");
  assert.equal(state.cels.has("doc.n"), false, "no live cel before wake");

  await wake(state, "doc");

  assert.equal(state.cels.has("doc.n"), true, "live after wake");
  assert.equal(dormantSegmentOf(state, "doc.n"), undefined, "no longer dormant");
  assert.equal(state.cels.get("冊.doc")._dormant, undefined, "_dormant cleared");
  // The formula settled against the current input (3 * 2 = 6).
  assert.equal(getCel(state, "doc.dbl").v, 6, "formula recomputed on wake");
});

test("wake: idempotent — waking an awake segment is a no-op", async () => {
  const { state, wake, getCel, setValue } = boot();
  installDormant(state, { name: "doc", cels: [
    dval("doc.n", "doc", 5),
    dformula("doc.dbl", "doc", "(* doc.n 2)", { "doc.n": "doc.n" }),
  ] }, { dependencies: ["builtins"] });
  await wake(state, "doc");
  assert.equal(getCel(state, "doc.dbl").v, 10);
  // Second wake: no throw, no change.
  await wake(state, "doc");
  assert.equal(getCel(state, "doc.dbl").v, 10, "second wake is a no-op");
  // wake of an entirely unknown segment is also a no-op.
  await wake(state, "nope");
});

test("wake: pulls the dormant dependency closure (a dormant dep wakes too)", async () => {
  const { state, wake, getCel } = boot();
  // 'lo' (dormant) provides lo.base; 'hi' (dormant) reads it. Both dormant.
  installDormant(state, { name: "lo", cels: [dval("lo.base", "lo", 7)] },
    { dependencies: ["builtins"] });
  installDormant(state, { name: "hi", cels: [
    dformula("hi.out", "hi", "(+ lo.base 1)", { "lo.base": "lo.base" }),
  ] }, { dependencies: ["lo", "builtins"] });

  assert.equal(state.cels.has("lo.base"), false);
  assert.equal(state.cels.has("hi.out"), false);

  await wake(state, "hi");

  assert.equal(state.cels.has("lo.base"), true, "dormant dep woke with hi");
  assert.equal(state.cels.has("hi.out"), true);
  assert.equal(getCel(state, "hi.out").v, 8, "cross-segment formula settled (7 + 1)");
});

test("wake: re-wake hits the compile.cache (cache populated; re-compile reuses it)", async () => {
  const { state, wake, sleep } = boot();
  installDormant(state, { name: "doc", cels: [
    dval("doc.n", "doc", 2),
    dformula("doc.dbl", "doc", "(* doc.n 2)", { "doc.n": "doc.n" }),
  ] }, { dependencies: ["builtins"] });

  await wake(state, "doc");
  const cache = state.cels.get("compile.cache").v;
  const sizeAfterFirst = cache.size;
  assert.ok(sizeAfterFirst > 0, "compile cache populated by the first wake");

  // Sleep then wake again — the formula source recompiles, but the cache
  // already holds its envelope, so the cache size does not grow.
  await sleep(state, "doc");
  await wake(state, "doc");
  assert.equal(cache.size, sizeAfterFirst, "re-wake reused the cached envelope");
});

// ── sleep: dehydrate-in-place ────────────────────────────────────────────────

test("sleep: deflates cels to _dormant, drops live cels, leaves a readable dormant value", async () => {
  const { state, hydrate, sleep, getCel } = boot();
  await hydrate(state, [{ name: "doc", cels: [
    dval("doc.n", "doc", 4),
    dformula("doc.dbl", "doc", "(* doc.n 2)", { "doc.n": "doc.n" }),
  ] }], [lib("doc", ["builtins"])]);

  assert.equal(state.cels.has("doc.n"), true, "awake before sleep");
  await sleep(state, "doc");

  assert.equal(state.cels.has("doc.n"), false, "live cel dropped");
  assert.equal(state.cels.has("doc.dbl"), false);
  const segCel = state.cels.get("冊.doc");
  assert.ok(segCel._dormant, "payload hung on _dormant");
  assert.equal(segCel._dormant.cels.length, 2);
  assert.equal(dormantSegmentOf(state, "doc.n"), "doc", "dormant-key index rebuilt");
  // Reads return the dehydrated value.
  assert.equal(getCel(state, "doc.n").v, 4, "dormant value still readable");
});

test("sleep: idempotent — sleeping a dormant segment is a no-op", async () => {
  const { state, hydrate, sleep } = boot();
  await hydrate(state, [{ name: "doc", cels: [dval("doc.n", "doc", 1)] }],
    [lib("doc", ["builtins"])]);
  await sleep(state, "doc");
  const payload1 = state.cels.get("冊.doc")._dormant;
  await sleep(state, "doc"); // no-op
  assert.equal(state.cels.get("冊.doc")._dormant, payload1, "still the same payload");
});

test("sleep: kernel never sleeps (kernel-closure guard)", async () => {
  const { state, sleep } = boot();
  // The boot kernel closure is exactly {kernel} (role:kernel, no deps).
  await assert.rejects(() => sleep(state, "kernel"), /kernel closure/);
});

test("sleep: REFUSES with a list when an awake dependent exists", async () => {
  const { state, hydrate, sleep } = boot();
  // 'lo' provides lo.base; awake 'hi' reads it. Sleeping lo must refuse.
  await hydrate(state, [
    { name: "lo", cels: [dval("lo.base", "lo", 1)] },
    { name: "hi", cels: [dformula("hi.out", "hi", "(+ lo.base 1)", { "lo.base": "lo.base" })] },
  ], [lib("lo", ["builtins"]), lib("hi", ["lo", "builtins"])]);

  await assert.rejects(() => sleep(state, "lo"), /awake dependents/);
  await assert.rejects(() => sleep(state, "lo"), /hi/, "names the dependent");
  // hi (a leaf — nothing depends on it) sleeps fine.
  await sleep(state, "hi");
  assert.ok(state.cels.get("冊.hi")._dormant, "leaf slept");
});

test("sleep: { cascade: true } sleeps dependents first (leaves-first)", async () => {
  const { state, hydrate, sleep } = boot();
  await hydrate(state, [
    { name: "lo", cels: [dval("lo.base", "lo", 1)] },
    { name: "hi", cels: [dformula("hi.out", "hi", "(+ lo.base 1)", { "lo.base": "lo.base" })] },
  ], [lib("lo", ["builtins"]), lib("hi", ["lo", "builtins"])]);

  await sleep(state, "lo", { cascade: true });
  assert.ok(state.cels.get("冊.lo")._dormant, "lo slept");
  assert.ok(state.cels.get("冊.hi")._dormant, "dependent hi slept too (cascade)");
});

test("sleep: refuses a segment containing a native-bodied (code-seed) cel", async () => {
  const { state, sleep } = boot();
  // 'plastron-dom' is a bundled library full of native-bodied LockedLambda
  // cels (bound fns, no `f` source) plus the paint ChannelCel.
  await assert.rejects(() => sleep(state, "plastron-dom"), /native-bodied/);
});

// ── user-space SCC ───────────────────────────────────────────────────────────

test("sleep: strongly-connected user-space segments sleep as a unit", async () => {
  const { state, hydrate, sleep } = boot();
  // udoc.a reads upeer.b AND upeer.b reads udoc.a — a user⇄user cycle
  // (legal: the one-direction rule exempts user-space). They form one SCC.
  // A real role:application segment for the user-spaces to declare.
  await hydrate(state, [{ name: "myapp", cels: [dval("myapp.x", "myapp", 0)] }],
    [app("myapp", ["builtins"])]);
  await hydrate(state, [
    { name: "udoc", cels: [
      dval("udoc.seed", "udoc", 1),
      dformula("udoc.a", "udoc", "(+ upeer.b 0)", { "upeer.b": "upeer.b" }),
    ] },
    { name: "upeer", cels: [
      dformula("upeer.b", "upeer", "(+ udoc.seed 0)", { "udoc.seed": "udoc.seed" }),
    ] },
  ], [
    user("udoc", ["myapp"], ["upeer", "myapp", "builtins"]),
    user("upeer", ["myapp"], ["udoc", "myapp", "builtins"]),
  ]);

  // Sleeping either member sleeps BOTH (no refusal — the dependent is
  // inside the unit).
  await sleep(state, "udoc");
  assert.ok(state.cels.get("冊.udoc")._dormant, "udoc slept");
  assert.ok(state.cels.get("冊.upeer")._dormant, "its SCC peer slept as a unit");
});

// ── quiescent channels ───────────────────────────────────────────────────────

test("sleep: an awake view bound to a sleeping segment's channel refuses (channel edge)", async () => {
  const { state, hydrate, sleep } = boot();
  // 'chan' owns a ChannelCel; awake 'view' is channel-bound to it. That is
  // an awake→dormant-to-be edge; sleep's dependents check refuses.
  await hydrate(state, [
    { name: "chan", cels: [{
      key: "chan.c", celType: "ChannelCel",
      metadata: { key: "chan.c", segment: "chan" },
      v: { drain: "chan.c" },
    }] },
    { name: "view", cels: [
      dval("view.msg", "view", "hi"),
      {
        key: "view.v", celType: "FormulaCel",
        metadata: { key: "view.v", segment: "view", parser: "f",
          channel: ["chan.c"], inputMap: { m: "view.msg" } },
        f: "(+ view.msg 0)",
      },
    ] },
  ], [lib("chan", ["builtins"]), lib("view", ["chan", "builtins"])]);

  // view → chan (channel edge); sleeping chan with awake view refuses.
  await assert.rejects(() => sleep(state, "chan"), /awake dependents/);
  await assert.rejects(() => sleep(state, "chan"), /view/);
});

// ── forget ───────────────────────────────────────────────────────────────────

test("forget: a dormant segment is deleted (SegmentCel + payload gone)", async () => {
  const { state, hydrate, sleep, forget } = boot();
  await hydrate(state, [{ name: "doc", cels: [dval("doc.n", "doc", 1)] }],
    [lib("doc", ["builtins"])]);
  await sleep(state, "doc");
  assert.ok(state.cels.get("冊.doc")._dormant);

  await forget(state, "doc");
  assert.equal(state.cels.has("冊.doc"), false, "SegmentCel gone");
  assert.equal(dormantSegmentOf(state, "doc.n"), undefined, "dormant index cleared");
});

test("forget: an awake segment is sleep-then-forget (delegates to flush)", async () => {
  const { state, hydrate, forget } = boot();
  await hydrate(state, [{ name: "doc", cels: [dval("doc.n", "doc", 1)] }],
    [lib("doc", ["builtins"])]);
  await forget(state, "doc");
  assert.equal(state.cels.has("doc.n"), false, "live cel gone");
  // A user-space-style runtime segment leaves nothing behind (no bundled
  // loader to re-park).
  assert.equal(state.cels.has("冊.doc"), false, "manifest gone (no re-park)");
});

test("forget: kernel-closure guard stays (awake path via flush)", async () => {
  const { state, forget } = boot();
  await assert.rejects(() => forget(state, "kernel"), /kernel closure/);
});

// ── persistence sinks ────────────────────────────────────────────────────────

test("sleep: autoSave sink persists the payload through store.put before going dormant", async () => {
  const { state, hydrate, sleep } = boot();
  // Intercept the store.put fn cel (segment-store is bundled). Record calls.
  const calls = [];
  const putCel = state.cels.get("store.put");
  const orig = putCel._fn;
  putCel._fn = async (...args) => { calls.push(args); return orig ? undefined : undefined; };

  const manifest = lib("doc", ["builtins"]);
  manifest.sink = { kind: "segment-store", autoSave: true };
  await hydrate(state, [{ name: "doc", cels: [dval("doc.n", "doc", 9)] }], [manifest]);

  await sleep(state, "doc");
  assert.equal(calls.length, 1, "store.put called once on autoSave sleep");
  assert.equal(calls[0][0], "doc", "put named the segment");
  assert.ok(calls[0][3] && calls[0][3].name === "doc", "put handed the payload 甲骨");
  putCel._fn = orig;
});

test("sleep: no sink (or autoSave:false) does NOT persist", async () => {
  const { state, hydrate, sleep } = boot();
  const calls = [];
  const putCel = state.cels.get("store.put");
  const orig = putCel._fn;
  putCel._fn = async (...args) => { calls.push(args); };
  await hydrate(state, [{ name: "doc", cels: [dval("doc.n", "doc", 1)] }],
    [lib("doc", ["builtins"])]);
  await sleep(state, "doc");
  assert.equal(calls.length, 0, "no sink ⇒ no persist");
  putCel._fn = orig;
});

// ── loader re-park ───────────────────────────────────────────────────────────

test("forget a BUNDLED library, then loadSegment brings it back", async () => {
  // Lazy-load 'sound' (a bundled library), then forget it; re-park should
  // make it loadable again.
  const state = createInitialState({ lazy: ["sound"] });
  const forget = resolveFn(state, "forget");
  const loadSegment = resolveFn(state, "loadSegment");

  await loadSegment(state, "sound");
  assert.equal(state.cels.has("sound.play-tone"), true, "sound loaded");

  // forget an awake bundled segment ⇒ flush ⇒ re-park.
  await forget(state, "sound");
  assert.equal(state.cels.has("sound.play-tone"), false, "sound cels gone");
  assert.equal(isSegmentPending(state, "sound"), true, "loader re-parked (pending again)");

  await loadSegment(state, "sound");
  assert.equal(state.cels.has("sound.play-tone"), true, "loadSegment brought it back");
});

// ── painter empty-spec teardown ──────────────────────────────────────────────

test("sleep: tears down a view cel's mounted DOM via an empty paint spec", async () => {
  const state = createInitialState();
  // Mock-raf painter (off-browser pattern from raf-channel.test.mjs).
  const q = [];
  const mockRaf = { raf: (cb) => q.push(cb), caf: () => {}, run: () => { for (const cb of q.splice(0)) cb(); } };
  setPainter(state, createPainter(state, { raf: mockRaf.raf, caf: mockRaf.caf, isBrowser: false }));

  const hydrate = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");
  const drain = resolveFn(state, "drain");
  const sleep = resolveFn(state, "sleep");

  await hydrate(state, [{ name: "ui", cels: [
    { key: "ui.mount", celType: "ValueCel", metadata: { key: "ui.mount", segment: "ui" }, v: "#app" },
    { key: "ui.msg", celType: "ValueCel", metadata: { key: "ui.msg", segment: "ui" }, v: "hello" },
    {
      key: "ui.view", celType: "FormulaCel",
      metadata: { key: "ui.view", segment: "ui", parser: "html-template", schema: "render-spec",
        channel: ["plastron-dom.paint"], inputMap: { msg: "ui.msg", mount: "ui.mount" } },
      f: "<div>{{msg}}</div>",
    },
  ] }], [lib("ui", ["plastron-dom", "html-template-parser", "builtins"])]);

  await runCycle(state);
  await drain(state, "plastron-dom.paint");
  mockRaf.run();
  const painter = getPainter(state);
  assert.equal(painter.lastPatch("#app").kind, "init", "view painted at #app");

  // Sleep the segment — teardown enqueues an empty spec at #app, drained
  // inside sleep (flushChannels). Run the frame to apply.
  await sleep(state, "ui");
  mockRaf.run();
  const after = painter.lastPatch("#app");
  // The empty spec diffs the prior <div> tree → a non-init patch (replace
  // to an empty text node), i.e. the mount is torn down.
  assert.ok(after && after.kind !== "init", "empty spec produced a teardown patch at the vacated mount");
});
