import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";
import { wasmwinGenesis, graphBridge, isActive, wasmKey } from "../dist/甲骨坑/library/wasm-window/index.js";

// wasm-window — the reusable canvas-window core: genesis shape, the graph↔engine
// message bridge, and active-gated key routing. (Canvas render + real key events
// are browser-bound; these cover the engine-agnostic, graph-visible logic.)

const boot = async () => {
  const state = createInitialState();
  await resolveFn(state, "hydrate")(state, [], []);
  await precomputeOptional(state);
  const setCel = resolveFn(state, "setCel");
  // materialise just the bridge cels a wasmwin seeds
  const g = wasmwinGenesis("demo", "Demo", "demo.engine");
  for (const [k, spec] of Object.entries(g.cels)) await setCel(state, k, spec);
  await resolveFn(state, "runCycle")(state);
  return state;
};

test("wasmwinGenesis: in-process mode seeds a canvas window + bridge cels", () => {
  const g = wasmwinGenesis("doom", "Doom", "doom.engine", { w: 640, h: 400 });
  assert.equal(g.genesis, true);
  assert.equal(g.layer, "wasm.doom");
  assert.deepEqual(Object.keys(g.cels).sort(),
    ["wasm.doom.active", "wasm.doom.content", "wasm.doom.frame", "wasm.doom.in", "wasm.doom.out", "wasm.doom.state"]);
  assert.match(g.cels["wasm.doom.content"].f, /^\(wasmcanvas "doom" doom\.engine wasm\.doom\.active\)$/, "canvas binds the engine cel + active flag");
  assert.match(g.cels["wasm.doom.frame"].f, /winframe wasm\.doom\.state win\.active wasm\.doom\.content/, "a real draggable window frame");
  assert.equal(g.cels["wasm.doom.state"].v.w, 640);
});

test("wasmwinGenesis: jail mode embeds an iframe sub-kernel running the seed", () => {
  const g = wasmwinGenesis("sandbox", "Jailed", "ignored", { jail: true, seed: '=cels(2,2)' });
  assert.match(g.cels["wasm.sandbox.content"].f, /^\(jail "=cels\(2,2\)"\)$/, "jail mode → an iframe running the seed, not an in-process engine");
});

test("graphBridge: graph→engine (recv) and engine→graph (send) over the bridge cels", async () => {
  const state = await boot();
  const bridge = graphBridge(state, "demo");

  assert.equal(bridge.recv(), null, "inbox starts empty");
  await resolveFn(state, "setValue")(state, "wasm.demo.in", { cmd: "spawn" });
  assert.deepEqual(bridge.recv(), { cmd: "spawn" }, "engine reads what the graph wrote to .in");

  bridge.send({ score: 42 });
  await resolveFn(state, "runCycle")(state);
  assert.deepEqual(state.cels.get("wasm.demo.out")?.v, { score: 42 }, "graph reads what the engine sent to .out");
});

test("wasmKey: keystrokes reach the engine ONLY when the window is active", async () => {
  const state = await boot();
  const setValue = resolveFn(state, "setValue");

  assert.equal(isActive(state, "demo"), false, "starts inactive");
  assert.equal(wasmKey(state, "demo", { type: "keydown", key: "ArrowUp", code: "ArrowUp" }), false, "inactive → not delivered");

  await setValue(state, "wasm.demo.active", 1);
  assert.equal(isActive(state, "demo"), true);
  assert.equal(wasmKey(state, "demo", { type: "keydown", key: "ArrowUp", code: "ArrowUp" }), true, "active → delivered");
  assert.deepEqual(graphBridge(state, "demo").recv(), { key: "ArrowUp", code: "ArrowUp", down: true }, "the keystroke lands in the inbox the engine polls");
});
