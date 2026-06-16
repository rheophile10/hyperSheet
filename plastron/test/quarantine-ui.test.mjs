import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, resolveTrust, setTrust } from "../dist/index.js";

// ============================================================================
// quarantine/ui — the trust controls: trust(seg,cap,on) / trustOf(seg) verbs,
// the jail(seed) sandboxed-iframe verb, and origin.trust (the 🛡 badge cycle).
// (The pixels are verified in-browser; this proves the logic + the VNode shape.)
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
const callVerb = async (state, formula, slot) => {
  const R = (k) => resolveFn(state, k);
  await R("setValue")(state, "元.draft", formula);
  await R("origin.commit")(state, slot);
  await R("drain")(state, "origin.effects");
  return state.cels.get(slot)?.v;
};

test("trust(seg,cap,false) revokes a capability; trustOf shows the rest", async () => {
  const state = await boot();
  await callVerb(state, `=trust("zone","net",false)`, "t1");
  assert.equal(resolveTrust(state, "zone").net, false, "net revoked for the segment");
  assert.equal(resolveTrust(state, "zone").code, true, "code still inherited from the kernel");
  const r = await callVerb(state, `=trustOf("zone")`, "t2");
  assert.ok(typeof r === "string" && r.includes("code") && !r.includes("net"), `trustOf lists granted caps (got ${r})`);
});

test("trust(seg,cap,true) grants a capability to a locked segment", async () => {
  const state = await boot();
  setTrust(state, "zone", { code: false, net: false, storage: false, secrets: false });
  await callVerb(state, `=trust("zone","net",true)`, "t3");
  assert.equal(resolveTrust(state, "zone").net, true, "net granted");
  assert.equal(resolveTrust(state, "zone").storage, false, "storage still locked");
});

test("trust rejects an unknown capability", async () => {
  const state = await boot();
  const r = await callVerb(state, `=trust("zone","wormhole",true)`, "t4");
  assert.ok(typeof r === "string" && r.startsWith("#DENIED(trust"), `unknown cap refused (got ${r})`);
});

test("jail(seed) returns a sandboxed iframe VNode loading #raw=<seed>", async () => {
  const state = await boot();
  const v = await callVerb(state, `=jail("=cels(3,3)")`, "j1");
  assert.equal(v?.type, "el"); assert.equal(v?.tag, "iframe");
  assert.equal(v?.attrs?.sandbox, "allow-scripts", "allow-scripts WITHOUT allow-same-origin → opaque origin");
  assert.ok(!/allow-same-origin/.test(String(v?.attrs?.sandbox)), "never same-origin (that would un-jail it)");
  assert.match(String(v?.attrs?.src), /#raw=%3Dcels\(3%2C3\)/, "boots this page with the seed in #raw=");
});

test("origin.trust cycles a segment's preset locked → compute → net → trusted → locked", async () => {
  const state = await boot();
  setTrust(state, "zone", { code: false, net: false, storage: false, secrets: false }); // locked
  const cycle = resolveFn(state, "origin.trust");
  await cycle(state, "zone"); // → compute (code only)
  assert.deepEqual([resolveTrust(state, "zone").code, resolveTrust(state, "zone").net], [true, false], "compute: code on, net off");
  await cycle(state, "zone"); // → net
  assert.equal(resolveTrust(state, "zone").net, true, "net granted");
  await cycle(state, "zone"); // → trusted
  assert.equal(resolveTrust(state, "zone").storage, true, "trusted: storage on");
  await cycle(state, "zone"); // → locked
  assert.equal(resolveTrust(state, "zone").code, false, "wrapped back to locked");
});
