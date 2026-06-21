import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInitialState, resolveFn } from "../dist/index.js";

// =vaultsave(pass)/=vaultload(pass) persist the `secrets` segment to a standalone
// ENCRYPTED file /vault.env.enc in OPFS (node-fs backend here). This proves the
// round trip: store a key → vaultsave → wipe → vaultload → the key is back, and
// the on-disk file is opaque (aes256gcm), never the plaintext secret.

const call = (state, k, ...a) => resolveFn(state, k)(state, ...a);
const SECRET = "sk-ant-TOPSECRET-DEADBEEF";
const PASS = "correct horse battery staple";

// run a formula through origin.run (commits + drains origin.effects → the verb's
// effect handler fires) and return the cell's result text.
const run = async (state, formula) => {
  await call(state, "setValue", "元.draft", formula);
  await call(state, "origin.run", "vault.cell");
  return String(state.cels.get("vault.cell")?.v ?? "");
};

const boot = async () => {
  const state = createInitialState();
  await call(state, "ensureSegments", ["origin", "vault", "file-store"]);
  await resolveFn(state, "hydrate")(state, [], []);
  await call(state, "runCycle");
  await call(state, "vault.unlock", null, { type: "change", target: { value: "hunter2" } });
  await call(state, "vault.set", "anthropic", { type: "change", target: { value: SECRET } });
  return state;
};

test("=vaultsave writes an encrypted /vault.env.enc (never the plaintext secret)", async () => {
  const state = await boot();
  const res = await run(state, `=vaultsave("${PASS}")`);
  assert.match(res, /vault\.env\.enc/, "vaultsave reports the file it wrote");

  const root = state.cels.get("file-store.root")?.v;
  const path = join(root, "vault.env.enc");
  assert.ok(existsSync(path), "/vault.env.enc exists on disk");
  const blob = readFileSync(path, "utf8");
  assert.match(blob, /^aes256gcm:/, "the file is an aes256gcm blob");
  assert.ok(!blob.includes(SECRET), "the plaintext secret is NOT in the file");
});

test("=vaultload restores the secrets from /vault.env.enc after a wipe", async () => {
  const state = await boot();
  await run(state, `=vaultsave("${PASS}")`);
  // wipe the in-memory secret, prove its value is gone
  await call(state, "vault.del", "anthropic");
  assert.ok(!state.cels.get("secrets.anthropic")?.v, "secret value wiped from memory");
  // load it back from the encrypted file (the seal is still unlocked → decrypts)
  const res = await run(state, `=vaultload("${PASS}")`);
  assert.match(res, /loaded the vault/, "vaultload reports success");
  assert.equal(state.cels.get("secrets.anthropic")?.v, SECRET, "the secret value is restored");
});

test("=vaultload with the wrong passphrase refuses (no secret leak)", async () => {
  const state = await boot();
  await run(state, `=vaultsave("${PASS}")`);
  await call(state, "vault.del", "anthropic");
  const res = await run(state, `=vaultload("totally wrong")`);
  assert.match(res, /#DENIED/, "wrong passphrase is refused");
  assert.ok(!state.cels.get("secrets.anthropic")?.v, "no secret restored on a bad passphrase");
});
