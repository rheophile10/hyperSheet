import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// O2 incremental precompute (commit ef2eba3): precompute recodegens a cel's
// _evaluate ONLY when its resolved input cel-OBJECTS change identity. These
// tests pin the CORRECTNESS INVARIANT that makes object identity sufficient —
// if a future setCel switched to in-place mutation of v/f/type, identity would
// start missing changes and these would catch it.

const seed = async () => {
  const s = createInitialState();
  await resolveFn(s, "hydrate")(s, [{ name: "u", cels: [
    { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "u" }, v: 1 },
    { key: "b", celType: "FormulaCel", metadata: { key: "b", segment: "u", parser: "f" }, f: "(+ a 1)" },
  ]}], [{ name: "u", version: "0", description: "", dependencies: [] }]);
  await resolveFn(s, "runCycle")(s);
  return s;
};

test("value change (in-place, same object) flows via fresh read — no stale _evaluate", async () => {
  const s = await seed();
  const getCel = resolveFn(s, "getCel"), setValue = resolveFn(s, "setValue"), runCycle = resolveFn(s, "runCycle");
  assert.equal(getCel(s, "b").v, 2);
  const aObj = s.cels.get("a");
  await setValue(s, "a", 10);
  await runCycle(s);
  // identity of `a` is unchanged (mutated in place) — b's _evaluate is kept,
  // and it reads the fresh value: 11, not a stale 2.
  assert.equal(s.cels.get("a"), aObj, "setValue must keep the cel object identity");
  assert.equal(getCel(s, "b").v, 11);
});

test("structural replace (setCel) makes a NEW object → consumer recodegens", async () => {
  const s = await seed();
  const getCel = resolveFn(s, "getCel"), setCel = resolveFn(s, "setCel"), runCycle = resolveFn(s, "runCycle");
  const before = s.cels.get("a");
  await setCel(s, "a", { celType: "ValueCel", metadata: { key: "a", segment: "u" }, v: 100 });
  // INVARIANT: setCel-with-celType replaces the object (this is what makes
  // identity comparison sufficient). If this assertion ever fails, the O2
  // incremental invalidation can miss the change.
  assert.notEqual(s.cels.get("a"), before, "setCel(celType) must REPLACE the cel object");
  await runCycle(s);
  assert.equal(getCel(s, "b").v, 101, "consumer must pick up the replaced input");
});

test("replacing a referenced cel's TYPE (value → formula) is caught too", async () => {
  const s = await seed();
  const getCel = resolveFn(s, "getCel"), setCel = resolveFn(s, "setCel"), setValue = resolveFn(s, "setValue"), runCycle = resolveFn(s, "runCycle");
  // add c = 5, then replace `a` with a FORMULA (= c * 2). b = (+ a 1) must see 11.
  await setCel(s, "c", { celType: "ValueCel", metadata: { key: "c", segment: "u" }, v: 5 });
  await setCel(s, "a", { celType: "FormulaCel", metadata: { key: "a", segment: "u", parser: "f" }, f: "(* c 2)" });
  await runCycle(s);
  assert.equal(getCel(s, "a").v, 10);
  assert.equal(getCel(s, "b").v, 11, "consumer sees the retyped input's value");
  // and a downstream value change still flows
  await setValue(s, "c", 50); await runCycle(s);
  assert.equal(getCel(s, "b").v, 101);
});
