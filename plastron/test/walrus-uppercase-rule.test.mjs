import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, buildSheet, isCelError } from "../dist/index.js";

// `:=` enforces UPPERCASE verb names by construction: the name (tail after the
// last dot) is canonicalized to uppercase, so a lower-cased reference can never
// resolve. `func := …` is reachable only as FUNC; `func` fails.

const v = (s, k) => s.cels.get(k)?.v;
const flushDefn = (s) => resolveFn(s, "drain")(s, "defn.commit");

test("func := LAMBDA(...) mints FUNC; =func(...) fails, =FUNC(...) works", async () => {
  const state = createInitialState();
  const seg = buildSheet({ rows: 6, cols: 4, cells: {
    A1: "10", A2: "20",
    C1: "lib.func := LAMBDA(n, SUM(n) + 1)",   // lowercase verb name on the LEFT
    B1: "=lib.func(A1:A2)",                    // lowercase reference → must FAIL
    B2: "=lib.FUNC(A1:A2)",                    // UPPER reference     → must WORK
  }});
  await resolveFn(state, "hydrate")(state, [seg], [seg]);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  await flushDefn(state);
  await resolveFn(state, "runCycle")(state);

  // minted UNDER the uppercase key; the lowercase key does not exist.
  assert.ok(state.cels.has("lib.FUNC"), "minted as lib.FUNC");
  assert.ok(!state.cels.has("lib.func"), "lib.func was never created");
  assert.equal(state.cels.get("lib.FUNC").metadata.name, "FUNC");

  // the UPPER caller works; the lowercase caller traps (undefined symbol).
  assert.equal(v(state, "sheet.B2"), 31, "=lib.FUNC(A1:A2) = 30 + 1");
  assert.ok(isCelError(v(state, "sheet.B1")), "=lib.func(...) fails — no such cel");
});
