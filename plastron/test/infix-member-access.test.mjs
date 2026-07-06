import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, buildSheet } from "../dist/index.js";

// Member access + list literals (0-based bracket surface):
//   ={a: 1}            object literal (existing)      =[1, 2, 3]  list literal
//   =A1.test           dot member on a cell's dict    =A1.users[0].name  chains
//   =B2[0]  =B2[-1]    0-based index, negatives from the end
//   =B2[1:3] =B2[:2]   JS slice semantics             =A1[B1]  dynamic key
//   =LET(o, A1, o.age) bound heads walk the binding, not a cel key
// Data entry: content starting with `{`/`[` that parses as JSON enters as the
// object/array VALUE (leading-char rule: `=` infix, `(` S-expr, `{`/`[` JSON).

const v = (s, k) => s.cels.get(k)?.v;

const boot = async (cells) => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["dom"]);
  const seg = buildSheet({ rows: 10, cols: 8, cells });
  await resolveFn(state, "hydrate")(state, [seg], [seg]);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  return state;
};

test("list literal evaluates and wires cel refs", async () => {
  const state = await boot({
    A1: "10",
    B1: "=[1, \"two\", A1, [2, 3]]",
    B2: "=[]",
    B3: '=MAP(["a", "b"], LAMBDA(x, x & "!"))',
    B4: '=SUM([1, 2, 3][1:])',
  });
  assert.deepEqual(v(state, "sheet.B1"), [1, "two", 10, [2, 3]]);
  assert.deepEqual(v(state, "sheet.B2"), []);
  assert.deepEqual(v(state, "sheet.B3"), ["a!", "b!"]);
  assert.equal(v(state, "sheet.B4"), 5);

  // reactive: the A1 ref inside the literal is a real dependency
  await resolveFn(state, "setValue")(state, "sheet.A1", 99);
  await resolveFn(state, "runCycle")(state);
  assert.equal(v(state, "sheet.B1")[2], 99);
});

test("dot member access on a dict cell", async () => {
  const state = await boot({
    A1: '={name: "kirk", age: 7, tags: ["a", "b"]}',
    B1: "=A1.age",
    B2: "=A1.name & \"!\"",
    B3: "=A1.tags[1]",
    B4: "=A1.missing",     // undefined-safe, like an empty cell
    B5: "=A1.age * 2",
  });
  assert.equal(v(state, "sheet.B1"), 7);
  assert.equal(v(state, "sheet.B2"), "kirk!");
  assert.equal(v(state, "sheet.B3"), "b");
  assert.equal(v(state, "sheet.B4"), undefined);
  assert.equal(v(state, "sheet.B5"), 14);

  // reactive: B1 recomputes when A1's dict changes (A1 is a FormulaCel, so
  // its content is formula SOURCE)
  await resolveFn(state, "setValue")(state, "sheet.A1", '={name: "kirk", age: 8}');
  await resolveFn(state, "runCycle")(state);
  assert.equal(v(state, "sheet.B1"), 8);
});

test("0-based indexing, negatives, slices, dynamic keys", async () => {
  const state = await boot({
    A1: "10", A2: "20", A3: "30",
    B1: "=MAP(A1:A3, LAMBDA(x, x+1))",   // [11, 21, 31]
    C1: "=B1[0]",
    C2: "=B1[-1]",
    C3: "=B1[1:3]",
    C4: "=B1[:2]",
    C5: "=B1[1:]",
    C6: "=B1[5]",                         // out of range → undefined
    D1: "age",
    D2: '={age: 7}',
    D3: "=D2[D1]",                        // dynamic key on a dict
    D4: '="plastron"[0]',                 // strings index too
    D5: '="plastron"[-3:]',
  });
  assert.equal(v(state, "sheet.C1"), 11);
  assert.equal(v(state, "sheet.C2"), 31);
  assert.deepEqual(v(state, "sheet.C3"), [21, 31]);
  assert.deepEqual(v(state, "sheet.C4"), [11, 21]);
  assert.deepEqual(v(state, "sheet.C5"), [21, 31]);
  assert.equal(v(state, "sheet.C6"), undefined);
  assert.equal(v(state, "sheet.D3"), 7);
  assert.equal(v(state, "sheet.D4"), "p");
  assert.equal(v(state, "sheet.D5"), "ron");
});

