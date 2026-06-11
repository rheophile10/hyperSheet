import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// crypto — the foundational crypto library (WebCrypto, zero-dep, Bun + browser).
// These CLI tests exercise the SUBTLE operations + THE KEY MODEL: keygen returns
// a CryptoKeyHandle (id + PUBLIC material), the private key never surfaces as
// bytes, and resolution happens at the effect site (sign / decrypt / unwrap)
// against the Bun keystore adapter. The browser tiers — non-extractable
// IndexedDB storage (Tier 1 browser side) and WebAuthn PRF (Tier 2) — are e2e
// follow-ups, NOT CLI-tested (Bun has no IndexedDB / no passkey).

// Load the crypto library into a fresh state and return its verb resolvers.
const boot = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["crypto"]);
  const fn = (k) => resolveFn(state, k);
  return { state, fn };
};

test("keygen → sign/verify round-trip (Ed25519); tamper fails", async () => {
  const { fn } = await boot();
  const handle = await fn("crypto.keygen")("sign");
  assert.equal(handle.__cryptoKeyHandle, true, "keygen returns a CryptoKeyHandle");
  assert.equal(handle.kind, "sign");
  assert.equal(typeof handle.id, "string");
  assert.equal(typeof handle.publicKey, "string");

  const msg = "the medium is the message";
  const sig = await fn("crypto.sign")(handle, msg);
  assert.equal(typeof sig, "string");

  // verify against the handle (carries the public key) and against the raw pubkey
  assert.equal(await fn("crypto.verify")(handle, msg, sig), true, "verify via handle");
  const pub = await fn("crypto.pubkey")(handle);
  assert.equal(await fn("crypto.verify")(pub, msg, sig), true, "verify via raw public key");

  // tampered message must NOT verify
  assert.equal(await fn("crypto.verify")(handle, msg + "!", sig), false, "tamper rejected");
});

test("encrypt → decrypt round-trip (AES-256-GCM); wrong key fails", async () => {
  const { fn } = await boot();
  const dk = await fn("crypto.datakey")();
  assert.equal(typeof dk, "string");

  const plain = "wrap the data key per epoch";
  const env = await fn("crypto.encrypt")(dk, plain);
  assert.match(env, /^[^.]+\.[^.]+$/, "envelope is ivB64.cipherB64");
  assert.equal(await fn("crypto.decrypt")(dk, env), plain, "decrypt recovers plaintext");

  // a different data key cannot decrypt (AEAD auth fails)
  const dk2 = await fn("crypto.datakey")();
  await assert.rejects(() => Promise.resolve(fn("crypto.decrypt")(dk2, env)), "wrong key rejected");
});

test("ECDH wrap → unwrap a data key between two identities (P-256)", async () => {
  const { fn } = await boot();
  // Alice + Bob each mint an ECDH key (non-extractable private, public on handle)
  const alice = await fn("crypto.keygen")("ecdh");
  const bob = await fn("crypto.keygen")("ecdh");
  assert.equal(alice.kind, "ecdh");

  const dataKey = await fn("crypto.datakey")();
  // Alice wraps the data key TO Bob's public key…
  const wrapped = await fn("crypto.wrap")(alice, bob.publicKey, dataKey);
  // …Bob unwraps with HIS private + Alice's public → same data key.
  const unwrapped = await fn("crypto.unwrap")(bob, alice.publicKey, wrapped);
  assert.equal(unwrapped, dataKey, "ECDH wrap/unwrap recovers the data key");

  // end-to-end: Alice encrypts content with the data key, Bob decrypts after unwrap
  const env = await fn("crypto.encrypt")(dataKey, "shared segment payload");
  assert.equal(await fn("crypto.decrypt")(unwrapped, env), "shared segment payload");
});

test("THE KEY MODEL: the private key is NEVER exposed as bytes", async () => {
  const { fn } = await boot();
  const handle = await fn("crypto.keygen")("sign");

  // 1. the handle carries only id + kind + PUBLIC key — no private material.
  const keys = Object.keys(handle);
  assert.deepEqual(keys.sort(), ["__cryptoKeyHandle", "id", "kind", "publicKey"]);
  const json = JSON.stringify(handle);
  assert.ok(!/private|secret/i.test(json), "serialized handle has no private/secret field");

  // 2. crypto.keys() lists the keyring as handles — public material only.
  const listed = await fn("crypto.keys")();
  assert.ok(Array.isArray(listed) && listed.length >= 1);
  for (const h of listed) {
    assert.equal(h.__cryptoKeyHandle, true);
    assert.ok(!("privateKey" in h), "no privateKey on a listed handle");
  }

  // 3. sign still WORKS — proving the private key is usable in place though it
  //    was never surfaced (the SecretHandle-style effect-site resolution).
  const sig = await fn("crypto.sign")(handle, "in-place use");
  assert.equal(await fn("crypto.verify")(handle, "in-place use", sig), true);

  // 4. forget drops it; a stale handle can no longer resolve to a private key.
  assert.equal(await fn("crypto.forget")(handle), true, "forget reports it existed");
  await assert.rejects(() => Promise.resolve(fn("crypto.sign")(handle, "x")), "signing a forgotten key fails");
});

test("Tier 2 (WebAuthn PRF) is scaffolded: unavailable in Bun, reports status", async () => {
  const { fn } = await boot();
  assert.equal(await fn("crypto.prfAvailable")(), false, "no WebAuthn PRF in Bun");
  const msg = await fn("crypto.prfWrapKey")();
  assert.match(msg, /unavailable|scaffold/, "prfWrapKey reports status instead of throwing");
});

test("Tier 3 (seed phrase) is recovery-only: export → import round-trip validates", async () => {
  const { fn } = await boot();
  const phrase = await fn("crypto.seedExport")();
  const words = phrase.split(" ");
  assert.equal(words.length, 12, "a 12-word recovery phrase");
  const res = await fn("crypto.seedImport")(phrase);
  assert.match(res, /accepted/, "a valid phrase is accepted");
  assert.match(await fn("crypto.seedImport")("not enough words"), /expected/, "short phrase rejected");
});
