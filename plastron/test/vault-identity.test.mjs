import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// ============================================================================
// The vault's unlock mints (first time) or loads (subsequently) ONE identity
// keypair via crypto.identity (Ed25519). The PUBLIC key surfaces through the
// identity() verb; the PRIVATE key stays non-extractable in the keystore and
// NEVER becomes a cel value. This proves:
//   • locked → identity() is the "🔒 unlock to see your identity" placeholder,
//   • unlocked → identity() returns a non-empty base64 public-key string,
//   • a second unlock (after a lock) loads the SAME identity (stable pubkey),
//   • no cel value anywhere carries the private key.
// (The Bun keystore is process-lifetime, so the identity persists across the
//  lock/unlock within this process — exactly the IndexedDB-reload behaviour.)
// ============================================================================

const call = (state, k, ...a) => resolveFn(state, k)(state, ...a);

const bootVault = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["vault"]);
  return state;
};

const unlock = (state, pw) =>
  call(state, "vault.unlock", null, { type: "change", target: { value: pw } });

const identity = (state) => resolveFn(state, "identity")();
const locked = (state) => resolveFn(state, "locked")();

test("locked → identity() is the unlock placeholder, not a key", async () => {
  const state = await bootVault();
  await resolveFn(state, "vault.lock")(state); // module-global lock state — ensure locked
  assert.equal(locked(state), true, "locked");
  const id = identity(state);
  assert.match(id, /unlock to see your identity/, "locked shows the placeholder");
});

test("unlock mints/loads an identity → identity() is a non-empty public-key string", async () => {
  const state = await bootVault();
  await unlock(state, "hunter2");
  assert.equal(locked(state), false, "unlocked");

  const pub = identity(state);
  assert.equal(typeof pub, "string");
  assert.ok(pub.length > 0, "non-empty");
  assert.ok(!/unlock to see/.test(pub), "no longer the placeholder");
  // Ed25519 raw public key is 32 bytes → base64 is well over a few chars and
  // decodes cleanly (no whitespace / hint wording).
  assert.match(pub, /^[A-Za-z0-9+/]+=*$/, "looks like base64");
  assert.ok(atob(pub).length >= 16, "decodes to real key bytes");
});

test("a second unlock loads the SAME identity (stable public key)", async () => {
  const state = await bootVault();
  await unlock(state, "first-pass");
  const pub1 = identity(state);

  await resolveFn(state, "vault.lock")(state);
  assert.equal(locked(state), true, "re-locked");
  assert.match(identity(state), /unlock to see/, "locked hides the key again");

  await unlock(state, "second-pass");
  const pub2 = identity(state);
  assert.equal(pub2, pub1, "the identity is stable across lock/unlock");

  // a brand-new state in the SAME process shares the process-lifetime keystore →
  // same identity (mirrors a browser reload reading the persistent IndexedDB key)
  const state2 = await bootVault();
  await unlock(state2, "another");
  assert.equal(identity(state2), pub1, "the identity persists across states (reload-stable)");
});

test("the PRIVATE key never enters any cel value", async () => {
  const state = await bootVault();
  await unlock(state, "topsecret-pass");
  const pub = identity(state);

  // The crypto.identity handle carries only id + kind + PUBLIC key.
  const handle = await resolveFn(state, "crypto.identity")();
  assert.deepEqual(Object.keys(handle).sort(), ["__cryptoKeyHandle", "id", "kind", "publicKey"]);
  assert.ok(!("privateKey" in handle), "no privateKey on the handle");

  // Walk EVERY cel value: none may carry a CryptoKey / private material, and the
  // only place the public key appears is as a plain shareable string.
  for (const [key, cel] of state.cels) {
    const v = cel.v;
    if (v && typeof v === "object") {
      assert.ok(!("privateKey" in v), `cel ${key} must not hold a privateKey`);
      // a live CryptoKey would surface as a non-extractable key object
      assert.notEqual(v?.type, "private", `cel ${key} must not hold a private CryptoKey`);
    }
  }
  // sanity: the public key IS available (as the verb's return), proving the
  // identity is real even though the private half never surfaced.
  assert.ok(pub.length > 0);
});

test("identity() reacts to the secretsGen trigger arg (inputMap doctrine)", async () => {
  // identity(trigger) ignores its arg's VALUE but takes it as a dep; locked vs
  // unlocked flips the output, which is what a referencing cel re-renders on.
  // (Lock/unlock is module-global single-state, so lock explicitly first.)
  const state = await bootVault();
  await resolveFn(state, "vault.lock")(state);
  assert.match(resolveFn(state, "identity")(0), /unlock to see/, "locked, any trigger");
  await unlock(state, "pw");
  assert.ok(resolveFn(state, "identity")(1).length > 0, "unlocked, any trigger → key");
});
