import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// ============================================================================
// REACTIVE ARMING: a client cel made from a wallet apiKey handle must re-fire
// when a key lands. apiKey() is a NATIVE verb — it reads `secrets` INTERNALLY,
// so a key change wires NO formula-dep edge and (before the fix) never re-fired
// the client cels: they stayed error:✗ no key until something forced a recompute.
//
// The fix: the wallet owns a `secretsGen` version cel, bumped on every
// unlock/lock/setKey/del. The client formula references it INSIDE the apiKey
// call — (makeclient "claude" (apiKey "anthropic" secretsGen)) — so extractDeps
// wires the edge and runCycle re-arms the client. This test proves:
//   • boot (no key) → client status error
//   • setKey → secretsGen bumps → the client cel re-evaluates → ready
//   • del key → secretsGen bumps → the client cel re-evaluates → error
// all WITHOUT any manual re-fire of the client cel.
// ============================================================================

const seg = (state, key, spec) =>
  resolveFn(state, "setCel")(state, key, { ...spec, metadata: { key, ...spec.metadata } });
const cycle = (state) => resolveFn(state, "runCycle")(state);
const call = (state, k, ...a) => resolveFn(state, k)(state, ...a);

const SECRET = "sk-ant-REARM-TOPSECRET";

const bootWallet = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["unsafe-wallet", "llm"]);
  // unlock (no key yet) — a new wallet
  await call(state, "wallet.unlock", null, { type: "change", target: { value: "hunter2" } });
  // a CLIENT cel in the whitelisted `clients` segment, armed from the wallet
  // via apiKey — referencing secretsGen so a key change re-fires it.
  await seg(state, "clients.A1", {
    celType: "FormulaCel", f: '(makeclient "claude" (apiKey "anthropic" secretsGen))',
    metadata: { segment: "clients", name: "A1", parser: "f" },
  });
  await cycle(state);
  return state;
};

test("secretsGen is bumped by setKey/del and the client cel re-arms through the graph", async () => {
  const state = await bootWallet();

  // the client cel is wired to depend on secretsGen (extractDeps read the
  // formula; the deps land as _inputEntries [key, cel] pairs)
  const inputs = (state.cels.get("clients.A1")?._inputEntries ?? []).map(([k]) => k);
  assert.ok(inputs.includes("secretsGen"), "the client cel depends on secretsGen (inputMap edge)");

  // boot: no key yet → the client is in error
  const before = state.cels.get("clients.A1")?.v;
  assert.equal(before?.__client, true, "clients.A1 is a client handle");
  assert.equal(before?.status, "error", "no key at boot → error");
  assert.equal(before?.error, "✗ no key", "the non-secret error reads ✗ no key");

  const genBefore = Number(state.cels.get("secretsGen")?.v ?? -1);

  // set the key — the wallet stores it AND bumps secretsGen
  await call(state, "wallet.set", "anthropic", { type: "change", target: { value: SECRET } });
  const genAfter = Number(state.cels.get("secretsGen")?.v ?? -1);
  assert.ok(genAfter > genBefore, "setKey bumped secretsGen (the trigger advanced)");

  // the bump propagated through runCycle (note() drains) — the client re-armed
  await cycle(state);
  const armed = state.cels.get("clients.A1")?.v;
  assert.equal(armed?.status, "ready", "setting the key RE-ARMED the client (error → ready), no manual re-fire");
  assert.equal(armed?.error, undefined, "no error once armed");
  // and the secret is still NOT in the cel value
  assert.ok(!JSON.stringify(armed).includes(SECRET), "the key is never in the client cel value");

  // remove the key — the wallet blanks it AND bumps secretsGen
  const genArmed = Number(state.cels.get("secretsGen")?.v ?? -1);
  await call(state, "wallet.del", "anthropic");
  assert.ok(Number(state.cels.get("secretsGen")?.v ?? -1) > genArmed, "del bumped secretsGen");
  await cycle(state);
  const disarmed = state.cels.get("clients.A1")?.v;
  assert.equal(disarmed?.status, "error", "removing the key flipped the client back to error");

  await resolveFn(state, "wallet.lock")(state);
});

test("locking the wallet bumps secretsGen and disarms an armed client", async () => {
  const state = await bootWallet();
  await call(state, "wallet.set", "anthropic", { type: "change", target: { value: SECRET } });
  await cycle(state);
  assert.equal(state.cels.get("clients.A1")?.v?.status, "ready", "armed after setKey");

  const genReady = Number(state.cels.get("secretsGen")?.v ?? -1);
  await resolveFn(state, "wallet.lock")(state);
  assert.ok(Number(state.cels.get("secretsGen")?.v ?? -1) > genReady, "lock bumped secretsGen");
  await cycle(state);
  assert.equal(state.cels.get("clients.A1")?.v?.status, "error", "locking disarmed the client");
});
