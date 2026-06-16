import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, resolveTrust } from "../dist/index.js";
import { bootFromHash } from "../dist/甲骨坑/application/origin/index.js";
import { encodeLink, encodePayload } from "../dist/甲骨坑/application/origin/share-link.js";

// ============================================================================
// quarantine/boot-hash — a #f= / #raw= URL is just a LOCKED seed. bootFromHash
// decodes it and spawns it quarantined; provenance is untrusted, so it boots
// with no capabilities regardless of anything the payload claims.
// ============================================================================

const boot = async () => {
  const state = createInitialState();
  const R = (k) => resolveFn(state, k);
  await R("ensureSegments")(state, ["origin"]);
  await R("hydrate")(state, [], []);
  await R("runCycle")(state);
  await R("origin.commit")(state, "元");
  return state;
};
const settle = async (state) => {
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "origin.effects");
  await resolveFn(state, "runCycle")(state);
};

test("a #f= encoded URL decodes and boots LOCKED, computing a pure seed", async () => {
  const state = await boot();
  const url = await encodeLink("=6+36", { base: "https://plastron.ca/" });
  const seg = await bootFromHash(state, url);
  assert.ok(seg, "a segment was spawned from the hash");
  await settle(state);
  assert.equal(state.cels.get(`${seg}.元`)?.v, 42, "the shared formula ran (jailed)");
  assert.equal(resolveTrust(state, seg).net, false, "untrusted provenance → locked, no net");
  assert.equal(resolveTrust(state, seg).code, false, "…and no code");
});

test("a #raw= human-readable URL boots the same way", async () => {
  const state = await boot();
  const seg = await bootFromHash(state, "#raw=" + encodeURIComponent("=21*2"));
  await settle(state);
  assert.equal(state.cels.get(`${seg}.元`)?.v, 42, "raw formula ran");
  assert.equal(resolveTrust(state, seg).code, false, "still locked");
});

test("a net-using shared formula is #DENIED on boot (jail holds)", async () => {
  const state = await boot();
  const url = await encodeLink(`=chat("hi","k","m","https://api.anthropic.com")`, { base: "" });
  const seg = await bootFromHash(state, url);
  await settle(state);
  const v = state.cels.get(`${seg}.元`)?.v;
  assert.ok(typeof v === "string" && v.startsWith("#DENIED(net"), `net refused from a URL formula (got ${JSON.stringify(v)})`);
});

test("an empty hash spawns nothing", async () => {
  const state = await boot();
  assert.equal(await bootFromHash(state, ""), null, "no hash → no spawn");
  assert.equal(await bootFromHash(state, "#"), null, "bare # → no spawn");
});

test("a payload claiming high trust still boots locked (no self-grant)", async () => {
  const state = await boot();
  // the formula can SAY (needs net) but the url loader ignores it; only a human grant elevates.
  const url = "https://plastron.ca/#f=" + await encodePayload(`(needs "net") =6+36`, "deflate");
  const seg = await bootFromHash(state, url);
  assert.equal(resolveTrust(state, seg).net, false, "request != grant — url stays locked");
});
