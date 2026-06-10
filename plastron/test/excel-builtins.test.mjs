import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, buildSheet, isCelError } from "../dist/index.js";

// excel-builtins — the v1 Excel function set added as INLINE builtins to the
// infix parser (src/甲骨坑/library/sheet/utils/infix.ts). Each function gets
// a correct-result case AND (where applicable) an error case proving the
// Excel sentinel maps onto a CelError trap (na / div0 / ref / value / num).
//
// Driven through the real public surface (buildSheet → hydrate → runCycle):
// a formula's value lands in cel.v; a builtin that can't produce a value
// lands a CelError there, detectable via isCelError + its `trap`.
// See docs/1-design/1-under-consideration/excel-formulas-segment.md.

const bootSheet = async (cells) => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  // generous grid so every fixture address exists
  const seg = buildSheet({ rows: 12, cols: 8, cells });
  await hydrate(state, [seg], [seg]);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  return state;
};
const v = (state, key) => state.cels.get(key)?.v;
const trapOf = (state, key) => { const x = v(state, key); return isCelError(x) ? x.trap : undefined; };

// Quote helper for embedding a string literal in a formula source.
const q = (s) => `"${s}"`;

// ── math / rounding ──────────────────────────────────────────────────────────

test("math/rounding: ROUND, ROUNDUP, ROUNDDOWN, ABS, INT, MOD", async () => {
  const state = await bootSheet({
    A1: "=ROUND(3.14159, 2)",
    A2: "=ROUNDUP(3.141, 2)",
    A3: "=ROUNDDOWN(3.149, 2)",
    A4: "=ABS(-5)",
    A5: "=INT(3.9)",
    A6: "=MOD(7, 3)",
    A7: "=MOD(-7, 3)",   // Excel takes the divisor's sign → 2
    A8: "=MOD(5, 0)",    // #DIV/0!
  });
  assert.equal(v(state, "sheet.A1"), 3.14);
  assert.equal(v(state, "sheet.A2"), 3.15);
  assert.equal(v(state, "sheet.A3"), 3.14);
  assert.equal(v(state, "sheet.A4"), 5);
  assert.equal(v(state, "sheet.A5"), 3);
  assert.equal(v(state, "sheet.A6"), 1);
  assert.equal(v(state, "sheet.A7"), 2);
  assert.equal(trapOf(state, "sheet.A8"), "div0");
});

// ── predicate aggregation ────────────────────────────────────────────────────

test("aggregation: COUNT, COUNTA, COUNTIF, SUMIF, AVERAGEIF", async () => {
  const state = await bootSheet({
    A1: "1", A2: "5", A3: "5", A4: "9",
    B1: "10", B2: "20", B3: "30", B4: "40",
    C1: "apple", C2: "apricot", C3: "banana",
    D1: "=COUNT(A1:A4)",
    D2: "=COUNTA(C1:C4)",            // C4 empty → 3
    D3: "=COUNTIF(A1:A4, \">4\")",   // 5,5,9 → 3
    D4: "=SUMIF(A1:A4, \">4\")",     // 5+5+9 → 19
    D5: "=SUMIF(A1:A4, \">4\", B1:B4)", // aligned sum-range: B2+B3+B4 → 90
    D6: "=AVERAGEIF(A1:A4, \">4\")", // (5+5+9)/3
    D7: "=COUNTIF(C1:C3, \"ap*\")",  // apple, apricot → 2
    D8: "=AVERAGEIF(A1:A4, \">100\")", // no match → #DIV/0!
  });
  assert.equal(v(state, "sheet.D1"), 4);
  assert.equal(v(state, "sheet.D2"), 3);
  assert.equal(v(state, "sheet.D3"), 3);
  assert.equal(v(state, "sheet.D4"), 19);
  assert.equal(v(state, "sheet.D5"), 90);
  assert.ok(Math.abs(v(state, "sheet.D6") - 6.3333) < 0.001);
  assert.equal(v(state, "sheet.D7"), 2);
  assert.equal(trapOf(state, "sheet.D8"), "div0");
});

// ── lookup / reference ───────────────────────────────────────────────────────

