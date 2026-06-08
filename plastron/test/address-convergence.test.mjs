import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseA1 } from "../dist/index.js";
import { parseRef, addrFrom, indexToCol, colToIndex, expandRange } from "../dist/甲骨坑/library/sheet/utils/address.js";

// address convergence (coordinate-convergence.md step 1) — ONE notation
// authority. The sheet's parseRef delegates to the kernel's parseA1;
// this property suite pins the bijection between the sheet FORMATTER
// (addrFrom/indexToCol, 0-based) and the kernel PARSER (1-based), so
// the conventions can never drift apart again.

test("bijection: addrFrom → kernel parseA1 → parseRef round-trips over a fuzzed corpus", () => {
  let x = 48271;
  const rnd = (n) => { x = (x * 16807) % 2147483647; return x % n; };
  for (let i = 0; i < 2000; i++) {
    const col = rnd(2000);   // through AA, ABC… territory
    const row = rnd(100000);
    const addr = addrFrom(col, row);
    // kernel parse (1-based [row, col])
    const a1 = parseA1(addr);
    assert.ok(a1, `kernel parses ${addr}`);
    assert.equal(a1[0], row + 1, `row 1-based for ${addr}`);
    assert.equal(a1[1], col + 1, `col 1-based for ${addr}`);
    // sheet parse (0-based {col,row}) — the ONE conversion site
    const ref = parseRef(addr);
    assert.deepEqual(ref, { col, row }, `sheet round-trip for ${addr}`);
  }
});

test("column letters: formatter ↔ kernel parser at the bijective base-26 edges", () => {
  for (const [letters, idx] of [["A", 0], ["Z", 25], ["AA", 26], ["AZ", 51], ["BA", 52], ["ZZ", 701], ["AAA", 702]]) {
    assert.equal(indexToCol(idx), letters);
    assert.equal(colToIndex(letters), idx, `colToIndex(${letters}) delegates to the kernel`);
    assert.equal(parseA1(`${letters}1`)?.[1], idx + 1);
  }
});

test("parseRef rejects what the kernel rejects", () => {
  for (const bad of ["", "1A", "A0", "A", "7", "A1:B2", "sheet.A1"]) {
    assert.equal(parseRef(bad), null, `"${bad}" rejected`);
  }
  // case-insensitive like the kernel
  assert.deepEqual(parseRef("b3"), { col: 1, row: 2 });
});

test("expandRange semantics unchanged (corner normalization, row-major)", () => {
  assert.deepEqual(expandRange("A1:B2"), ["A1", "B1", "A2", "B2"]);
  assert.deepEqual(expandRange("B2:A1"), ["A1", "B1", "A2", "B2"], "corners normalize");
  assert.deepEqual(expandRange("C3"), ["C3"]);
  assert.deepEqual(expandRange("nope"), []);
});
