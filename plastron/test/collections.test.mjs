import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, buildSheet } from "../dist/index.js";

// collections — boundary verbs of the collections doctrine: rows/table/unique/
// jsonparse. Tabular ranges convert to the hub form (LIST OF DICTS); tables
// are views over values.

const v = (s, k) => s.cels.get(k)?.v;

const boot = async (cells) => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["dom", "collections"]);
  const seg = buildSheet({ rows: 10, cols: 8, cells });
  await resolveFn(state, "hydrate")(state, [seg], [seg]);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  return state;
};

test("rows(): flat range + header range → list of dicts (the infix shape)", async () => {
  const state = await boot({
    A1: "name", B1: "age",
    A2: "ada",  B2: "36",
    A3: "bob",  B3: "41",
    C1: "=rows(A2:B3, A1:B1)",
    C2: "=rows(A2:B3, A1:B1).age",          // hub form broadcasts
    C3: "=SUM(rows(A2:B3, A1:B1).age)",
  });
  assert.deepEqual(v(state, "sheet.C1"), [{ name: "ada", age: 36 }, { name: "bob", age: 41 }]);
  assert.deepEqual(v(state, "sheet.C2"), [36, 41]);
  assert.equal(v(state, "sheet.C3"), 77);
});

test("rows(): nested arrays with header row, and dict-list identity", async () => {
  const state = await boot({
    A1: '=rows([["n", "x"], [1, 2], [3, 4]])',
    A2: '=rows([{"n": 5}])',
    A3: "=rows(BYROW(B1:C2, LAMBDA(r, r)))",  // BYROW nests an infix range
    B1: "k",  C1: "val",
    B2: "koi", C2: "9",
  });
  assert.deepEqual(v(state, "sheet.A1"), [{ n: 1, x: 2 }, { n: 3, x: 4 }]);
  assert.deepEqual(v(state, "sheet.A2"), [{ n: 5 }]);
  assert.deepEqual(v(state, "sheet.A3"), [{ k: "koi", val: 9 }]);
});

test("table(): list of dicts → table vnode; cols/limit opts", async () => {
  const state = await boot({
    A1: '=table([{"a": 1, "b": 2}, {"a": 3, "c": 4}])',
    A2: '=table([{"a": 1}, {"a": 2}, {"a": 3}], {limit: 2})',
    A3: '=table([{"a": 1, "b": 2}], {cols: ["b"]})',
  });
  const t1 = v(state, "sheet.A1");
  assert.equal(t1.tag, "table");
  assert.equal(t1.attrs.class, "pl-table");
  const headers = t1.children[0].children[0].children.map((th) => th.children[0].text);
  assert.deepEqual(headers, ["a", "b", "c"]);              // union, first-seen order
  assert.equal(t1.children[1].children.length, 2);         // two body rows
  const t2 = v(state, "sheet.A2");
  assert.equal(t2.children[1].children.length, 3);         // 2 rows + "… 1 more"
  assert.match(t2.children[1].children[2].children[0].children[0].text, /1 more/);
  const t3 = v(state, "sheet.A3");
  assert.deepEqual(t3.children[0].children[0].children.map((th) => th.children[0].text), ["b"]);
});

test("unique(): order-preserving, structural for dicts", async () => {
  const state = await boot({
    A1: '=unique([1, "1", 1, 2, 2, 3])',
    A2: '=unique([{"a": 1}, {"a": 1}, {"a": 2}])',
  });
  assert.deepEqual(v(state, "sheet.A1"), [1, "1", 2, 3]);
  assert.deepEqual(v(state, "sheet.A2"), [{ a: 1 }, { a: 2 }]);
});

test("jsonparse(): string → value, error catchable, json() round-trip", async () => {
  const state = await boot({
    A1: '{"fish": ["koi"]}',
    B1: "=jsonparse(json(A1)).fish[0]",       // value → string → value
    B2: '=jsonparse("[1, 2, 3]")[1]',
    B3: '=IFERROR(jsonparse("{nope"), "bad json")',
  });
  assert.equal(v(state, "sheet.B1"), "koi");
  assert.equal(v(state, "sheet.B2"), 2);
  assert.equal(v(state, "sheet.B3"), "bad json");
});
