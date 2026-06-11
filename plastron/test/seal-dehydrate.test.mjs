import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, setAccessPolicy } from "../dist/index.js";

// Layer-2 — encrypted dehydrate of SEALED segments (segment-access-capabilities.md).
//
// A SEALED segment's cel value is plaintext on disk today; Layer 2 encrypts it.
// The kernel stays STATELESS + ZERO-DEP: it only knows the marker shape
// ({ __sealed: "ivB64.cipherB64" }) and calls two LIBRARY-provided hooks on
// state (sealCipher / sealDecipher). The `seal` library installs them via
// seal.lock(password) (PBKDF2 → AES-256-GCM, synchronous zero-dep).
//
// Contract exercised here:
//   1. lock(pw) + dehydrate → the secret appears as { __sealed: … } ciphertext,
//      NEVER as plaintext (the archive carries no secret).
//   2. fresh state + lock(pw) + hydrate → the secret decrypts back.
//   3. WRONG password (or none) → it stays sealed / unreadable.

const mk = (name, dependencies = []) => ({ name, version: "0.0.1", description: "test", dependencies });
const SECRET = "sk-live-DEADBEEF-super-secret-api-key";

// Build a state with a SEALED "vault" segment holding a secret value cel.
const sealedState = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["seal"]);
  const hydrate = resolveFn(state, "hydrate");
  await hydrate(state, [{
    name: "vault",
    cels: [
      { key: "vault.key", celType: "ValueCel", metadata: { key: "vault.key", segment: "vault", v: SECRET } },
      { key: "vault.note", celType: "ValueCel", metadata: { key: "vault.note", segment: "vault", v: { a: 1, b: "two" } } },
    ],
  }], [mk("vault")]);
  // SEAL the get direction (the declared list is authoritative; this is what
  // makes the segment encrypt at rest).
  setAccessPolicy(state, "vault", { get: ["clientmaker"], getSealed: true });
  return state;
};

test("locked dehydrate writes ciphertext markers, NEVER the plaintext secret", async () => {
  const state = await sealedState();
  await resolveFn(state, "seal.lock")(state, "correct horse battery staple");

  const archive = JSON.parse(JSON.stringify(await resolveFn(state, "dehydrate")(state)));
  const flat = JSON.stringify(archive);

  // the secret never appears anywhere in the archive
  assert.equal(flat.includes(SECRET), false, "plaintext secret must not be in the archive");

  // the secret cel persists as a { __sealed: "ivB64.cipherB64" } marker
  const seg = archive.segments.find((s) => s.name === "vault");
  const keyCel = seg.cels.find((c) => c.key === "vault.key");
  const sealedV = keyCel.metadata.v;
  assert.equal(typeof sealedV?.__sealed, "string", "secret cel is a sealed marker");
  assert.match(sealedV.__sealed, /^[^.]+\.[^.]+$/, "marker envelope is ivB64.cipherB64");

  // the object-valued cel is sealed too (no 'two' leaking)
  const noteCel = seg.cels.find((c) => c.key === "vault.note");
  assert.equal(typeof noteCel.metadata.v?.__sealed, "string", "object cel sealed too");
  assert.equal(flat.includes("\"two\""), false, "no nested plaintext leaks");
});

test("fresh state + lock(same pw) + hydrate decrypts the secret back", async () => {
  const state = await sealedState();
  await resolveFn(state, "seal.lock")(state, "pw-12345");
  const archive = JSON.parse(JSON.stringify(await resolveFn(state, "dehydrate")(state)));

  const fresh = createInitialState();
  await resolveFn(fresh, "ensureSegments")(fresh, ["seal"]);
  await resolveFn(fresh, "seal.lock")(fresh, "pw-12345");          // same password → same data key
  await resolveFn(fresh, "hydrate")(fresh, archive.segments, archive.manifests);

  assert.equal(fresh.cels.get("vault.key")?.v, SECRET, "secret decrypts back on hydrate");
  assert.deepEqual(fresh.cels.get("vault.note")?.v, { a: 1, b: "two" }, "object cel decrypts back");
});

test("WRONG password → the value stays sealed / unreadable", async () => {
  const state = await sealedState();
  await resolveFn(state, "seal.lock")(state, "the-right-password");
  const archive = JSON.parse(JSON.stringify(await resolveFn(state, "dehydrate")(state)));

  const fresh = createInitialState();
  await resolveFn(fresh, "ensureSegments")(fresh, ["seal"]);
  await resolveFn(fresh, "seal.lock")(fresh, "WRONG-password");    // wrong key → AEAD auth fails
  await resolveFn(fresh, "hydrate")(fresh, archive.segments, archive.manifests);

  const v = fresh.cels.get("vault.key")?.v;
  assert.equal(typeof v?.__sealed, "string", "wrong password leaves the marker sealed");
  assert.notEqual(v?.__sealed, undefined);
  assert.notEqual(JSON.stringify(v), JSON.stringify(SECRET), "secret is NOT recovered with the wrong password");
});

test("NO password (locked) → the value stays sealed / unreadable", async () => {
  const state = await sealedState();
  await resolveFn(state, "seal.lock")(state, "open-sesame");
  const archive = JSON.parse(JSON.stringify(await resolveFn(state, "dehydrate")(state)));

  const fresh = createInitialState();
  await resolveFn(fresh, "ensureSegments")(fresh, ["seal"]);
  // never unlock → no sealDecipher hook → marker left intact
  assert.equal(resolveFn(fresh, "seal.locked")(fresh), true, "fresh state is locked");
  await resolveFn(fresh, "hydrate")(fresh, archive.segments, archive.manifests);

  const v = fresh.cels.get("vault.key")?.v;
  assert.equal(typeof v?.__sealed, "string", "locked load leaves the marker sealed");
});

test("non-sealed segment is unaffected by the hook (plaintext round-trips)", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["seal"]);
  await resolveFn(state, "hydrate")(state, [{
    name: "plain",
    cels: [{ key: "p.v", celType: "ValueCel", metadata: { key: "p.v", segment: "plain", v: "visible" } }],
  }], [mk("plain")]);
  await resolveFn(state, "seal.lock")(state, "any-password");      // hook ON, but segment is not sealed

  const archive = JSON.parse(JSON.stringify(await resolveFn(state, "dehydrate")(state)));
  const cel = archive.segments.find((s) => s.name === "plain").cels.find((c) => c.key === "p.v");
  assert.equal(cel.metadata.v, "visible", "unsealed segment value stays plaintext");
});

test("re-lock (seal.lock with no arg) clears the hooks", async () => {
  const state = await sealedState();
  const lock = resolveFn(state, "seal.lock");
  await lock(state, "pw");
  assert.equal(resolveFn(state, "seal.locked")(state), false, "unlocked after lock(pw)");
  await lock(state);                                           // no arg → clear
  assert.equal(resolveFn(state, "seal.locked")(state), true, "re-locked after lock()");

  // with the hooks cleared, dehydrate leaves the sealed segment's value PLAINTEXT
  // (Layer-2 only encrypts while unlocked; a locked process can't seal).
  const archive = JSON.parse(JSON.stringify(await resolveFn(state, "dehydrate")(state)));
  const cel = archive.segments.find((s) => s.name === "vault").cels.find((c) => c.key === "vault.key");
  assert.equal(cel.metadata.v, SECRET, "no cipher hook → value not sealed");
});
