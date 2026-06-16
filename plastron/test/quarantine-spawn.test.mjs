import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, resolveTrust, setTrust } from "../dist/index.js";

// ============================================================================
// quarantine/spawn — `=kernel(seed, preset)` spawns a child plastron as a
// QUARANTINED segment seeded with a formula. Its cells live under <seg>.*; a
// gated capability is #DENIED for that segment unless the preset granted it.
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
const spawn = async (state, seedFormula, preset) => {
  const R = (k) => resolveFn(state, k);
  await R("setValue")(state, "元.draft", `=kernel(${JSON.stringify(seedFormula)}, ${JSON.stringify(preset)})`);
  const slot = `spawn_${preset}_${seedFormula.length}`;
  await R("origin.commit")(state, slot);
  await R("drain")(state, "origin.effects");   // originKernel → creates app_.元
  await R("runCycle")(state);                    // app_.元 fires (may emit its own effect)
  await R("drain")(state, "origin.effects");     // a chat/save seed's effect drains here
  await R("runCycle")(state);
  return [...state.cels.keys()].map((k) => k.match(/^(app\d+)\.元$/)?.[1]).filter(Boolean).pop();
};

test("a locked spawn's segment resolves to no capabilities", async () => {
  const state = await boot();
  const seg = await spawn(state, "=6+36", "locked");
  const t = resolveTrust(state, seg);
  assert.equal(t.code, false); assert.equal(t.net, false); assert.equal(t.storage, false);
});

test("a pure-formula seed computes inside the quarantine", async () => {
  const state = await boot();
  const seg = await spawn(state, "=6+36", "locked");
  assert.equal(state.cels.get(`${seg}.元`)?.v, 42, "locked sheet still computes — dom/cels/math are ungated");
});

test("a net-using seed is #DENIED in a locked spawn (the jail holds)", async () => {
  const state = await boot();
  const seg = await spawn(state, `=chat("hi","k","m","https://api.anthropic.com")`, "locked");
  const v = state.cels.get(`${seg}.元`)?.v;
  assert.ok(typeof v === "string" && v.startsWith("#DENIED(net"), `net refused in locked spawn (got ${JSON.stringify(v)})`);
});

test("the 'net' preset grants net to the spawned segment", async () => {
  const state = await boot();
  const seg = await spawn(state, "=1+1", "net");
  const t = resolveTrust(state, seg);
  assert.equal(t.net, true, "net preset → net granted");
  assert.equal(t.storage, false, "but storage stays denied");
});

test("preset is capped by the parent kernel (can't widen a locked kernel)", async () => {
  const state = await boot();
  setTrust(state, "kernel", { net: false });        // kernel forbids net for everyone
  const seg = await spawn(state, "=1+1", "net"); // child REQUESTS net via preset
  assert.equal(resolveTrust(state, seg).net, false, "kernel ∧ segment → net stays off; no widening");
});
