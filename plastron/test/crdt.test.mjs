import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, precompute, precomputeOptional } from "../dist/index.js";

const fns = () => {
  const s = createInitialState();
  const get = (k) => {
    const c = s.cels.get(k);
    assert.ok(c, `cel "${k}" missing`);
    assert.equal(c.celType, "LockedLambdaCel", `cel "${k}" wrong celType`);
    assert.equal(c.metadata.segment, "crdt", `cel "${k}" wrong segment`);
    assert.equal(c.locked, true, `cel "${k}" should be locked`);
    assert.equal(typeof c._fn, "function", `cel "${k}" missing _fn`);
    return c._fn;
  };
  return { diff: get("crdt.diff"), apply: get("crdt.apply"), layer: get("crdt.layer"), append: get("crdt.append"), resolve: get("crdt.resolve") };
};

test("crdt segment installs diff/apply/layer/append/resolve as locked native cels", () => {
  fns(); // assertions live in the getter
});

test("diff + apply round-trip: apply(before, diff(before, after)) === after", () => {
  const { diff, apply } = fns();
  const cases = [
    ["a\nb", "a\nc\nb"],            // insert a line
    ["a\nb\nc", "a\nc"],            // delete a line
    ["hi", "hi there"],            // whole-line replace
    ["", "first"],                 // empty → one line
    ["only", ""],                  // → empty
    ["x\ny\nz", "z\ny\nx"],        // reorder
    ["one\ntwo\nthree", "one\nTWO\nthree\nfour"], // edit + append (multi-hunk in one record)
  ];
  for (const [before, after] of cases) {
    assert.deepEqual(apply(before, diff(before, after)), after, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
});

test("diff produces a single multi-hunk record covering multiple lines", () => {
  const { diff } = fns();
  const ops = diff("one\ntwo\nthree", "one\nTWO\nthree\nfour");
  assert.ok(Array.isArray(ops));
  assert.ok(ops.length >= 1);
  for (const h of ops) {
    assert.equal(typeof h.at, "number");
    assert.equal(typeof h.del, "number");
    assert.ok(Array.isArray(h.ins));
  }
});

test("layer stamps author + ts + deterministic id, parent optional", () => {
  const { layer } = fns();
  const l = layer("", "hello", "alice", 5);
  assert.equal(l.author, "alice");
  assert.equal(l.ts, 5);
  assert.equal(l.parent, null);
  assert.ok(l.id.startsWith("5.alice."), `id was ${l.id}`);
  assert.ok(Array.isArray(l.ops));
  // deterministic: same inputs → same id
  assert.equal(layer("", "hello", "alice", 5).id, l.id);
  // distinct content → distinct id
  assert.notEqual(layer("", "world", "alice", 5).id, l.id);
  // parent recorded
  assert.equal(layer("hello", "hello!", "alice", 6, l.id).parent, l.id);
});

test("resolve folds the whole stack; resolve(stack, n) is n edits up from 0", () => {
  const { layer, append, resolve } = fns();
  let stack = [];
  stack = append(stack, layer(resolve(stack), "hi", "alice", 1));
  stack = append(stack, layer(resolve(stack), "hi there", "alice", 2));
  stack = append(stack, layer(resolve(stack), "hi there\nbye", "alice", 3));
  assert.equal(resolve(stack), "hi there\nbye"); // head
  assert.equal(resolve(stack, 0), "");            // base
  assert.equal(resolve(stack, 1), "hi");          // after first edit
  assert.equal(resolve(stack, 2), "hi there");    // after second
  assert.equal(resolve(stack, 99), "hi there\nbye"); // n clamps to length
});

test("append is grow-only, sorted by (ts, author, id), and idempotent (dedup by id)", () => {
  const { layer, append, resolve } = fns();
  const a = layer("", "hi", "alice", 1);
  let stack = append(append([], a), a); // append same record twice
  assert.equal(stack.length, 1, "dedup by id");

  // order independence → convergence: append in two different orders, same fold
  const e1 = layer("", "a", "alice", 1);
  const e2 = layer(resolve(append([], e1)), "a\nb", "bob", 2);
  const order1 = append(append([], e1), e2);
  const order2 = append(append([], e2), e1);
  assert.deepEqual(order1.map((l) => l.id), order2.map((l) => l.id), "same sorted order regardless of insert order");
  assert.equal(resolve(order1), resolve(order2), "convergent fold");
});

test("apply is total: a stale/out-of-range hunk clamps instead of throwing", () => {
  const { apply } = fns();
  assert.equal(apply("a\nb", [{ at: 99, del: 5, ins: ["c"] }]), "a\nb\nc");
  assert.equal(apply("", [{ at: -3, del: 10, ins: ["x"] }]), "x");
  assert.equal(apply("a", []), "a");
});

test("(crdt.resolve stack) is a live FormulaCel that re-folds when the stack cel changes", async () => {
  // The real point: a diff-stack ValueCel + a formula that renders it, wired
  // purely through inputMap. Editing the stack re-fires the formula.
  const state = createInitialState();
  const hydrate  = resolveFn(state, "hydrate");
  const runCycle = resolveFn(state, "runCycle");
  const setValue = resolveFn(state, "setValue");
  const layer = state.cels.get("crdt.layer")._fn;
  const append = state.cels.get("crdt.append")._fn;

  // Namespaced keys — bare keys like `text`/`stack` collide with global cels
  // (e.g. plastron-canvas's `text` lambda), which is exactly why the verbs are
  // crdt.* too.
  const seg = {
    name: "chat",
    cels: [
      { key: "chat.stack", celType: "ValueCel",   metadata: { key: "chat.stack", segment: "chat" }, v: [] },
      { key: "chat.text",  celType: "FormulaCel",  metadata: { key: "chat.text",  segment: "chat", parser: "f" }, f: "(crdt.resolve chat.stack)" },
    ],
  };
  await hydrate(state, [seg], [{ name: "chat", version: "0.0.1", description: "test", dependencies: [] }]);
  precompute(state);
  await precomputeOptional(state);
  await runCycle(state);
  assert.equal(state.cels.get("chat.text").v, "", "empty stack → empty text");

  // commit edit #1 (alice) → formula re-folds to "hi"
  let stack = append([], layer("", "hi", "alice", 1));
  await setValue(state, "chat.stack", stack);
  assert.equal(state.cels.get("chat.text").v, "hi");

  // commit edit #2 (bob) → "hi there"
  stack = append(stack, layer("hi", "hi there", "bob", 2));
  await setValue(state, "chat.stack", stack);
  assert.equal(state.cels.get("chat.text").v, "hi there");
});
