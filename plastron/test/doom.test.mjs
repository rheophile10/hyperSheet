import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";
import { lockConsent, setConsent, isConsented, isDangerous } from "../dist/kernel/index.js";

// doom — =doom() opens a wasm-window running Doom (wasm-window kind, first user).
// The engine boot (fetch assets + canvas RAF) is browser-bound (covered by the
// chromium e2e); here: the genesis, the kind:"wasm" engine actually hydrating
// against the REAL doom.wasm, and the consent gate.

const WASM = "/home/ian/projects/plastron/plastron-examples/doom/doom.wasm";
const stubNs = () => new Proxy({}, { get: () => () => 0 }); // every import → ()=>0 (WASI SUCCESS)

const boot = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["doom"]); // pulls wasm-window + wasm-bytes
  await resolveFn(state, "hydrate")(state, [], []);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  return state;
};

test("=doom() mints the wasm-window (canvas, bridge cels, armed boot)", async () => {
  const state = await boot();
  const g = resolveFn(state, "doom")();
  assert.equal(g.genesis, true);
  assert.equal(g.layer, "wasm.doom");
  for (const k of ["wasm.doom.state", "wasm.doom.content", "wasm.doom.frame", "wasm.doom.in", "wasm.doom.out", "wasm.doom.active", "wasm.doom.armboot"])
    assert.ok(g.cels[k], `seeds ${k}`);
  assert.match(g.cels["wasm.doom.content"].f, /wasmcanvas "doom"/, "body is a wasm canvas");
  assert.match(g.cels["wasm.doom.armboot"].f, /doom\.arm/, "boot is armed on materialise");
});

test("the kind:\"wasm\" doom engine hydrates against the real doom.wasm + _initialize runs", async () => {
  const bytes = new Uint8Array(await Bun.file(WASM).arrayBuffer());
  assert.equal(bytes[0], 0x00); assert.equal(bytes[1], 0x61); // \0asm magic — the artifact is present
  const b64 = Buffer.from(bytes).toString("base64");

  const state = await boot();
  let captured = null;
  await resolveFn(state, "setCel")(state, "doom-stub", {
    celType: "LockedLambdaCel",
    fn: () => ({ imports: { env: stubNs(), wasi_snapshot_preview1: stubNs() }, onInstantiate: (inst) => { captured = inst; }, dispose: () => {} }),
    metadata: { key: "doom-stub", segment: "doom", kind: "native" },
  });
  await resolveFn(state, "hydrate")(state, [{
    name: "doom",
    cels: [{ key: "doom.engine", celType: "EditableLambdaCel", metadata: { key: "doom.engine", segment: "doom", kind: "wasm", imports: "doom-stub" }, f: b64 }],
  }], []);

  assert.ok(captured, "the wasm-host-instance hook captured the live instance");
  assert.equal(typeof captured.exports._initialize, "function", "_initialize exported");
  assert.ok(captured.exports.doomgeneric_Create, "doomgeneric_Create exported");
  assert.ok(captured.exports.memory?.buffer instanceof ArrayBuffer, "wasm memory present");
});

test("=doom is consent-gated: blocked in a LOCKED session until consented", async () => {
  const state = await boot();
  assert.equal(isConsented(state, "doom", "doom"), true, "own session is trusted");
  lockConsent(state); // what a #f= / #raw= shared sheet does
  assert.equal(isConsented(state, "doom", "doom"), false, "a shared sheet can't boot Doom (download engine+WAD) without consent");
  setConsent(state, "doom", { allow: true, category: "net" });
  assert.equal(isConsented(state, "doom", "doom"), true, "after consent, Doom may boot");
});

test("the ASSET LOADERS (doom.arm/doom.boot) are gated — a shared sheet embedding a doom window can't auto-fetch the engine+WAD", async () => {
  const state = await boot();
  for (const k of ["doom.arm", "doom.boot"]) assert.ok(isDangerous(k), `${k} loads engine/WAD bytes → must be DANGEROUS`);
  lockConsent(state);
  // the persisted `wasm.doom.armboot` formula references doom.arm — gating it
  // makes that formula #BLACKLISTED on a locked sheet, so boot never fetches.
  assert.equal(isConsented(state, "doom.arm", "wasm.doom"), false, "embedded doom can't arm the boot without consent");
  assert.equal(isConsented(state, "doom.boot", "wasm.doom"), false, "embedded doom can't boot without consent");
  setConsent(state, "doom.arm", { allow: true, category: "net" });
  assert.equal(isConsented(state, "doom.arm", "wasm.doom"), true, "after consent, the boot may arm");
});
