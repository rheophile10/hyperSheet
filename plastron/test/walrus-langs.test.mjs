import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, buildSheet, isCelError } from "../dist/index.js";

// `:=` compiled tier — `seg.name := KIND[.func]{ source }` mints an
// EditableLambdaCel of `kind`, with lineage. js/py compile+run.

const v  = (s, k) => s.cels.get(k)?.v;
const md = (s, k) => s.cels.get(k)?.metadata;
const flushDefn = (s) => resolveFn(s, "drain")(s, "defn.commit");

const bootDefs = async (cells) => {
  const state = createInitialState();
  const seg = buildSheet({ rows: 8, cols: 4, cells });
  await resolveFn(state, "hydrate")(state, [seg], [seg]);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  await flushDefn(state);
  // compiled lambdas lazy-load their runtime; settle once more so the caller fires.
  await resolveFn(state, "runCycle")(state);
  return state;
};

test("js := mints an EditableLambdaCel that compiles and runs", { timeout: 60000 }, async () => {
  const state = await bootDefs({
    C1: "lib.incr := js{ (x) => x + 1 }",   // minted UPPER as lib.INCR
    B1: "=lib.INCR(41)",
  });
  const cel = state.cels.get("lib.INCR");
  assert.equal(cel.celType, "EditableLambdaCel", "compiled tier → EditableLambdaCel");
  assert.equal(cel.metadata.kind, "js", "kind names the worker");
  assert.equal(cel.metadata.definedBy, "sheet.C1", "lineage stamped");
  assert.equal(cel.metadata.segment, "lib");
  assert.equal(cel.metadata.name, "INCR", "verb name is UPPER");
  assert.equal(v(state, "sheet.B1"), 42, "=lib.INCR(41) = 42");
});

test("py := with a .func selector mints + runs (trailing-callable convention)", { timeout: 60000 }, async () => {
  const state = await bootDefs({
    C1: "lib.pydbl := py.pydbl{\ndef pydbl(x):\n    return x * 2\n}",   // minted UPPER as lib.PYDBL
    B1: "=lib.PYDBL(21)",
  });
  const cel = state.cels.get("lib.PYDBL");
  assert.equal(cel.celType, "EditableLambdaCel");
  assert.equal(cel.metadata.kind, "py");
  assert.ok(cel.f.endsWith("\npydbl"), "the .func selector appended the trailing callable");
  assert.equal(v(state, "sheet.B1"), 42, "=lib.PYDBL(21) = 42");
});
