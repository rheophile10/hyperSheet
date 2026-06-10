// ============================================================================
// scale/lib.mjs — shared bench plumbing for the scale suite.
//
// Drives the plastron kernel through its PUBLIC api only
// (createInitialState / hydrate / precomputeOptional / runCycle /
//  setValue / setCelBatch / getCel). It MEASURES the kernel — it does
// not patch it. The kernel must be built first: `cd ../../plastron &&
// bun run build` (these import from ../../plastron/dist).
// ============================================================================

import {
  createInitialState,
  precomputeOptional,
  resolveFn,
} from "../../plastron/dist/index.js";

export { createInitialState, precomputeOptional, resolveFn };

// A manifest that declares `builtins` as a dependency so the arithmetic
// builtins (+ - * / SUM…) the formulas reference don't trip the
// segment-dependency-drift warning precompute emits.
export const manifestFor = (name) => ({
  name,
  version: "0.0.1",
  description: "scale bench",
  dependencies: ["builtins"],
});

// Hydrate one segment of raw cels, precompute, settle. Returns the
// resolved fn handles the bench tick paths reuse.
export const bootSegment = async (name, cels) => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{ name, cels }], [manifestFor(name)]);
  await precomputeOptional(state);
  const runCycle = resolveFn(state, "runCycle");
  await runCycle(state);
  return {
    state,
    runCycle,
    setValue: resolveFn(state, "setValue"),
    setValueBatch: resolveFn(state, "setValueBatch"),
    setCel: resolveFn(state, "setCel"),
    setCelBatch: resolveFn(state, "setCelBatch"),
    getCel: resolveFn(state, "getCel"),
    precomputeOptional: () => precomputeOptional(state),
  };
};

export const valueCel = (key, segment, v) => ({
  key,
  celType: "ValueCel",
  metadata: { key, segment },
  v,
});

export const formulaCel = (key, segment, f) => ({
  key,
  celType: "FormulaCel",
  metadata: { key, segment, parser: "f" },
  f,
});

// Deterministic small PRNG so edit-storm picks are reproducible across runs.
export const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ── timing ──────────────────────────────────────────────────────────────────

export const stats = (samples) => {
  const xs = [...samples].sort((a, b) => a - b);
  const n = xs.length;
  const q = (p) => xs[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  const sum = xs.reduce((s, x) => s + x, 0);
  return {
    n,
    min: xs[0],
    p50: q(0.5),
    p99: q(0.99),
    max: xs[n - 1],
    mean: sum / n,
  };
};

export const ms = (x) => (x).toFixed(3);

// Run `fn` once, return elapsed ms (high-resolution). Awaits async fns.
export const timed = async (fn) => {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
};

// peak RSS so far, in MB.
export const rssMB = () => process.memoryUsage().rss / (1024 * 1024);
