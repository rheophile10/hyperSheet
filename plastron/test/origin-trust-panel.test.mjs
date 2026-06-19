import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";
import { setTrust, LOCKED_TRUST } from "../dist/kernel/index.js";

// origin-trust-panel — =trustpanel() opens a window whose body, (trustdom
// trust.kernel), shows the four KERNEL capabilities with Grant/Revoke buttons.
// The handlers flip the kernel grant and re-sync trust.kernel, so the panel
// re-renders through the graph (no manual repaint). These no-browser tests
// drive the verbs/handlers directly and assert the vnode tree + reactivity.

const find = (node, pred, out = []) => {
  if (!node || typeof node !== "object") return out;
  if (pred(node)) out.push(node);
  for (const k of node.children ?? []) find(k, pred, out);
  return out;
};
const text = (node) => find(node, (n) => n.type === "text").map((n) => n.text).join("");
const CAPS = ["code", "net", "storage", "secrets"];

const boot = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["origin"]);
  await resolveFn(state, "hydrate")(state, [], []);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  return state;
};
const trustView = (state) => state.cels.get("trust.kernel")?.v ?? {};
const render = (state) => resolveFn(state, "trustdom")(trustView(state));

test("trustpanel() emits a window whose body references trust.kernel", async () => {
  const state = await boot();
  const g = resolveFn(state, "trustpanel")();
  assert.equal(g.genesis, true, "returns a genesis");
  assert.equal(g.cels["win.trust.content"].f, "(trustdom trust.kernel)",
    "content formula renders trustdom over the reactive trust.kernel cel");
  assert.match(g.cels["win.trust.frame"].f, /winframe win\.trust\.state win\.active win\.trust\.content/,
    "frame wraps the content in a draggable window");
});

test("at full kernel trust, every capability renders GRANTED + a Revoke button", async () => {
  const state = await boot();
  await resolveFn(state, "origin.trustSync")(state); // seed trust.kernel (boot does this)
  const v = render(state);

  // one Grant/Revoke button per capability, each wired to origin.trustToggle
  const toggles = find(v, (n) => n.tag === "button" && n.events?.click?.dispatch === "origin.trustToggle");
  assert.equal(toggles.length, 4, "four capability toggles");
  assert.deepEqual(toggles.map((b) => b.events.click.payload).sort(), [...CAPS].sort(),
    "each toggle carries its capability name as payload");

  // default kernel trust is FULL → all granted, all buttons say Revoke
  assert.equal(find(v, (n) => n.type === "text" && n.text === "GRANTED").length, 4, "all four GRANTED");
  assert.ok(toggles.every((b) => /Revoke/.test(text(b))), "every button offers Revoke");
  // each capability is explained
  assert.match(text(v), /master gate/i, "explains these are the master gate");
  assert.match(text(v), /Outbound requests/, "explains the network capability");
});

test("toggling a capability flips trust.kernel and re-renders (graph-reactive)", async () => {
  const state = await boot();
  await resolveFn(state, "origin.trustSync")(state);
  assert.equal(trustView(state).net, true, "net starts granted");

  // click Network's Revoke → origin.trustToggle("net")
  await resolveFn(state, "origin.trustToggle")(state, "net");
  assert.equal(trustView(state).net, false, "net is now revoked in the mirror cel");
  assert.equal(trustView(state).code, true, "other capabilities are untouched");

  // re-render from the updated cel: net is blocked + offers Grant; others Revoke
  const v = render(state);
  const netBtn = find(v, (n) => n.tag === "button" && n.events?.click?.payload === "net")[0];
  assert.match(text(netBtn), /Grant/, "the revoked capability now offers Grant");
  assert.equal(find(v, (n) => n.type === "text" && n.text === "blocked").length, 1, "exactly one capability blocked");

  // grant it back
  await resolveFn(state, "origin.trustToggle")(state, "net");
  assert.equal(trustView(state).net, true, "net granted again");
});

test("a LOCKED kernel (what a #f= link boots) shows every capability blocked", async () => {
  const state = await boot();
  setTrust(state, "kernel", LOCKED_TRUST);      // bootFromHash does exactly this
  await resolveFn(state, "origin.trustSync")(state);
  const v = render(state);
  assert.equal(find(v, (n) => n.type === "text" && n.text === "blocked").length, 4, "all four blocked");
  const toggles = find(v, (n) => n.tag === "button" && n.events?.click?.dispatch === "origin.trustToggle");
  assert.ok(toggles.every((b) => /Grant/.test(text(b))), "every button offers Grant when locked");
});