test("chained access through nested structures", async () => {
  const state = await boot({
    A1: '={users: [{name: "ada"}, {name: "bob"}], n: 2}',
    B1: "=A1.users[0].name",
    B2: "=A1.users[-1].name",
    B3: "=[[1,2],[3,4]][1][0]",           // postfix directly on a literal
  });
  assert.equal(v(state, "sheet.B1"), "ada");
  assert.equal(v(state, "sheet.B2"), "bob");
  assert.equal(v(state, "sheet.B3"), 3);
});

test("LET/LAMBDA-bound heads walk the binding, not a cel key", async () => {
  const state = await boot({
    A1: '={age: 7, xs: [1, 2, 3]}',
    B1: "=LET(o, A1, o.age + o.xs[2])",
    B2: "=SUM(MAP(A1.xs, LAMBDA(x, x*10)))",
    B3: "=LET(l, A1.xs, l[1:])[0]",
  });
  assert.equal(v(state, "sheet.B1"), 10);
  assert.equal(v(state, "sheet.B2"), 60);
  assert.equal(v(state, "sheet.B3"), 2);
});

test("namespaced cel keys keep their exact-key meaning", async () => {
  const state = await boot({ A1: "1" });
  const setCel = resolveFn(state, "setCel");
  await setCel(state, "config.theme", { celType: "ValueCel", v: "dark", metadata: { key: "config.theme" } });
  await setCel(state, "sheet.B1", { celType: "FormulaCel", f: "=config.theme", metadata: { key: "sheet.B1", segment: "sheet-grid", parser: "infix" } });
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  // head "config" is not a cell ref → resolves as the exact cel key, as before
  assert.equal(v(state, "sheet.B1"), "dark");
});

test("cross-sheet member access: seg!A1.path", async () => {
  const state = await boot({ A1: "1" });
  const setCel = resolveFn(state, "setCel");
  await setCel(state, "fish.A1", { celType: "FormulaCel", f: '={species: "koi"}', metadata: { key: "fish.A1", segment: "fish", parser: "infix" } });
  await setCel(state, "sheet.B1", { celType: "FormulaCel", f: "=fish!A1.species", metadata: { key: "sheet.B1", segment: "sheet-grid", parser: "infix" } });
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  assert.equal(v(state, "sheet.B1"), "koi");
});

test("JSON data entry: {…}/[…] content becomes the parsed value", async () => {
  const state = await boot({
    A1: '{"name": "kirk", "age": 7}',
    A2: '[1, 2, 3]',
    A3: '{not json',                       // unparseable → stays a string
    B1: "=A1.age + A2[0]",
  });
  assert.deepEqual(v(state, "sheet.A1"), { name: "kirk", age: 7 });
  assert.deepEqual(v(state, "sheet.A2"), [1, 2, 3]);
  assert.equal(v(state, "sheet.A3"), "{not json");
  assert.equal(v(state, "sheet.B1"), 8);
});

test("JSON values survive a dehydrate → hydrate round-trip", async () => {
  const state = await boot({
    A1: '{"fish": ["koi", "tetra"], "n": 2}',
    B1: "=A1.fish[-1]",
  });
  const dehydrated = await resolveFn(state, "dehydrate")(state, { onlySegments: ["sheet-grid"] });
  const payload = JSON.parse(JSON.stringify(dehydrated)); // force through JSON
  const grid = payload.manifests.find((m) => m.cels.some((c) => c.key === "sheet.A1"));
  const cel = grid.cels.find((c) => c.key === "sheet.A1");
  assert.deepEqual(cel.v, { fish: ["koi", "tetra"], n: 2 }); // archived as plain JSON

  const state2 = createInitialState();
  await resolveFn(state2, "ensureSegments")(state2, ["dom"]);
  await resolveFn(state2, "hydrate")(state2, payload.segments, payload.manifests);
  await precomputeOptional(state2);
  await resolveFn(state2, "runCycle")(state2);
  assert.deepEqual(v(state2, "sheet.A1"), { fish: ["koi", "tetra"], n: 2 });
  assert.equal(v(state2, "sheet.B1"), "tetra");
});