test("lookup: VLOOKUP, HLOOKUP, INDEX, MATCH (1-based) + #N/A / #REF!", async () => {
  // 3×2 table at A1:B3:  a|10  b|20  c|30
  const state = await bootSheet({
    A1: "a", B1: "10",
    A2: "b", B2: "20",
    A3: "c", B3: "30",
    // HLOOKUP table at D1:F2:  x y z / 1 2 3
    D1: "x", E1: "y", F1: "z",
    D2: "1", E2: "2", F2: "3",
    G1: "=VLOOKUP(\"b\", A1:B3, 2)",        // exact-ish (approx default on sorted) → 20
    G2: "=VLOOKUP(\"b\", A1:B3, 2, FALSE)", // exact → 20
    G3: "=VLOOKUP(\"zzz\", A1:B3, 2, FALSE)", // no match → #N/A
    G4: "=VLOOKUP(\"a\", A1:B3, 5)",        // bad col → #REF!
    G5: "=MATCH(\"b\", A1:A3, 0)",          // 1-based → 2
    G6: "=MATCH(\"zzz\", A1:A3, 0)",        // no match → #N/A
    G7: "=INDEX(A1:B3, 2, 2)",              // row2 col2 → 20
    G8: "=INDEX(A1:B3, 9, 1)",              // out of bounds → #REF!
    G9: "=HLOOKUP(\"y\", D1:F2, 2, FALSE)", // col under "y", row2 → 2
    G10: "=HLOOKUP(\"q\", D1:F2, 2, FALSE)",// no match → #N/A
  });
  assert.equal(v(state, "sheet.G1"), 20);
  assert.equal(v(state, "sheet.G2"), 20);
  assert.equal(trapOf(state, "sheet.G3"), "na");
  assert.equal(trapOf(state, "sheet.G4"), "ref");
  assert.equal(v(state, "sheet.G5"), 2);
  assert.equal(trapOf(state, "sheet.G6"), "na");
  assert.equal(v(state, "sheet.G7"), 20);
  assert.equal(trapOf(state, "sheet.G8"), "ref");
  assert.equal(v(state, "sheet.G9"), 2);
  assert.equal(trapOf(state, "sheet.G10"), "na");
});

// ── logical ──────────────────────────────────────────────────────────────────

test("logical: AND, OR, NOT, IFS, IFERROR", async () => {
  const state = await bootSheet({
    A1: "5",
    B1: "=AND(TRUE, A1>0)",          // true
    B2: "=AND(TRUE, A1>10)",         // false
    B3: "=OR(FALSE, A1>0)",          // true
    B4: "=NOT(A1>0)",                // false
    B5: "=IFS(A1>10, \"hi\", TRUE, \"lo\")", // → "lo"
    B6: "=IFS(A1>100, \"hi\")",      // no match → #N/A
    B7: "=IFERROR(1/0, \"fallback\")", // catches div0 → "fallback"
    B8: "=IFERROR(A1, \"x\")",       // A1 fine → 5
    B9: "=IFERROR(VLOOKUP(\"zzz\", A1:A1, 1, FALSE), \"missing\")", // catches #N/A
  });
  assert.equal(v(state, "sheet.B1"), true);
  assert.equal(v(state, "sheet.B2"), false);
  assert.equal(v(state, "sheet.B3"), true);
  assert.equal(v(state, "sheet.B4"), false);
  assert.equal(v(state, "sheet.B5"), "lo");
  assert.equal(trapOf(state, "sheet.B6"), "na");
  assert.equal(v(state, "sheet.B7"), "fallback");
  assert.equal(v(state, "sheet.B8"), 5);
  assert.equal(v(state, "sheet.B9"), "missing");
});

// ── text ─────────────────────────────────────────────────────────────────────

