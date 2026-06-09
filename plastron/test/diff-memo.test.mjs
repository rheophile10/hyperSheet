import { test } from "bun:test";
import assert from "node:assert/strict";
import { diffVNodes } from "../dist/甲骨坑/library/plastron-dom/utils/diff.js";

// The `memo` hint lets a view make plastron-dom's diff O(changed): when two
// keyed/positional vnodes carry matching memo, the diff bails to NOOP WITHOUT a
// deep compare. This is the library-level lever both origin (cells) and the
// krausest entry (rows) opt into by setting `memo` — no app-specific cache.

// An eq that EXPLODES if the diff ever falls through to a deep compare — proves
// the memo path short-circuits before vnodeEquals.
const eqBoom = { vnodeEquals: () => { throw new Error("deep-compared despite matching memo"); }, bindingsEqual: () => { throw new Error("boom"); } };

const td = (memo, label, cls) => ({ type: "el", tag: "td", memo, attrs: { class: cls }, children: [{ type: "text", text: label }] });

test("matching memo → NOOP without a deep compare (=== and shallow-array)", () => {
  // a and b DIFFER (text + class), but matching memo means 'unchanged' → NOOP.
  assert.equal(diffVNodes(td("k1", "OLD", "a"), td("k1", "NEW", "z"), eqBoom).kind, "noop");          // === memo
  assert.equal(diffVNodes(td([1, "x"], "OLD", "a"), td([1, "x"], "NEW", "z"), eqBoom).kind, "noop");  // shallow-array memo
});

test("changed memo → falls through to a real diff", () => {
  const eqFalse = { vnodeEquals: () => false, bindingsEqual: () => false };
  const p = diffVNodes(td([1, "x"], "OLD", "a"), td([2, "x"], "NEW", "a"), eqFalse); // first elem differs
  assert.notEqual(p.kind, "noop");
});

test("undefined memo → always deep-diffed (never short-circuits)", () => {
  // no memo on either node → the diff must consult vnodeEquals (here: equal).
  let consulted = false;
  const eq = { vnodeEquals: () => { consulted = true; return true; }, bindingsEqual: () => true };
  const a = { type: "el", tag: "td", attrs: { class: "a" }, children: [] };
  const b = { type: "el", tag: "td", attrs: { class: "a" }, children: [] };
  diffVNodes(a, b, eq);
  assert.equal(consulted, true);
});
