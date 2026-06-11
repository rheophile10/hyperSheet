import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, setAccessPolicy, bundleSegments, withAccessor, isDenied, canGet } from "../dist/index.js";

// ============================================================================
// Can a FORMULA (or agent command) in segment A read a SEALED segment B it is
// not whitelisted for — through ANY vector? If every vector below shows #DENIED
// / no leak, then a secret is just a sealed cel and the wallet's encryption +
// handle machinery becomes OPTIONAL. B plays the wallet; A is untrusted.
// ============================================================================
const seg = (state, key, spec) => resolveFn(state, "setCel")(state, key, { ...spec, metadata: { key, ...spec.metadata } });
const cycle = (state) => resolveFn(state, "runCycle")(state);
const setup = async () => {
  const state = createInitialState();
  await seg(state, "B.secret", { celType: "ValueCel", v: "TOPSECRET", metadata: { segment: "B", name: "secret" } });
  await seg(state, "B.n", { celType: "ValueCel", v: 42, metadata: { segment: "B", name: "n" } });
  setAccessPolicy(state, "B", { get: ["clientmaker"], getSealed: true, set: "private" });
  return state;
};

test("direct read → #DENIED, never the value", async () => {
  const state = await setup();
  await seg(state, "A.peek", { celType: "FormulaCel", f: "B.secret", metadata: { segment: "A", name: "peek", parser: "f" } });
  await cycle(state);
  const v = state.cels.get("A.peek")?.v;
  assert.ok(isDenied(v), "resolved to #DENIED");
  assert.notEqual(v, "TOPSECRET");
});

test("transitive read can't launder the secret through an intermediate cel", async () => {
  const state = await setup();
  await seg(state, "A.mid", { celType: "FormulaCel", f: "B.secret", metadata: { segment: "A", name: "mid", parser: "f" } });
  await seg(state, "A.out", { celType: "FormulaCel", f: "A.mid", metadata: { segment: "A", name: "out", parser: "f" } });
  await cycle(state);
  assert.ok(!JSON.stringify(state.cels.get("A.out")?.v ?? "").includes("TOPSECRET"), "secret never propagates");
});

test("arithmetic over a sealed value yields no secret", async () => {
  const state = await setup();
  await seg(state, "A.calc", { celType: "FormulaCel", f: "(+ B.n 1)", metadata: { segment: "A", name: "calc", parser: "f" } });
  await cycle(state);
  assert.notEqual(state.cels.get("A.calc")?.v, 43, "can't compute on the sealed value");
});

test("the WHITELISTED reader can read (positive control)", async () => {
  const state = await setup();
  await seg(state, "clientmaker.use", { celType: "FormulaCel", f: "B.secret", metadata: { segment: "clientmaker", name: "use", parser: "f" } });
  await cycle(state);
  assert.equal(state.cels.get("clientmaker.use")?.v, "TOPSECRET", "the listed reader gets it");
});

test("bundling A with B can't open a SEALED get", async () => {
  const state = await setup();
  bundleSegments(state, ["A", "B"]);
  assert.equal(canGet(state, "A", "B"), false, "seal dominates the bundle grant");
});

test("a write from a non-whitelisted segment is refused", async () => {
  const state = await setup();
  try { await withAccessor(state, "A", () => Promise.resolve(resolveFn(state, "setValue")(state, "B.secret", "HACKED"))); } catch { /* refused */ }
  await cycle(state);
  assert.notEqual(state.cels.get("B.secret")?.v, "HACKED", "write refused");
});

test("a formula cannot forge its accessor (segment is kernel-assigned)", async () => {
  const state = await setup();
  await seg(state, "A.peek", { celType: "FormulaCel", f: "B.secret", metadata: { segment: "A", name: "peek", parser: "f" } });
  await cycle(state);
  assert.ok(isDenied(state.cels.get("A.peek")?.v), "A is A — it cannot read as clientmaker");
});

test("#DENIED is opaque — it carries no trace of the real value", async () => {
  const state = await setup();
  await seg(state, "A.peek", { celType: "FormulaCel", f: "B.secret", metadata: { segment: "A", name: "peek", parser: "f" } });
  await cycle(state);
  assert.ok(!JSON.stringify(state.cels.get("A.peek")?.v).includes("TOPSECRET"), "#DENIED is opaque");
});
