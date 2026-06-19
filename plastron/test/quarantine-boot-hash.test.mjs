import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, resolveTrust, kernelTrust } from "../dist/index.js";
import { bootFromHash } from "../dist/甲骨坑/application/origin/index.js";
import { encodeLink, encodePayload } from "../dist/甲骨坑/application/origin/share-link.js";

// ============================================================================
// quarantine/boot-hash — a #f= / #raw= URL is UNTRUSTED: the whole kernel is
// LOCKED and the shared formula BECOMES 元 (the main view), so a stranger's
// plastron renders jailed. The page can't self-grant; only a human (🛡) elevates.
// ============================================================================

const boot = async () => {
  const state = createInitialState();
  const R = (k) => resolveFn(state, k);
  await R("ensureSegments")(state, ["origin"]);
  await R("hydrate")(state, [], []);
  await R("runCycle")(state);
  return state;
};
const settle = async (state) => {
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "origin.effects");
  await resolveFn(state, "runCycle")(state);
};
const 元 = (state) => state.cels.get("元")?.v;

test("a #f= URL locks the kernel and makes the shared formula 元", async () => {
  const state = await boot();
  const ret = await bootFromHash(state, await encodeLink("=6+36", { base: "https://plastron.ca/" }));
  assert.equal(ret, "=6+36", "returns the shared formula (truthy → host skips the desktop)");
  await settle(state);
  assert.equal(元(state), 42, "the shared formula IS 元 — it renders jailed");
  assert.equal(kernelTrust(state).net, false, "kernel tier locked: no net");
  assert.equal(kernelTrust(state).code, false, "…no code");
});

test("a #raw= human-readable URL boots the same way", async () => {
  const state = await boot();
  await bootFromHash(state, "#raw=" + encodeURIComponent("=21*2"));
  await settle(state);
  assert.equal(元(state), 42, "raw formula became 元");
  assert.equal(kernelTrust(state).storage, false, "kernel locked");
});

test("a net-using shared formula is refused on a URL boot (consent-locked)", async () => {
  const state = await boot();
  // a URL boot consent-LOCKS the session, so a dangerous verb (chat → net) is
  // #BLACKLISTED until the user Allows it via the consent panel.
  await bootFromHash(state, await encodeLink(`=chat("hi","k","m","https://api.anthropic.com")`, { base: "" }));
  await settle(state);
  const v = 元(state);
  assert.ok(typeof v === "string" && v.startsWith("#BLACKLISTED"), `net refused (got ${JSON.stringify(v)})`);
});

test("NO hash → the kernel stays FULL (normal desktop boot)", async () => {
  const state = await boot();
  assert.equal(await bootFromHash(state, ""), null, "empty hash → no takeover");
  assert.equal(await bootFromHash(state, "#"), null, "bare # → no takeover");
  assert.equal(kernelTrust(state).net, true, "kernel untouched — full trust for the local session");
});

test("a payload claiming high trust still boots locked (no self-grant)", async () => {
  const state = await boot();
  const url = "https://plastron.ca/#f=" + await encodePayload(`(needs "net") =6+36`, "deflate");
  await bootFromHash(state, url);
  assert.equal(kernelTrust(state).net, false, "request != grant — a URL formula cannot open net for itself");
});
