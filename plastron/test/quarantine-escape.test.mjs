import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, resolveFn, isCelError,
  setTrust, canUse, resolveTrust, kernelTrust, trustAllowsReach,
  extractNeeds, grantDelta, FULL_TRUST, LOCKED_TRUST,
} from "../dist/index.js";

// ============================================================================
// quarantine/escape — mean formulas trying to break the capability jail.
// Trust is two grant tiers (kernel ∧ segment); default (no 信. cel) = FULL, so
// the top-level kernel is unrestricted. A quarantined kernel/segment denies the
// gated capabilities (code/net/storage/secrets). See
// docs/1-design/1-under-consideration/quarantine.md.
// ============================================================================

const baseManifest = { name: "user", version: "0.0.1", description: "t", dependencies: [] };
const hydrateLambda = async (state, kind, segment = "user") => {
  await resolveFn(state, "hydrate")(state, [{
    name: "user",
    cels: [{ key: "op", celType: "EditableLambdaCel", metadata: { key: "op", segment, kind }, f: "(x) => x * 2" }],
  }], [baseManifest]);
  return state.cels.get("op");
};

// ── the default kernel is fully trusted (no regression) ─────────────────────

test("default kernel (no 信. cel) grants every capability", () => {
  const state = createInitialState();
  for (const c of ["code", "net", "storage", "secrets"]) assert.equal(canUse(state, "anyseg", c), true, c);
  assert.deepEqual(kernelTrust(state), FULL_TRUST);
});

test("a USER lambda compiles normally when code is granted (default)", async () => {
  const op = await hydrateLambda(createInitialState(), "js");
  assert.equal(typeof op._fn, "function", "js lambda compiled — code allowed by default");
});

// ── locking the kernel denies the code capability at compile time ───────────

test("a quarantined kernel REFUSES to compile a js lambda (code gate)", async () => {
  const state = createInitialState();
  setTrust(state, "kernel", LOCKED_TRUST);     // lock the whole instance
  const op = await hydrateLambda(state, "js");
  assert.notEqual(typeof op._fn, "function", "no _fn — the lambda never compiled");
  assert.ok(isCelError(op.v), `cel value is a CapabilityDeniedError (got ${JSON.stringify(op.v)})`);
});

test("locking only a SEGMENT denies its lambdas; other segments still compile", async () => {
  const state = createInitialState();
  setTrust(state, "user", { code: false });    // quarantine just `user`
  const op = await hydrateLambda(state, "js", "user");
  assert.notEqual(typeof op._fn, "function", "user's lambda denied");
  // a different segment is unaffected (kernel still FULL)
  assert.equal(canUse(state, "other", "code"), true, "a non-quarantined segment keeps code");
});

test("a FORMULA cel (declarative language) still runs in a fully-locked kernel", async () => {
  const state = createInitialState();
  setTrust(state, "kernel", LOCKED_TRUST);
  await resolveFn(state, "hydrate")(state, [{
    name: "user",
    cels: [
      { key: "a", celType: "ValueCel", metadata: { key: "a", segment: "user" }, v: 21 },
      { key: "b", celType: "FormulaCel", metadata: { key: "b", segment: "user", parser: "f" }, f: "(* a 2)" },
    ],
  }], [baseManifest]);
  await resolveFn(state, "runCycle")(state);
  assert.equal(state.cels.get("b").v, 42, "dom/cels/arithmetic are ungated — locked sheet still computes");
});

// ── net / storage capability checks (what the origin drain gates on) ────────

test("net and storage are independently togglable", () => {
  const state = createInitialState();
  setTrust(state, "sheet1", { net: true, storage: false });   // allow net, deny storage
  assert.equal(canUse(state, "sheet1", "net"), true, "net granted");
  assert.equal(canUse(state, "sheet1", "storage"), false, "storage still denied");
  assert.equal(canUse(state, "sheet1", "code"), true, "unspecified caps inherit kernel (FULL)");
});

// ── monotonic narrowing — a child can't widen a locked parent ───────────────

test("a segment CANNOT widen a capability the kernel locked (monotonic)", () => {
  const state = createInitialState();
  setTrust(state, "kernel", { net: false });        // kernel forbids net
  setTrust(state, "sheet1", { net: true });          // sheet tries to grant it
  assert.equal(canUse(state, "sheet1", "net"), false, "kernel ∧ segment → false; no widening");
});

// ── cross-segment reach whitelist ───────────────────────────────────────────

test("trustAllowsReach honors the segment whitelist", () => {
  const state = createInitialState();
  setTrust(state, "sheet1", { segments: ["clients"] });
  assert.equal(trustAllowsReach(state, "sheet1", "clients"), true, "whitelisted reach allowed");
  assert.equal(trustAllowsReach(state, "sheet1", "secrets"), false, "non-whitelisted reach denied");
  assert.equal(trustAllowsReach(state, "sheet1", "sheet1"), true, "self always reachable");
});

// ── `needs` extraction + grant-delta (the consent computation) ──────────────

test("extractNeeds reads (needs …) statically from formula source", () => {
  const req = extractNeeds(`(needs "net" "storage" "seg:clients") (dom "div" {} hi)`);
  assert.deepEqual(req, { net: true, storage: true, segments: ["clients"] });
  assert.deepEqual(extractNeeds("(dom \"div\" {} hi)"), {}, "no declaration → empty request");
});

test("grantDelta is exactly the requested capabilities not yet granted", () => {
  const requested = extractNeeds(`(needs "net" "storage")`);
  const granted = resolveTrust(createInitialState(), "sheet1"); // FULL by default
  assert.deepEqual(grantDelta(requested, granted), [], "FULL kernel covers the request → no prompt");

  const locked = LOCKED_TRUST;
  assert.deepEqual(grantDelta(requested, locked).sort(), ["net", "storage"], "locked → both must be approved");
  assert.deepEqual(grantDelta(requested, { ...locked, net: true }), ["storage"], "approving net leaves storage");
});

// ── a url seed shipping trust:{net:true} cannot self-grant ──────────────────

test("a payload cannot self-grant: a locked kernel ignores any in-payload claim", () => {
  const state = createInitialState();
  setTrust(state, "kernel", LOCKED_TRUST);   // origin stamps this for a url seed
  // the seed's own (needs "net") only REQUESTS; the grant stays locked until a human approves
  const granted = resolveTrust(state, "urlsheet");
  assert.equal(granted.net, false, "url kernel stays locked — request != grant");
  assert.deepEqual(grantDelta(extractNeeds(`(needs "net")`), granted), ["net"], "net must be approved by the user");
});
