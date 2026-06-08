// ============================================================================
// counters — dev-only instrumentation (sheets-bench-harness.md).
//
// A bench/test run sets `globalThis.__plastronCounters = {}` and reads
// the fields after the phase; production pays ONE falsy check per site.
// House rule: no counter, no perf claim — these are the evidence layer
// behind every bench number and every counter-based regression gate.
//
// Sites (keep this list current):
//   fires            — fireCel invocations that reached an evaluator
//   suppressed       — finishFireSync kept the old reference (isChanged false)
//   precomputeCount  — full precompute() runs
//   precomputeMs     — cumulative wall ms inside precompute()
//   diffVisits       — diffVNodes node comparisons (plastron-dom)
//   templateEvalMs   — cumulative ms in html-template buildEvaluate bodies
// ============================================================================

export interface PlastronCounters {
  fires?: number;
  suppressed?: number;
  precomputeCount?: number;
  precomputeMs?: number;
  diffVisits?: number;
  templateEvalMs?: number;
}

/** The live counters object, or undefined when instrumentation is off. */
export const counters = (): PlastronCounters | undefined =>
  (globalThis as { __plastronCounters?: PlastronCounters }).__plastronCounters;

export const bump = (k: keyof PlastronCounters, by = 1): void => {
  const c = counters();
  if (c) c[k] = (c[k] ?? 0) + by;
};
