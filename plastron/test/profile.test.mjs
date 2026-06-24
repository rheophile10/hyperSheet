import { test } from "bun:test";
import assert from "node:assert/strict";

// profile — the identity-wallet UI (encrypted-collaborative-sheetapp Phase 1).
// Exercises the handler bridge: draft cels → keystore.* → status message + the
// reactive keystore.status cels the profile window renders from. (The render
// verb itself is covered via profileui producing a vnode.)

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-profile";
const { createInitialState, precomputeOptional, resolveFn } = await import("../dist/index.js");

const boot = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["profile", "keystore", "file-store", "window"]);
  await resolveFn(state, "hydrate")(state, [], []);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  return state;
};
const cel = (s, k) => s.cels.get(k)?.v;
const set = (s, k, v) => resolveFn(s, "setValue")(s, k, v);
const dispatch = (s, verb, ev) => resolveFn(s, verb)(s, null, ev);

test("create handler: matching passcodes mint the wallet + reveal the recovery phrase", async () => {
  const s = await boot();
  await set(s, "profile.nm", "Ada");
  await set(s, "profile.p1", "hunter2");
  await set(s, "profile.p2", "hunter2");
  await dispatch(s, "profile.create");
  assert.equal(cel(s, "keystore.status"), "unlocked", "wallet created + unlocked");
  assert.equal(cel(s, "keystore.name"), "Ada");
  assert.ok(cel(s, "keystore.identity")?.length > 20, "public identity surfaced");
  assert.equal(cel(s, "profile.phrase").split(" ").length, 12, "recovery phrase revealed");
  assert.equal(cel(s, "profile.p1"), "", "passcode drafts cleared");
});

test("create handler: mismatched passcodes do NOT create a wallet", async () => {
  const s = await boot();
  await set(s, "profile.p1", "aaaa");
  await set(s, "profile.p2", "bbbb");
  await dispatch(s, "profile.create");
  assert.equal(cel(s, "keystore.status"), "none", "no wallet on mismatch");
  assert.match(cel(s, "profile.msg"), /match/i);
});

test("lock + unlock handlers round-trip; wrong passcode messaged", async () => {
  const s = await boot();
  await set(s, "profile.p1", "correcthorse"); await set(s, "profile.p2", "correcthorse");
  await dispatch(s, "profile.create");
  await dispatch(s, "profile.lock");
  assert.equal(cel(s, "keystore.status"), "locked");
  await set(s, "profile.p1", "nope"); await dispatch(s, "profile.unlock");
  assert.equal(cel(s, "keystore.status"), "locked", "wrong passcode stays locked");
  assert.match(cel(s, "profile.msg"), /wrong/i);
  await set(s, "profile.p1", "correcthorse"); await dispatch(s, "profile.unlock");
  assert.equal(cel(s, "keystore.status"), "unlocked");
});

test("reshuffle handler rotates the identity (history grows)", async () => {
  const s = await boot();
  await set(s, "profile.p1", "p"); await set(s, "profile.p2", "p"); // <4 → fails? min is 4
  await set(s, "profile.p1", "pass"); await set(s, "profile.p2", "pass");
  await dispatch(s, "profile.create");
  const id1 = cel(s, "keystore.identity");
  await dispatch(s, "profile.reshuffle");
  assert.notEqual(cel(s, "keystore.identity"), id1, "identity rotated");
  assert.match(cel(s, "profile.msg"), /history|minted/i);
});

test("profileui renders the create form when status is 'none', unlocked controls when unlocked", async () => {
  const s = await boot();
  const flat = (n, out = []) => { if (n && typeof n === "object") { out.push(n.tag, ...(n.children ?? []).flatMap((c) => (c?.type === "text" ? [c.text] : [])).filter(Boolean)); for (const c of n.children ?? []) flat(c, out); } return out; };
  const none = resolveFn(s, "profileui")("none", "", "", "", "", "", "", "", "");
  assert.ok(JSON.stringify(none).includes("Create identity"), "create form for a new user");
  const un = resolveFn(s, "profileui")("unlocked", "Ada", "ABCDEFGHIJKLMNOP", "", "", "Ada", "", "", "");
  const s2 = JSON.stringify(un);
  assert.ok(s2.includes("Reshuffle") && s2.includes("Export") && s2.includes("Lock"), "unlocked controls render");
  assert.ok(s2.includes("👤") && s2.includes("Ada"), "shows the profile name");
  void flat;
});
