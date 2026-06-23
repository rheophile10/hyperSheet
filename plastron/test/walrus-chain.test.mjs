import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, buildSheet } from "../dist/index.js";

// 5-lambda derivation chain. A base LockedLambdaCel (base.double) is the root;
// five `:=` verbs are derived off it, each calling the previous. The furthest-
// out verb (chain.f5) is applied to a ValueCel; changing that value cascades
// the update through all five. The inputMap edges f5→f4→…→base.double ARE the
// derivation lineage (the same edges the wiki renders).

const v   = (s, k) => s.cels.get(k)?.v;
const md  = (s, k) => s.cels.get(k)?.metadata;
const ins = (s, k) => Object.keys((md(s, k)?.inputMap) ?? {});
const flushDefn = (s) => resolveFn(s, "drain")(s, "defn.commit");

test("5 verbs derived off one LockedLambdaCel; change the ValueCel → cascade", async () => {
  const state = createInitialState();
  const seg = buildSheet({ rows: 10, cols: 4, cells: {
    A1: "10",                                          // the ValueCel
    // verbs mint UPPER (chain.F1…); bodies reference the UPPER verb + lowercase native.
    C1: "chain.f1 := LAMBDA(n, base.double(n) + 1)",   // derives off the locked base
    C2: "chain.f2 := LAMBDA(n, chain.F1(n) + 1)",
    C3: "chain.f3 := LAMBDA(n, chain.F2(n) + 1)",
    C4: "chain.f4 := LAMBDA(n, chain.F3(n) + 1)",
    C5: "chain.f5 := LAMBDA(n, chain.F4(n) + 1)",
    B1: "=chain.F5(A1)",                               // furthest-out verb, on the value
  }});
  await resolveFn(state, "hydrate")(state, [seg], [seg]);

  // the root: a native LockedLambdaCel.
  await resolveFn(state, "setCel")(state, "base.double", {
    celType: "LockedLambdaCel", fn: (n) => Number(n) * 2,
    metadata: { key: "base.double", segment: "base", name: "double", kind: "native" },
  });

  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  await flushDefn(state);

  // all five verbs minted as callable FormulaCels (UPPER keys).
  for (const k of ["chain.F1", "chain.F2", "chain.F3", "chain.F4", "chain.F5"]) {
    assert.equal(s_celType(state, k), "FormulaCel", `${k} is a FormulaCel`);
    assert.equal(typeof v(state, k), "function", `${k} is callable`);
  }

  // base.double(10)=20, then +1 five times → 25.
  assert.equal(v(state, "sheet.B1"), 25, "F5(10) = double(10) + 5 = 25");

  // LINEAGE: the derivation chain is wired as inputMap edges.
  assert.ok(ins(state, "chain.F5").includes("chain.F4"), "F5 derives from F4");
  assert.ok(ins(state, "chain.F2").includes("chain.F1"), "F2 derives from F1");
  assert.ok(ins(state, "chain.F1").includes("base.double"), "F1 derives from the locked base");

  // ── change the ValueCel → update cascades through all five ───────────
  await resolveFn(state, "setValue")(state, "sheet.A1", "100");
  await resolveFn(state, "runCycle")(state);
  assert.equal(v(state, "sheet.B1"), 205, "f5(100) = 200 + 5 = 205");

  // ── bonus: redefine the ROOT LockedLambdaCel → the whole chain tracks it ─
  await resolveFn(state, "setCel")(state, "base.double", {
    celType: "LockedLambdaCel", fn: (n) => Number(n) * 3,
    metadata: { key: "base.double", segment: "base", name: "double", kind: "native" },
  });
  await resolveFn(state, "runCycle")(state);
  assert.equal(v(state, "sheet.B1"), 305, "after root redefine (×3): f5(100) = 300 + 5 = 305");
});

function s_celType(s, k) { return s.cels.get(k)?.celType; }
