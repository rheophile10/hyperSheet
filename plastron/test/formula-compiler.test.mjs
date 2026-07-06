import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// ============================================================================
// formula-compiler — kind "formula": a defn whose body is a parameterized
// plastron formula, not JS. `=FORMULA(src, "name")` binds a reusable verb that
// is itself a (dom …)/arithmetic formula — editable, wiki-visible, callable
// like any native verb. Params bind to call args; non-param symbols resolve
// from the registry. See bench numbers in the file header / PR.
// ============================================================================

const boot = async () => {
  const state = createInitialState();
  const R = (k) => resolveFn(state, k);
  await R("ensureSegments")(state, ["builtins", "defn", "formula-compiler", "js-compiler", "html-template-parser", "dom"]);
  await R("hydrate")(state, [], []);
  await R("runCycle")(state);
  return state;
};
const define = async (state, kind, name, src) => {
  const R = (k) => resolveFn(state, k);
  await R("setCel")(state, `${name}_src`, { celType: "ValueCel", v: src, metadata: { segment: "user" } });
  await R("setCel")(state, `${name}_bind`, { celType: "FormulaCel", f: `(${kind} ${name}_src "${name}")`, metadata: { segment: "user" } });
  await R("runCycle")(state);
  await R("drain")(state, "defn.commit");
  return resolveFn(state, name);
};

test("a (params) => body formula compiles to a verb; params bind to call args", async () => {
  const state = await boot();
  const f = await define(state, "formula", "muladd", "(a, b) => (+ (* a b) 1)");
  const made = state.cels.get("muladd");
  assert.equal(made.celType, "EditableLambdaCel", "committed as an editable lambda");
  assert.equal(made.metadata.kind, "formula", "kind is formula");
  assert.equal(made.f, "(a, b) => (+ (* a b) 1)", "the DEFINITION is the cel content (wiki-visible)");
  assert.equal(f(6, 7), 43, "(6*7)+1");
  assert.equal(f(0, 9), 1, "(0*9)+1");
});

test("the body may call other verbs — a dom-composing formula verb", async () => {
  const state = await boot();
  // (named `boxcard`, not `box` — plastron-gpu owns the `box` geometry
  // constructor now, and locked vocabulary cels refuse redefinition.)
  const box = await define(state, "formula", "boxcard", '(m, x) => (dom "div.box" m x)');
  const v = box("grid", "hi");
  assert.equal(v?.type, "el");
  assert.equal(v?.tag, "div");
  assert.equal(v?.attrs?.class, "box");
  assert.deepEqual(v?.children?.map((c) => c.text ?? c.tag), ["grid", "hi"], "params land as children");
});

test("a formula verb is callable from another formula (registry dispatch)", async () => {
  const state = await boot();
  await define(state, "formula", "dbl", "(n) => (* n 2)");
  const R = (k) => resolveFn(state, k);
  await R("setCel")(state, "caller", { celType: "FormulaCel", f: "(dbl 21)", metadata: { segment: "user" } });
  await R("runCycle")(state);
  assert.equal(state.cels.get("caller")?.v, 42, "(dbl 21) = 42");
});

test("editing the source redefines the verb; callers track it", async () => {
  const state = await boot();
  await define(state, "formula", "scale", "(n) => (* n 10)");
  assert.equal(resolveFn(state, "scale")(4), 40);
  const R = (k) => resolveFn(state, k);
  await R("setValue")(state, "scale_src", "(n) => (* n 100)");
  await R("runCycle")(state);
  await R("drain")(state, "defn.commit");
  assert.equal(resolveFn(state, "scale")(4), 400, "redefinition takes effect");
});

test("zero-param body works (a bare formula with no header)", async () => {
  const state = await boot();
  const f = await define(state, "formula", "answer", "(+ 40 2)");
  assert.equal(f(), 42, "0-ary formula verb");
});
