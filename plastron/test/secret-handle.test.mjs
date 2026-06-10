import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";
import { secretHandle, isSecretHandle, isSecretHandleRef } from "../dist/kernel/secret.js";

// SecretHandle — the kernel guarantee that a secret never enters an archive.
// A handle carries a NAME + a resolver closure (the wallet provides it); the
// kernel's dehydrate sanitizes a handle-valued cel to its name only, so the
// secret (and the resolver that could reach it) is never persisted.

const mk = (name, dependencies = []) => ({ name, version: "0.0.1", description: "test", dependencies });

test("a handle carries a name + a resolver that works only at the effect site", () => {
  const h = secretHandle("anthropic", () => "sk-ant-SECRET");
  assert.equal(isSecretHandle(h), true);
  assert.equal(h.name, "anthropic");
  assert.equal(h.resolve(), "sk-ant-SECRET");
});

test("dehydrate persists a handle-valued cel as its NAME only — never the secret", async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const dehydrate = resolveFn(state, "dehydrate");
  const setValue = resolveFn(state, "setValue");

  await hydrate(state, [{
    name: "user",
    cels: [{ key: "k", celType: "ValueCel", metadata: { key: "k", segment: "user" } }],
  }], [mk("user")]);

  // store a live handle whose resolver closes over a real secret
  await setValue(state, "k", secretHandle("anthropic", () => "sk-ant-TOPSECRET"));

  const dehydrated = await dehydrate(state);

  // the whole archive must never contain the secret value
  assert.ok(!JSON.stringify(dehydrated).includes("TOPSECRET"), "the secret must not appear anywhere in the archive");

  // the handle cel persists as the name-only ref — marker + name, nothing else
  const userSeg = dehydrated.segments.find((s) => s.name === "user");
  const kCel = userSeg.cels.find((c) => c.key === "k");
  assert.deepEqual(kCel.metadata.v, { __secretHandle: true, name: "anthropic" }, "persisted as name-only ref");
  assert.equal(Object.keys(kCel.metadata.v).length, 2, "exactly two keys — no resolver, no secret");
  assert.equal(isSecretHandleRef(kCel.metadata.v), true, "ref carries the marker (renders as 🔑 anthropic)");
  assert.equal(isSecretHandle(kCel.metadata.v), false, "a rehydrated ref is NOT a live handle — it cannot resolve");
});
