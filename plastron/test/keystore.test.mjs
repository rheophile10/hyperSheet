import { test } from "bun:test";
import assert from "node:assert/strict";

// keystore — the identity wallet (encrypted-collaborative-sheetapp Phase 1).
// Exercises the EXTRACTABLE wallet lifecycle against the node file-store backend
// (the OPFS twin): create → seal → persist → unlock → reshuffle → changePasscode
// → export/import. The keyring + private keys live module-scope (never a cel);
// only non-secret status cels (keystore.status/.name/.identity/.ecdhpub) appear.

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-keystore";
const { createInitialState, precomputeOptional, resolveFn } = await import("../dist/index.js");

const boot = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["keystore", "file-store"]);
  await resolveFn(state, "hydrate")(state, [], []);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  return state;
};
const cel = (s, k) => s.cels.get(k)?.v;
const R = (s, k) => resolveFn(s, k);

test("create mints an EXTRACTABLE wallet, seals it, unlocks, and surfaces only public status", async () => {
  const s = await boot();
  const r = await R(s, "keystore.create")(s, "hunter2", "Ada");
  assert.equal(r.ok, true, "create ok");
  assert.equal(r.persisted, true, "persisted to the (node) OPFS backend");
  assert.equal(r.phrase.split(" ").length, 12, "returns a 12-word recovery phrase");
  assert.equal(cel(s, "keystore.status"), "unlocked");
  assert.equal(cel(s, "keystore.name"), "Ada");
  assert.ok(cel(s, "keystore.identity")?.length > 20, "public Ed25519 identity surfaced");
  assert.ok(cel(s, "keystore.ecdhpub")?.length > 20, "public ECDH key surfaced");
  // the secret never leaks into a cel: every keystore.* cel VALUE carries only
  // public/status data (the keyring + private keys live module-scope).
  for (const [k, c] of s.cels) {
    if (!k.startsWith("keystore.")) continue;
    const v = JSON.stringify(c.v ?? "");
    assert.ok(!/Priv|"ecdhPriv"|"signPriv"|pkcs8/i.test(v), `${k} carries no private material (${v.slice(0, 40)})`);
  }
});

test("create refuses a too-short passcode", async () => {
  const s = await boot();
  const r = await R(s, "keystore.create")(s, "no");
  assert.equal(r.ok, false);
  assert.match(r.error, /UNRECOVERABLE|>=4|≥4/);
});

test("lock + unlock: wrong passcode rejected, right passcode restores the identity", async () => {
  const s = await boot();
  const c = await R(s, "keystore.create")(s, "correcthorse", "Bob");
  const id = c.identity;
  await R(s, "keystore.lock")(s);
  assert.equal(cel(s, "keystore.status"), "locked", "locked (a blob persists)");
  assert.equal(cel(s, "keystore.identity"), "", "identity cleared while locked");
  const bad = await R(s, "keystore.unlock")(s, "wrong");
  assert.equal(bad.ok, false, "wrong passcode rejected");
  const good = await R(s, "keystore.unlock")(s, "correcthorse");
  assert.equal(good.ok, true);
  assert.equal(good.identity, id, "same identity after unlock");
  assert.equal(cel(s, "keystore.status"), "unlocked");
});

test("reshuffle mints a NEW current key and retires the old into history", async () => {
  const s = await boot();
  const c = await R(s, "keystore.create")(s, "passcode1", "Carol");
  const id1 = c.identity;
  const r = await R(s, "keystore.reshuffle")(s);
  assert.equal(r.ok, true);
  assert.equal(r.history, 1, "old pair retired into history (1 entry)");
  assert.notEqual(r.identity, id1, "current identity rotated");
  assert.equal(cel(s, "keystore.identity"), r.identity, "status cel reflects the new identity");
});

test("changePasscode: old passcode stops working, new one unlocks", async () => {
  const s = await boot();
  await R(s, "keystore.create")(s, "oldpass", "Dave");
  const ch = await R(s, "keystore.changePasscode")(s, "oldpass", "newpass");
  assert.equal(ch.ok, true);
  await R(s, "keystore.lock")(s);
  assert.equal((await R(s, "keystore.unlock")(s, "oldpass")).ok, false, "old passcode no longer unlocks");
  assert.equal((await R(s, "keystore.unlock")(s, "newpass")).ok, true, "new passcode unlocks");
});

test("export → import round-trips the wallet through a file (the file:// path)", async () => {
  const s = await boot();
  const c = await R(s, "keystore.create")(s, "filepass", "Erin");
  const id = c.identity;
  const blob = await R(s, "keystore.export")(s);
  assert.equal(typeof blob, "string");
  const parsed = JSON.parse(blob);
  assert.ok(parsed.kdf?.salt && parsed.iv && parsed.ct, "sealed blob shape {kdf,iv,ct}");
  assert.ok(!/priv/i.test(blob), "the exported blob is ciphertext — no plaintext private material");
  await R(s, "keystore.lock")(s);                       // simulate a fresh device
  const bad = await R(s, "keystore.import")(s, blob, "wrong");
  assert.equal(bad.ok, false, "import rejects the wrong passcode");
  const good = await R(s, "keystore.import")(s, blob, "filepass");
  assert.equal(good.ok, true);
  assert.equal(good.identity, id, "imported wallet has the same identity");
  assert.equal(good.name, "Erin");
});

test("seedPhrase returns 12 words when unlocked, refuses when locked", async () => {
  const s = await boot();
  await R(s, "keystore.create")(s, "seedpass");
  const p = await R(s, "keystore.seedPhrase")(s);
  assert.equal(p.ok, true);
  assert.equal(p.phrase.split(" ").length, 12);
  await R(s, "keystore.lock")(s);
  assert.equal((await R(s, "keystore.seedPhrase")(s)).ok, false, "locked → no phrase");
});
