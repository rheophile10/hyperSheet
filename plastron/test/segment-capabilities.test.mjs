import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, resolveFn, precompute, precomputeOptional,
  setAccessPolicy, bundleSegments, withAccessor, isDenied,
} from "../dist/index.js";

// ============================================================================
// segment-access-capabilities — Layer 1 (in-process closures).
//
// The model under test:
//   • Every segment has a get/set policy. DEFAULT: get public, set
//     private (self only). A direction may be SEALED — no bundle grant
//     widens it.
//   • SET choke point: setValue/setCel writing segment B by accessor A is
//     refused unless A ∈ B.set.
//   • GET choke point: a formula read of a cel in segment B by accessor A
//     resolves to #DENIED (no edge to the real value forms) unless
//     A ∈ B.get.
//   • Bundles widen get/set between members EXCEPT a sealed direction.
//
// The wallet flow: wallet holds wallet.key; get sealed to [clientmaker];
// set private. chat can never read wallet.key (not listed, sealed).
// clientmaker can (it's listed).
// ============================================================================

// Re-resolve every consumer's input closures against the current policy /
// bundle registry, then fire the cascade. precompute rebuilds
// _inputEntries through the GET gate (denied refs become the #DENIED
// sentinel cel); precomputeOptional rebuilds the codegen _evaluate
// closures over those entries; runCycle recomputes the values.
const settle = async (state) => {
  precompute(state);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
};

// Boot a state with three segments — wallet, clientmaker, chat — plus a
// reader formula in each consuming segment, declare the policies, then
// settle the graph.
const boot = async () => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");

  const cels = [
    // wallet.key lives in segment "wallet".
    { key: "wallet.key", celType: "ValueCel",
      metadata: { key: "wallet.key", segment: "wallet", v: "s3cret" } },
    // clientmaker.client lives in segment "clientmaker".
    { key: "clientmaker.client", celType: "ValueCel",
      metadata: { key: "clientmaker.client", segment: "clientmaker", v: "CLIENT" } },
    // A reader in clientmaker that references wallet.key (bare symbol →
    // resolves to that cel's value).
    { key: "cm.read-wallet", celType: "FormulaCel",
      metadata: { key: "cm.read-wallet", segment: "clientmaker", parser: "f" },
      f: "wallet.key" },
    // A reader in chat that references wallet.key.
    { key: "chat.read-wallet", celType: "FormulaCel",
      metadata: { key: "chat.read-wallet", segment: "chat", parser: "f" },
      f: "wallet.key" },
    // A reader in chat that references clientmaker.client.
    { key: "chat.read-client", celType: "FormulaCel",
      metadata: { key: "chat.read-client", segment: "chat", parser: "f" },
      f: "clientmaker.client" },
  ];

  const seg = { name: "app", cels };
  const manifest = { name: "app", version: "0.0.1", description: "test", dependencies: [] };
  await hydrate(state, [seg], [manifest]);

  // wallet: get SEALED to [clientmaker]; set private (the default).
  setAccessPolicy(state, "wallet", { get: ["clientmaker"], getSealed: true, set: "private" });
  // clientmaker: get a private list that excludes chat (NOT sealed) — so
  // chat needs the bundle grant to read clientmaker.client.
  setAccessPolicy(state, "clientmaker", { get: [] });

  await settle(state);
  return state;
};

// ── 1. wallet-unreachable-from-chat ──────────────────────────────────────────
test("wallet.key reads #DENIED from chat, RESOLVES from clientmaker", async () => {
  const state = await boot();

  // clientmaker IS in wallet's get-list → the read resolves to the value.
  const cmRead = state.cels.get("cm.read-wallet")?.v;
  assert.equal(cmRead, "s3cret", "clientmaker (in wallet.get) should read the real value");
  assert.equal(isDenied(cmRead), false);

  // chat is NOT in wallet's get-list → #DENIED, no edge to the value.
  const chatRead = state.cels.get("chat.read-wallet")?.v;
  assert.equal(isDenied(chatRead), true, "chat must read #DENIED for wallet.key");
  assert.notEqual(chatRead, "s3cret");
});

// ── 2. set-refusal ───────────────────────────────────────────────────────────
test("writing wallet.key is refused from chat, allowed from wallet itself", async () => {
  const state = await boot();
  const setValue = resolveFn(state, "setValue");

  // A write attributed to segment "chat" must be refused (wallet.set is
  // private — only wallet writes).
  await assert.rejects(
    () => withAccessor(state, "chat", () => setValue(state, "wallet.key", "stolen")),
    /set policy refuses it/,
    "chat must not be able to write wallet.key",
  );
  assert.equal(state.cels.get("wallet.key")?.v, "s3cret", "value unchanged after refused write");

  // A write attributed to wallet's own segment is allowed.
  await withAccessor(state, "wallet", () => setValue(state, "wallet.key", "rotated"));
  assert.equal(state.cels.get("wallet.key")?.v, "rotated", "wallet may write its own cel");

  // Top-level / host (no accessor) is privileged.
  await setValue(state, "wallet.key", "host-set");
  assert.equal(state.cels.get("wallet.key")?.v, "host-set");
});

// ── 3. bundle grant but sealing holds ────────────────────────────────────────
test("bundling chat+clientmaker lets chat read clientmaker.client; wallet stays sealed", async () => {
  const state = await boot();

  // Before the bundle, chat cannot read clientmaker.client (clientmaker's
  // get-list is empty and chat isn't in it).
  assert.equal(
    isDenied(state.cels.get("chat.read-client")?.v), true,
    "chat read of clientmaker.client should be #DENIED before bundling",
  );

  // Bundle chat + clientmaker — clientmaker's get is NOT sealed, so the
  // grant widens it. Re-settle so closures rebuild through the gate.
  bundleSegments(state, ["chat", "clientmaker"]);
  await settle(state);

  assert.equal(
    state.cels.get("chat.read-client")?.v, "CLIENT",
    "after bundling, chat reads clientmaker.client",
  );

  // The bundle does NOT widen wallet — its get is SEALED. chat still reads
  // #DENIED (chat is not bundled with wallet, and even if it were, sealed
  // holds).
  assert.equal(
    isDenied(state.cels.get("chat.read-wallet")?.v), true,
    "sealed wallet.get is unaffected by the chat/clientmaker bundle",
  );

  // Even bundling chat WITH wallet must not grant the sealed get.
  bundleSegments(state, ["chat", "wallet"]);
  await settle(state);
  assert.equal(
    isDenied(state.cels.get("chat.read-wallet")?.v), true,
    "a chat/wallet bundle cannot widen wallet's SEALED get",
  );
});
