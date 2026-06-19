import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// coordinate-convergence steps 2+3 — named ranges and cross-sheet refs
// in the infix language, riding the kernel's range machinery.

const v = (state, key) => state.cels.get(key)?.v;
const seedUser = (state, key, spec) =>
  resolveFn(state, "setCel")(state, key, { ...spec, metadata: { segment: "user", ...spec.metadata } });
const genesisFlush = async (state) => {
  await resolveFn(state, "drain")(state, "genesis.commit");
  await resolveFn(state, "genesis.drain")([], state);
};

const bootTwoGrids = async () => {
  const state = createInitialState();
  await seedUser(state, "makerG", { celType: "FormulaCel", f: '(cels 3 2 "g")' });
  await seedUser(state, "makerH", { celType: "FormulaCel", f: '(cels 2 2 "h")' });
  await resolveFn(state, "runCycle")(state);
  await genesisFlush(state);
  const set = resolveFn(state, "setValue");
  await set(state, "g.A1", 1); await set(state, "g.A2", 2); await set(state, "g.A3", 3);
  await set(state, "h.A1", 10); await set(state, "h.B1", 20);
  return state;
};

test("cross-sheet ref: =g!A1 * 2 from another segment's cell", async () => {
  const state = await bootTwoGrids();
  await seedUser(state, "reader", { celType: "FormulaCel", f: "=g!A1 * 2", metadata: { parser: "infix" } });
  await resolveFn(state, "runCycle")(state);
  assert.equal(v(state, "reader"), 2);
  // and it tracks edits across the boundary
  await resolveFn(state, "setValue")(state, "g.A1", 7);
  assert.equal(v(state, "reader"), 14, "cross-segment edge drives the cascade");
});

test("cross-sheet range: =SUM(g!A1:A3) + h!B1", async () => {
  const state = await bootTwoGrids();
  await seedUser(state, "totals", { celType: "FormulaCel", f: "=SUM(g!A1:A3) + h!B1", metadata: { parser: "infix" } });
  await resolveFn(state, "runCycle")(state);
  assert.equal(v(state, "totals"), 26, "6 + 20");
  await resolveFn(state, "setValue")(state, "g.A3", 30);
  assert.equal(v(state, "totals"), 53, "range member edit refires");
});

test("named range: =SUM(Expenses) resolves a RangeCel's members", async () => {
  const state = await bootTwoGrids();
  await seedUser(state, "Expenses", { celType: "RangeCel", v: "g!A1:A3" });
  await seedUser(state, "total", { celType: "FormulaCel", f: "=SUM(Expenses)", metadata: { parser: "infix" } });
  await resolveFn(state, "runCycle")(state);
  assert.equal(v(state, "total"), 6);
  // member edit refires (member keys are real edges)
  await resolveFn(state, "setValue")(state, "g.A2", 200);
  assert.equal(v(state, "total"), 204);
  // the RangeCel itself is a dependency: inputMap carries the definition edge
  const im = state.cels.get("total").metadata.inputMap;
  assert.ok(Object.values(im).includes("Expenses"), "definition edge wired");
});

test("redefining the named range recompiles consumers (defGeneration)", async () => {
  const state = await bootTwoGrids();
  await seedUser(state, "Expenses", { celType: "RangeCel", v: "g!A1:A2" });
  await seedUser(state, "total", { celType: "FormulaCel", f: "=SUM(Expenses)", metadata: { parser: "infix" } });
  await resolveFn(state, "runCycle")(state);
  assert.equal(v(state, "total"), 3, "A1+A2");
  await seedUser(state, "Expenses", { celType: "RangeCel", v: "g!A1:A3" });
  await resolveFn(state, "runCycle")(state);
  assert.equal(v(state, "total"), 6, "consumer recompiled against the new range");
});

test("a bare symbol that is not a range reads the cel's value", async () => {
  const state = createInitialState();
  await seedUser(state, "rate", { celType: "ValueCel", v: 3 });
  await seedUser(state, "calc", { celType: "FormulaCel", f: "=rate * 5", metadata: { parser: "infix" } });
  await resolveFn(state, "runCycle")(state);
  assert.equal(v(state, "calc"), 15);
});

// ── single-quote string delimiter in infix (one level of nesting, no escaping) ─
test("infix: ' delimits a string — double-quotes inside need no escaping", async () => {
  const state = createInitialState();
  await resolveFn(state, "setCel")(state, "s", { celType: "FormulaCel", f: `='he said "hi"'`, metadata: { key: "s", segment: "user", parser: "infix" } });
  await resolveFn(state, "runCycle")(state);
  assert.equal(state.cels.get("s")?.v, 'he said "hi"');
});

test("infix: existing \\\" escaping in \"…\" still works (backward compatible)", async () => {
  const state = createInitialState();
  await resolveFn(state, "setCel")(state, "s", { celType: "FormulaCel", f: `="he said \\"hi\\""`, metadata: { key: "s", segment: "user", parser: "infix" } });
  await resolveFn(state, "runCycle")(state);
  assert.equal(state.cels.get("s")?.v, 'he said "hi"');
});
