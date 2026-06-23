import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, buildSheet } from "../dist/index.js";

// `:=` definition operator (value tier). A cell `seg.name := RHS` is a binder:
// it mints a named cel keyed `seg.name`, stamped with lineage
// (definedBy = the binder cell, origin, segment, name). RHS picks the tier —
// a LAMBDA/expression → FormulaCel (reactive verb), a literal → ValueCel.

const v = (s, k) => s.cels.get(k)?.v;
const md = (s, k) => s.cels.get(k)?.metadata;
const flushDefn = (s) => resolveFn(s, "drain")(s, "defn.commit");

const boot = async (cells) => {
  const state = createInitialState();
  const seg = buildSheet({ rows: 8, cols: 4, cells });
  await resolveFn(state, "hydrate")(state, [seg], [seg]);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  await flushDefn(state);
  return state;
};

test(":= mints a value-tier verb + constant, with lineage, and tracks redefinition", async () => {
  const state = await boot({
    A1: "10", A2: "20", A3: "30",
    C1: "math.SUMPLUSONE := LAMBDA(x, SUM(x) + 1)",   // verb binder  → FormulaCel
    C2: "app.TAX := 0.1",                             // constant     → ValueCel
    B1: "=math.SUMPLUSONE(A1:A3)",                    // caller of the verb (UPPER)
    B2: "=A1 * app.TAX",                              // caller of the constant
  });

  // 1) the verb cel exists, is callable, and is a FormulaCel (value tier).
  const verb = state.cels.get("math.SUMPLUSONE");
  assert.ok(verb, "math.SUMPLUSONE was minted");
  assert.equal(verb.celType, "FormulaCel", "value tier → FormulaCel");
  assert.equal(typeof verb.v, "function", "its value is a callable");
  assert.equal(v(state, "sheet.B1"), 61, "=math.SUMPLUSONE(A1:A3) = 60 + 1");

  // 2) the constant cel is a ValueCel.
  const k = state.cels.get("app.TAX");
  assert.equal(k.celType, "ValueCel");
  assert.equal(k.v, 0.1);
  assert.equal(v(state, "sheet.B2"), 1, "=A1 * app.TAX = 10 * 0.1");

  // 3) LINEAGE metadata is stamped on the minted cels.
  assert.equal(md(state, "math.SUMPLUSONE").definedBy, "sheet.C1", "provenance: the := cell");
  assert.equal(md(state, "math.SUMPLUSONE").origin,    "sheet.C1");
  assert.equal(md(state, "math.SUMPLUSONE").segment,   "math", "segment from the dotted prefix");
  assert.equal(md(state, "math.SUMPLUSONE").name,      "SUMPLUSONE", "name from the tail (UPPER)");

  // 4) redefine by editing the binder cell — callers track it.
  await resolveFn(state, "setValue")(state, "sheet.C1", "math.SUMPLUSONE := LAMBDA(x, SUM(x) + 2)");
  await resolveFn(state, "runCycle")(state);
  await flushDefn(state);
  assert.equal(v(state, "sheet.B1"), 62, "after := redefine to +2: 60 + 2 = 62");
});
