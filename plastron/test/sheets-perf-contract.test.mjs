import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, buildSheet } from "../dist/index.js";

// sheets-perf-contract — COUNTER-based regression gates (sheets-bench-
// harness.md). Wall-clock never gates CI; these pin the structural
// properties the perf story rests on. Pinned constants are updated
// DELIBERATELY (with a comment) when granularity work lands.

const M = { rows: 40, cols: 26 };
const cellsFor = ({ rows }) => {
  const cells = {};
  for (let r = 1; r <= rows; r++) {
    cells[`A${r}`] = String(r);
    cells[`C${r}`] = r === 1 ? "=A1+1" : `=C${r - 1}+A${r}`;
  }
  cells.D1 = `=SUM(A1:A${rows})`;
  return cells;
};

const boot = async () => {
  const state = createInitialState();
  const seg = buildSheet({ ...M, cells: cellsFor(M) });
  await resolveFn(state, "hydrate")(state, [seg], [seg]);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  return state;
};

const withCounters = () => (globalThis.__plastronCounters = {});

test("no-op writes evaluate ONLY direct dependents and commit nothing", async () => {
  const state = await boot();
  const set = resolveFn(state, "setValue");
  await set(state, "sheet.A1", 42);
  const c = withCounters();
  await set(state, "sheet.A1", 42);
  // direct dependents of A1: C1 (chain head) + D1 (SUM) = 2 evaluations, both suppressed
  assert.equal(c.fires, 2, "only direct dependents evaluate on a no-op");
  assert.equal(c.suppressed, c.fires, "every no-op evaluation is suppressed (kept-ref)");
  delete globalThis.__plastronCounters;
});

test("a single edit's evaluation count is bounded by its true downstream", async () => {
  const state = await boot();
  const set = resolveFn(state, "setValue");
  const c = withCounters();
  await set(state, "sheet.A1", 7);
  // downstream of A1: C1..C40 chain + D1 = 41. Pinned with slack for
  // future structural cels; tighten/loosen DELIBERATELY only.
  assert.ok(c.fires <= 45, `fires ${c.fires} exceeds downstream bound 45`);
  delete globalThis.__plastronCounters;
});

test("a formula commit runs precompute exactly once", async () => {
  const state = await boot();
  const commit = resolveFn(state, "sheet.commit-cell");
  await commit(state, { addr: "B2", input: "=A1*2" }); // warm the cel into place
  const c = withCounters();
  await commit(state, { addr: "B2", input: "=A1*3" });
  assert.equal(c.precomputeCount, 1, "one topo change = one precompute");
  delete globalThis.__plastronCounters;
});

test("suppression keeps the OLD REFERENCE (memoSafe contract)", async () => {
  const state = await boot();
  const set = resolveFn(state, "setValue");
  await set(state, "sheet.A1", 5);
  const before = state.cels.get("sheet.D1").v;
  await set(state, "sheet.A1", 5); // no-op
  assert.ok(Object.is(state.cels.get("sheet.D1").v, before), "no-op recompute preserved value identity");
});
