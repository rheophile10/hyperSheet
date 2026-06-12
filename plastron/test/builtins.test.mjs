import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

const OPS = ["+", "-", "*", "/"];

test("builtins segment installs + - * / as LockedLambdaCels with _fn", () => {
  const state = createInitialState();
  for (const k of OPS) {
    const cel = state.cels.get(k);
    assert.ok(cel, `cel "${k}" missing`);
    assert.equal(cel.celType, "LockedLambdaCel", `cel "${k}" wrong celType`);
    assert.equal(typeof cel._fn, "function", `cel "${k}" missing _fn`);
    assert.equal(cel.metadata.segment, "builtins", `cel "${k}" wrong segment`);
    assert.equal(cel.locked, true, `cel "${k}" should be locked`);
  }
});

test("builtin cels carry impls matching the old hardcoded BUILTINS table", () => {
  const state = createInitialState();
  const plus  = state.cels.get("+")._fn;
  const minus = state.cels.get("-")._fn;
  const times = state.cels.get("*")._fn;
  const div   = state.cels.get("/")._fn;

  assert.equal(plus(),         0);
  assert.equal(plus(1, 2, 3),  6);
  assert.equal(times(),        1);
  assert.equal(times(2, 3, 4), 24);
  assert.equal(minus(),        0);
  assert.equal(minus(5),       -5);
  assert.equal(minus(10, 3),   7);
  assert.equal(Number.isNaN(div()), true);
  assert.equal(div(4),         0.25);
  assert.equal(div(20, 5),     4);
  assert.equal(plus("1", "2"), 3); // Number() coercion preserved
});

test("json builtin: pretty-prints any value to a JSON string (JSON.stringify(v, null, 2))", () => {
  const state = createInitialState();
  const cel = state.cels.get("json");
  assert.ok(cel, "cel \"json\" missing");
  assert.equal(cel.celType, "LockedLambdaCel", "json is a LockedLambdaCel");
  assert.equal(cel.metadata.segment, "builtins", "json is in the builtins segment");
  const json = cel._fn;
  // an array of message objects → pretty JSON, NOT "[object Object]"
  assert.equal(json([{ a: 1 }]), JSON.stringify([{ a: 1 }], null, 2));
  assert.match(json([{ a: 1 }]), /\n {2}/, "two-space indented (pretty)");
  assert.equal(json([{ from: "me", text: "hi" }]),
    '[\n  {\n    "from": "me",\n    "text": "hi"\n  }\n]');
  assert.equal(json({ x: 1 }), '{\n  "x": 1\n}');
  assert.equal(json("hi"), '"hi"');
  assert.equal(json(42), "42");
});

test("builtins is flushable (honest kernel closure, roadmap 02)", async () => {
  // History: pre-chunk-A flushing builtins removed its cels; chunk-A
  // (segment-classification) put builtins in the kernel closure via the
  // kernel manifest's dep list, making it unflushable.
  //
  // Roadmap 02 shrinks kernel.dependencies to [], so the closure is
  // {kernel} alone and builtins is an ordinary flushable library — as its
  // 冊.json description always promised ("Flushable; formulas referencing
  // them error cleanly when removed").
  const state = createInitialState();
  const flush          = resolveFn(state, "flush");
  const compileFormula = resolveFn(state, "f");

  const before = compileFormula("(+ a b)");
  assert.equal(before.fn({ "+": state.cels.get("+")._fn, a: 1, b: 2 }), 3);

  // No longer kernel-protected: flush succeeds and drops the op cels.
  await flush(state, "builtins", { force: true });
  for (const k of OPS) {
    assert.ok(!state.cels.get(k), `cel "${k}" should be gone — builtins flushed`);
  }
});
