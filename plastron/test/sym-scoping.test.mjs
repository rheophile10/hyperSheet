import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, buildSheet } from "../dist/index.js";

// Segment-local-first symbol scoping. A bare NAMED symbol / user-defined call
// name in a grid cell resolves to a live `<seg>.<name>` sibling before falling
// back to a global name. (`seg` is derived from the cel KEY — buildSheet keys
// cells `sheet.<A1>` — so the scope is "sheet".) Bare A1 refs/ranges already
// scope via qualifyRefs; this covers `sym` + user-`call`. Guards: LET/LAMBDA
// bound names are NOT scoped, and builtins (SUM, …) are never scoped.
//
// NOTE on ordering: scoping resolves a name iff the `<seg>.<name>` cel exists at
// COMPILE time. That's always true on the load path (hydrate inflates every cel
// before any compile). For a runtime `:=` mint, the consumer must (re)compile
// AFTER the mint — so these tests define first, then set the consumer.

const v = (s, k) => s.cels.get(k)?.v;
const md = (s, k) => s.cels.get(k)?.metadata;
const flushDefn = (s) => resolveFn(s, "drain")(s, "defn.commit");

const boot = async (cells) => {
  const state = createInitialState();
  const seg = buildSheet({ rows: 8, cols: 4, cells });
  await resolveFn(state, "hydrate")(state, [seg], [seg]);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  await flushDefn(state);            // commit the `:=` mints
  return state;
};

// Set a consumer's formula AFTER the producers exist, then settle.
const use = async (state, key, formula) => {
  await resolveFn(state, "setValue")(state, key, formula);
  await resolveFn(state, "runCycle")(state);
};

test("bare named symbol resolves segment-local-first, and wires the dep", async () => {
  const state = await boot({ C1: "sheet.RATE := 0.1", B1: "=0" });
  await use(state, "sheet.B1", "=RATE");
  assert.equal(v(state, "sheet.B1"), 0.1, "bare RATE resolved to sheet.RATE");
  const inputs = Object.keys(md(state, "sheet.B1").inputMap ?? {});
  assert.ok(inputs.includes("sheet.RATE"), `dep wired to sheet.RATE (got ${inputs})`);
});

test("bare user-defined call name resolves segment-local-first", async () => {
  const state = await boot({ A1: "21", C1: "sheet.DOUBLE := LAMBDA(x, x * 2)", B1: "=0" });
  await use(state, "sheet.B1", "=DOUBLE(A1)");
  assert.equal(v(state, "sheet.B1"), 42, "bare DOUBLE(A1) = 21 * 2");
});

test("LET-bound name is NOT scoped to a same-named local cel", async () => {
  const state = await boot({ A1: "10", C1: "sheet.X := 99", B1: "=0" });
  await use(state, "sheet.B1", "=LET(X, A1 * 2, X + 1)");
  // X is the LET binding (A1*2 = 20), not sheet.X (99): 20 + 1 = 21.
  assert.equal(v(state, "sheet.B1"), 21, "LET param shadows the cel");
});

test("builtins are never scoped, even when a same-named local cel exists", async () => {
  const state = await boot({ A1: "21", A2: "10", A3: "20", C1: "sheet.SUM := 0", B1: "=0" });
  await use(state, "sheet.B1", "=SUM(A1:A3)");
  assert.equal(v(state, "sheet.B1"), 51, "builtin SUM used: 21 + 10 + 20");
});

test("a bare name with no local cel falls back (stays unresolved, no crash)", async () => {
  const state = await boot({ B1: "=0" });
  await use(state, "sheet.B1", "=NOPE");
  assert.equal(v(state, "sheet.B1"), undefined, "unknown bare name → undefined, not scoped");
});
