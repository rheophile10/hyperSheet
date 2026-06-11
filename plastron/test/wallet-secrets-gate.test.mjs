import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, accessPolicyOf } from "../dist/index.js";

// ============================================================================
// The wallet's secrets now live as cels in a SEALED `secrets` segment
// (get: ["clients"], getSealed, set: private). apiKey(name) is a NATIVE verb:
// its direct state.cels.get BYPASSES Layer-1's formula-dep gating, so it MUST
// gate itself with canGet(state, currentAccessor(state), "secrets"). This test
// proves:
//   • a formula in `clients` (whitelisted) gets the REAL secret back, and
//   • a formula in any other segment gets a refusal (never the secret).
// ============================================================================

const seg = (state, key, spec) =>
  resolveFn(state, "setCel")(state, key, { ...spec, metadata: { key, ...spec.metadata } });
const cycle = (state) => resolveFn(state, "runCycle")(state);
const call = (state, k, ...a) => resolveFn(state, k)(state, ...a);

const SECRET = "sk-ant-TOPSECRET-DEADBEEF";

// Bring the wallet up, unlock it (sets module state + seal hooks), store a key.
const walletWithKey = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["unsafe-wallet"]);
  await call(state, "wallet.unlock", null, { type: "change", target: { value: "hunter2" } });
  assert.equal(resolveFn(state, "locked")(), false, "wallet unlocked");
  await call(state, "wallet.set", "anthropic", { type: "change", target: { value: SECRET } });
  return state;
};

test("the secrets segment is minted SEALED (get: [clients], getSealed, set: private)", async () => {
  const state = await walletWithKey();
  const policy = accessPolicyOf(state, "secrets");
  assert.deepEqual(policy.get, ["clients"], "only clients may read");
  assert.equal(policy.getSealed, true, "get is sealed (encrypts at rest)");
  assert.equal(policy.set, "private", "set is private (writes are top-level only)");
  // and the secret really lives as a cel
  assert.equal(state.cels.get("secrets.anthropic")?.v, SECRET, "secret stored as a secrets.* cel");
  await call(state, "wallet.del", "anthropic");
  await resolveFn(state, "wallet.lock")(state);
});

test("apiKey from `clients` returns the real key; from another segment it is refused", async () => {
  const state = await walletWithKey();

  // a whitelisted reader: a FORMULA in the `clients` segment
  await seg(state, "clients.k", { celType: "FormulaCel", f: '(apiKey "anthropic")', metadata: { segment: "clients", name: "k", parser: "f" } });
  // a NON-whitelisted reader: a FORMULA in some other segment
  await seg(state, "evil.k", { celType: "FormulaCel", f: '(apiKey "anthropic")', metadata: { segment: "evil", name: "k", parser: "f" } });
  await cycle(state);

  const fromClients = state.cels.get("clients.k")?.v;
  const fromEvil = state.cels.get("evil.k")?.v;

  assert.equal(fromClients, SECRET, "the whitelisted `clients` formula gets the real key");
  assert.notEqual(fromEvil, SECRET, "a non-whitelisted segment never gets the key");
  assert.ok(String(fromEvil).includes("#DENIED"), "the refusal is an explicit #DENIED string");
  assert.ok(!String(fromEvil).includes(SECRET), "the refusal carries no trace of the secret");

  await call(state, "wallet.del", "anthropic");
  await resolveFn(state, "wallet.lock")(state);
});

test("the key never leaks at rest: a sealed dehydrate carries ciphertext, not the secret", async () => {
  const state = await walletWithKey();
  // unlock installed the seal hooks (Layer 2) — dehydrate must seal secrets.*
  const archive = JSON.parse(JSON.stringify(await resolveFn(state, "dehydrate")(state)));
  const flat = JSON.stringify(archive);
  assert.equal(flat.includes(SECRET), false, "plaintext secret must not be in the archive");

  await call(state, "wallet.del", "anthropic");
  await resolveFn(state, "wallet.lock")(state);
});