test("range broadcasting: dot maps member access over a range", async () => {
  const state = await boot({
    D1: '{"name": "ada", "age": 36}',
    D2: '{"name": "bob", "age": 41}',
    D3: '{"name": "cy",  "age": 29}',
    // D4 left empty — over-selected ranges skip empty cells on member access
    E1: "=D1:D4.age",
    E2: "=SUM(D1:D4.age)",
    E3: "=D1:D4.name[0]",       // broadcast, then positional
    E4: "=D1:D4[0]",            // bracket on a range is positional (raw, no skip)
    E5: "=D1:D4[-1]",           // last cell — the EMPTY one, positional integrity
    E6: "=D1:D3[1:]",           // slice of cell values
    F1: '{"user": {"name": "ada"}}',
    F2: '{"user": {"name": "bob"}}',
    F3: "=F1:F2.user.name",     // chains re-broadcast
  });
  assert.deepEqual(v(state, "sheet.E1"), [36, 41, 29]);
  assert.equal(v(state, "sheet.E2"), 106);
  assert.equal(v(state, "sheet.E3"), "ada");
  assert.deepEqual(v(state, "sheet.E4"), { name: "ada", age: 36 });
  assert.equal(v(state, "sheet.E5"), "");
  assert.deepEqual(v(state, "sheet.E6"), [{ name: "bob", age: 41 }, { name: "cy", age: 29 }]);
  assert.deepEqual(v(state, "sheet.F3"), ["ada", "bob"]);

  // reactive: a broadcast dep is per-member — editing D2 recomputes E2
  await resolveFn(state, "setValue")(state, "sheet.D2", { name: "bob", age: 50 });
  await resolveFn(state, "runCycle")(state);
  assert.equal(v(state, "sheet.E2"), 115);
});

test("member access broadcasts over array VALUES the same as ranges", async () => {
  const state = await boot({
    A1: '[{"n": 1}, {"n": 2}, {"n": 3}]',
    B1: "=A1.n",
    B2: "=SUM(A1.n)",
    B3: "=A1[1:].n",
  });
  assert.deepEqual(v(state, "sheet.B1"), [1, 2, 3]);
  assert.equal(v(state, "sheet.B2"), 6);
  assert.deepEqual(v(state, "sheet.B3"), [2, 3]);
});

test("bracket-slice endpoints as refs still mean slice, not range", async () => {
  const state = await boot({
    A1: "1", A2: "3",
    B1: '=[10, 20, 30, 40][A1:A2]',   // slice from A1's value to A2's value
  });
  assert.deepEqual(v(state, "sheet.B1"), [20, 30]);
});

test("cross-sheet range broadcasting: seg!A1:A2.path", async () => {
  const state = await boot({ A1: "1" });
  const setCel = resolveFn(state, "setCel");
  await setCel(state, "fish.A1", { celType: "FormulaCel", f: '={species: "koi", n: 4}', metadata: { key: "fish.A1", segment: "fish", parser: "infix" } });
  await setCel(state, "fish.A2", { celType: "FormulaCel", f: '={species: "tetra", n: 9}', metadata: { key: "fish.A2", segment: "fish", parser: "infix" } });
  await setCel(state, "sheet.B1", { celType: "FormulaCel", f: "=fish!A1:A2.species", metadata: { key: "sheet.B1", segment: "sheet-grid", parser: "infix" } });
  await setCel(state, "sheet.B2", { celType: "FormulaCel", f: "=SUM(fish!A1:A2.n)", metadata: { key: "sheet.B2", segment: "sheet-grid", parser: "infix" } });
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  assert.deepEqual(v(state, "sheet.B1"), ["koi", "tetra"]);
  assert.equal(v(state, "sheet.B2"), 13);
});
