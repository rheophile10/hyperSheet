import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";
import { governStep } from "../dist/甲骨坑/library/scheduler/index.js";

// scheduler — the learn/lock/lose frame governor. governStep is pure → Tier-A;
// clock.tick wires it to the clock.* cels → Tier-B. No browser, deterministic.

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const budget60 = 1000 / 60;

// ── Tier-A: the pure controller ──────────────────────────────────────────────

test("governStep: a capable device throttles to the target rate", () => {
  // cost (5ms) well under the 60fps budget (16.67ms) → wait out the remainder
  const r = governStep(0, 0, 5, 60, "learn");
  approx(r.cost_ewma, 5, 1e-9);
  approx(r.interval, budget60 - 5);
  approx(r.fps, 60);
  // achieved period (cost + interval) lands on the budget
  approx(5 + r.interval, budget60);
});

test("governStep: an overloaded device degrades to its sustainable rate, no busy-wait", () => {
  // cost (40ms) over budget → interval collapses to 0, fps reports the real rate
  const r = governStep(0, 0, 40, 60, "learn");
  approx(r.interval, 0, 1e-9);
  approx(r.fps, 25); // 1000 / 40
  assert.ok(r.fps < 60, "achievable fps is below target");
});

test("governStep: interval stays bounded in [0, budget]", () => {
  for (const cost of [0, 1, 8, 16, 17, 50, 500]) {
    const r = governStep(0, 0, cost, 60, "learn");
    assert.ok(r.interval >= 0 && r.interval <= budget60 + 1e-9, `cost ${cost} → interval ${r.interval}`);
  }
});

test("governStep: 'learn' folds cost into an EWMA that converges toward steady cost", () => {
  let ewma = 10, n = 3;
  let last = ewma;
  for (let i = 0; i < 50; i++) {
    const r = governStep(ewma, n, 20, 60, "learn"); // steady 20ms frames
    ewma = r.cost_ewma; n = r.samples;
    assert.ok(ewma >= last - 1e-9, "EWMA moves monotonically toward 20");
    last = ewma;
  }
  approx(ewma, 20, 0.2); // converged near the steady cost
  assert.equal(n, 53, "sample count accumulates");
});

test("governStep: 'lock' freezes the learned model against new samples", () => {
  const r = governStep(10, 5, 100, 60, "lock"); // a 100ms spike
  approx(r.cost_ewma, 10, 1e-9); // model unchanged
  assert.equal(r.samples, 5, "sample count frozen");
  // but the OUTPUT still reacts to the live cost: a spike over the frozen period → no wait
  approx(r.interval, 0, 1e-9);
});

test("governStep: 'lose' resets the model to the latest sample", () => {
  const r = governStep(10, 99, 33, 60, "lose");
  approx(r.cost_ewma, 33, 1e-9);
  assert.equal(r.samples, 1);
});

test("governStep: first sample seeds the EWMA (no warm-up bias); junk inputs are safe", () => {
  approx(governStep(0, 0, 12, 60, "learn").cost_ewma, 12, 1e-9);
  const r = governStep("x", null, undefined, "nope", "learn"); // all junk
  assert.ok(Number.isFinite(r.interval) && Number.isFinite(r.fps) && Number.isFinite(r.cost_ewma));
});

// ── Tier-B: the cel-wired step ───────────────────────────────────────────────

test("clock.* cels seed with defaults; clock.tick updates the model + outputs", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["scheduler"]);
  const v = (k) => state.cels.get(k)?.v;
  assert.equal(v("clock.target_fps"), 60, "seeded target");
  assert.equal(v("clock.mode"), "learn", "seeded mode");
  assert.equal(v("clock.samples"), 0, "no samples yet");

  // one frame cost in → model + outputs land on the cels, interval returned
  const interval = await resolveFn(state, "clock.tick")(state, 5);
  approx(Number(v("clock.cost_ewma")), 5, 1e-9);
  assert.equal(v("clock.samples"), 1);
  approx(Number(v("clock.interval")), budget60 - 5);
  approx(Number(v("clock.fps")), 60);
  approx(Number(interval), budget60 - 5);
});

test("clock.fps is an observable cel — a formula referencing it tracks the governor", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["scheduler"]);
  const setCel = resolveFn(state, "setCel"), runCycle = resolveFn(state, "runCycle");
  // a stats observer: one line, referencing clock.fps (the twoCels headline — a
  // 2nd consumer of the governor is free). (+ x 0) forces a numeric passthrough
  // via a confirmed builtin while wiring the clock.fps dependency.
  await setCel(state, "readout", { celType: "FormulaCel", f: "(+ clock.fps 0)", metadata: { segment: "user" } });
  await precomputeOptional(state);
  await runCycle(state);
  assert.ok(Number(state.cels.get("readout").v) >= 60, "observer starts at the seeded 60fps");
  // overload the device → governor drops fps → the readout follows on the next cycle
  await resolveFn(state, "clock.tick")(state, 50); // ~20fps sustainable
  await runCycle(state);
  assert.ok(Number(state.cels.get("readout").v) < 60, "the observer tracked the dropped rate");
});