test("text: LEFT, RIGHT, MID, LEN, TRIM, UPPER, LOWER, CONCAT, TEXTJOIN", async () => {
  const state = await bootSheet({
    A1: "plastron",
    B1: "a", B2: "b", B3: "c",
    C1: "=LEFT(A1, 4)",        // "plas"
    C2: "=RIGHT(A1, 4)",       // "tron"
    C3: "=MID(A1, 2, 3)",      // "las"
    C4: "=LEN(A1)",            // 8
    C5: "=TRIM(\"  a   b  \")",// "a b"
    C6: "=UPPER(A1)",          // "PLASTRON"
    C7: "=LOWER(\"ABC\")",     // "abc"
    C8: "=CONCAT(\"a\", B1:B3, \"z\")",       // "aabcz"
    C9: "=TEXTJOIN(\"-\", TRUE, B1:B3)",      // "a-b-c"
    C10: "=MID(A1, 0, 3)",     // start<1 → #VALUE!
    C11: "=LEFT(A1, -1)",      // n<0 → #VALUE!
  });
  assert.equal(v(state, "sheet.C1"), "plas");
  assert.equal(v(state, "sheet.C2"), "tron");
  assert.equal(v(state, "sheet.C3"), "las");
  assert.equal(v(state, "sheet.C4"), 8);
  assert.equal(v(state, "sheet.C5"), "a b");
  assert.equal(v(state, "sheet.C6"), "PLASTRON");
  assert.equal(v(state, "sheet.C7"), "abc");
  assert.equal(v(state, "sheet.C8"), "aabcz");
  assert.equal(v(state, "sheet.C9"), "a-b-c");
  assert.equal(trapOf(state, "sheet.C10"), "value");
  assert.equal(trapOf(state, "sheet.C11"), "value");
});

// ── date (pure literal args; NO wall clock) ──────────────────────────────────

test("date: DATE(y,m,d) → ISO string; bad date → #NUM!; TODAY() stays #NAME?", async () => {
  const state = await bootSheet({
    A1: "=DATE(2026, 6, 10)",   // "2026-06-10"
    A2: "=DATE(2026, 13, 1)",   // month overflow rolls → 2027-01-01
    A3: "=DATE(99999999, 1, 1)",// out-of-range → #NUM!
    A4: "=TODAY()",             // deliberately NOT a builtin → #NAME?
  });
  assert.equal(v(state, "sheet.A1"), "2026-06-10");
  assert.equal(v(state, "sheet.A2"), "2027-01-01");
  assert.equal(trapOf(state, "sheet.A3"), "num");
  // TODAY is intentionally excluded (wall-clock determinism hazard): it
  // falls through the undefined-symbol path and surfaces as a #NAME?-shaped
  // error. This test guards against a future contributor quietly adding a
  // Date.now()-backed TODAY builtin.
  assert.ok(isCelError(v(state, "sheet.A4")), "TODAY() is an error, not a value");
  const a4 = v(state, "sheet.A4");
  assert.ok(/not a function|undefined symbol/i.test(a4.message), "TODAY() → #NAME?-shaped (undefined symbol)");
});

// ── error sentinels + dependency regression ──────────────────────────────────

test("=1/0 traps as a #DIV/0! CelError; undefined =FOO() stays #NAME?-shaped", async () => {
  const state = await bootSheet({
    A1: "=1/0",       // bare division by zero → #DIV/0! (trap: div0)
    A2: "=FOO()",     // undefined symbol → #NAME?-shaped error
    A3: "=10 / (5-5)",// computed zero divisor → also div0
  });
  assert.equal(trapOf(state, "sheet.A1"), "div0", "1/0 → #DIV/0!");
  assert.equal(trapOf(state, "sheet.A3"), "div0", "computed zero divisor → #DIV/0!");
  assert.ok(isCelError(v(state, "sheet.A2")), "FOO() is an undefined-symbol error");
  assert.ok(/not a function|undefined symbol/i.test(v(state, "sheet.A2").message));
});

test("builtins add NO dependency edge: extractDeps(=ROUND(A1,2)) ⊆ {sheet.A1}", async () => {
  // A builtin name must not become a cel dependency; only the cell refs
  // inside its args do. Verified via the live inputMap on the formula cel.
  const state = await bootSheet({ A1: "3.14159", B1: "=ROUND(A1, 2)" });
  assert.equal(v(state, "sheet.B1"), 3.14);
  const im = state.cels.get("sheet.B1").metadata.inputMap;
  const deps = Object.values(im);
  assert.deepEqual(deps, ["sheet.A1"], "only A1 is a dependency; ROUND adds no edge");

  // And it stays reactive: editing A1 recomputes B1.
  await resolveFn(state, "setValue")(state, "sheet.A1", 2.71828);
  assert.equal(v(state, "sheet.B1"), 2.72);
});
