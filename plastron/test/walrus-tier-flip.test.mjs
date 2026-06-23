import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, buildSheet, isCelError } from "../dist/index.js";

// `:=` tier flip: a cell defined as `x.newfunc := LAMBDA(…)` (a verb, FormulaCel)
// is re-typed to `x.newfunc := 1` (a constant). The minted cel is REPLACED with
// a ValueCel; lineage metadata is preserved but the parser/kind is dropped; and
// downstream callers do not vanish — they trap "not a function" until redefined.

const v  = (s, k) => s.cels.get(k)?.v;
const cel = (s, k) => s.cels.get(k);
const flushDefn = (s) => resolveFn(s, "drain")(s, "defn.commit");
const editAndSettle = async (s, key, src) => {
  await resolveFn(s, "setValue")(s, key, src);
  await resolveFn(s, "runCycle")(s);
  await flushDefn(s);
};

test(":= function→constant flip: cel becomes a ValueCel; callers trap, don't disappear", async () => {
  const state = createInitialState();
  const seg = buildSheet({ rows: 6, cols: 4, cells: {
    A1: "10", A2: "20", A3: "30",
    C1: "x.newfunc := LAMBDA(n, SUM(n) + 1)",         // minted UPPER as x.NEWFUNC
    B1: "=x.NEWFUNC(A1:A3)",
  }});
  await resolveFn(state, "hydrate")(state, [seg], [seg]);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  await flushDefn(state);

  // baseline: a verb (FormulaCel) callers can use.
  assert.equal(cel(state, "x.NEWFUNC").celType, "FormulaCel");
  assert.equal(typeof v(state, "x.NEWFUNC"), "function");
  assert.equal(v(state, "sheet.B1"), 61);

  // ── flip to a constant ──────────────────────────────────────────────
  await editAndSettle(state, "sheet.C1", "x.newfunc := 1");

  const flipped = cel(state, "x.NEWFUNC");
  assert.equal(flipped.celType, "ValueCel", "the new cel IS a ValueCel");
  assert.equal(flipped.v, 1, "its value is the constant");
  assert.equal(flipped.metadata.parser, undefined, "the infix parser tag is gone");
  // lineage survives the flip — it's still owned by the same := cell.
  assert.equal(flipped.metadata.definedBy, "sheet.C1", "provenance preserved");
  assert.equal(flipped.metadata.segment, "x");
  assert.equal(flipped.metadata.name, "NEWFUNC");

  // the caller did NOT disappear — it's still there, now trapping.
  assert.ok(state.cels.has("sheet.B1"), "caller cel still exists");
  assert.ok(isCelError(v(state, "sheet.B1")), "calling a number traps as a CelError");
  assert.match(v(state, "sheet.B1").message, /not a function/, "the trap says why");

  // ── flip back to a verb → the caller recovers ───────────────────────
  await editAndSettle(state, "sheet.C1", "x.newfunc := LAMBDA(n, SUM(n) + 5)");
  assert.equal(cel(state, "x.NEWFUNC").celType, "FormulaCel", "back to a FormulaCel");
  assert.equal(v(state, "sheet.B1"), 65, "caller recovers: 60 + 5");
});
