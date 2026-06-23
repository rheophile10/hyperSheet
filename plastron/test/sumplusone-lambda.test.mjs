import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, buildSheet } from "../dist/index.js";

// Proof: a NAMED cel holding an infix LAMBDA acts as a reusable verb
// (`=sumplusone(A1:A3)` ≡ SUM(A1:A3)+1), and redefining that LAMBDA later
// propagates to every caller through the normal inputMap/runCycle path.

test("LAMBDA-as-named-cel is a callable verb, and redefining it updates callers", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  const sheetSeg = buildSheet({
    rows: 8, cols: 4,
    cells: { A1: "10", A2: "20", A3: "30", B1: "=sumplusone(A1:A3)" },
  });
  // B1 (in sheet-grid) references the verb in the `user` segment — declare it.
  sheetSeg.dependencies = [...sheetSeg.dependencies, "user"];
  // The verb: a NAMED FormulaCel whose value is an infix LAMBDA.
  const verbSeg = {
    name: "user", version: "0.0.1", dependencies: ["sheet"],
    cels: [{
      key: "sumplusone", celType: "FormulaCel",
      metadata: { key: "sumplusone", segment: "user", parser: "infix" },
      f: "=LAMBDA(x, SUM(x) + 1)",
    }],
  };

  await hydrate(state, [sheetSeg, verbSeg], [sheetSeg, verbSeg]);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  const v = (k) => state.cels.get(k)?.v;

  // 1) The verb is callable by name.
  assert.equal(typeof v("sumplusone"), "function", "sumplusone's value is a callable");
  assert.equal(v("sheet.B1"), 61, "SUM(10,20,30)+1 = 61");

  const setValue = resolveFn(state, "setValue");
  const runCycle = resolveFn(state, "runCycle");

  // 2) REDEFINE the verb body (+1 → +2). Callers must track the change.
  await setValue(state, "sumplusone", "=LAMBDA(x, SUM(x) + 2)");
  await runCycle(state);
  assert.equal(v("sheet.B1"), 62, "after redefine to +2: 60 + 2 = 62");

  // …and a second redefine, to show it is not a one-off.
  await setValue(state, "sumplusone", "=LAMBDA(x, SUM(x) + 100)");
  await runCycle(state);
  assert.equal(v("sheet.B1"), 160, "after redefine to +100: 60 + 100 = 160");

  // 3) And it still tracks DATA changes in the referenced range.
  await setValue(state, "sheet.A1", "5");
  await runCycle(state);
  assert.equal(v("sheet.B1"), 155, "5+20+30 + 100 = 155");
});
