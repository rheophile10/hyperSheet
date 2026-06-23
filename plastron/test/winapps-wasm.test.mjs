import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, setPainter } from "../dist/index.js";
import {
  graphBridge,
  isActive,
  wasmKey,
  wasmcanvas,
  wasmFocus,
  wasmKeyHandler,
  wasmappGenesis,
} from "../dist/甲骨坑/library/winapps-wasm/index.js";

// winapps-wasm — wasmapp puts a wasm app on the NEW window frame (wframe), with the
// graph↔engine bridge cels, so a DOOM tab can sit next to a sheet. (The full fold of
// wasm-window + the doom-as-formula-cells rewrite is the cutover.)

const boot = async () => {
  const state = createInitialState();
  setPainter(state, { enqueue: () => {}, drain: () => {}, flush: () => {} });
  await resolveFn(state, "ensureSegments")(state, ["winapps-wasm", "window", "dom"]);
  await resolveFn(state, "hydrate")(state, [], []);
  return state;
};

test("wasmapp: a self-mounting wasm window on the NEW frame + the graph↔engine bridge cels", async () => {
  const state = await boot();
  const g = resolveFn(state, "wasmapp")("doom", "🐢 DOOM", "doom.engine", { w: 640, h: 400 });
  assert.equal(g.genesis, true);
  assert.equal(g.kind, "wasm");

  // bridge cels the engine + key router use
  assert.equal(g.cels["wasm.doom.in"].v, null);
  assert.equal(g.cels["wasm.doom.out"].v, null);
  assert.equal(g.cels["wasm.doom.active"].v, 0);

  // content is the focusable canvas (winapps-wasm's wasmcanvas verb)
  assert.equal(g.cels["wasm.doom.content"].f, '(wasmcanvas "doom")');

  // window state: one tab = the canvas, with geometry
  const ws = g.cels["wasm.doom.state"].v;
  assert.deepEqual([ws.w, ws.h], [640, 400], "geometry from opts");
  assert.deepEqual(ws.tabs, [{ ref: "wasm.doom.content", title: "🐢 DOOM" }], "one tab = its canvas");

  // the frame self-mounts via the NEW wframe (not the legacy winframe)
  assert.equal(g.cels["wasm.doom.frame"].f, '(mount ".origin" (wframe wasm.doom.state win.active wasm.doom.content))');
});

test("a wasmapp canvas can be docked as a tab beside a sheet (heterogeneous frame)", async () => {
  const state = await boot();
  const g = resolveFn(state, "wasmapp")("doom", "DOOM", "doom.engine");
  // a host window with a sheet tab; dock DOOM's canvas content in as a second tab
  const REF = "win.work.state";
  await resolveFn(state, "setCel")(state, REF, {
    celType: "ValueCel", metadata: { key: REF, segment: "work" },
    v: { ref: REF, x: 60, y: 40, w: 600, h: 400, z: 2, min: 0, max: 0, closed: 0, tabs: [{ ref: "budget.view", title: "Budget" }], active: 0 },
  });
  await resolveFn(state, "window.dock")(state, { into: REF, tab: { ref: "wasm.doom.content", title: "DOOM", icon: "🐢" } });
  const tabs = state.cels.get(REF).v.tabs;
  assert.equal(tabs.length, 2, "the sheet and the DOOM canvas share one frame's tabs");
  assert.equal(tabs[1].ref, "wasm.doom.content", "DOOM's canvas is the second tab");
  void g;
});

// ── engine-bridge unit tests (ported from the retired wasm-window segment) ──
// Materialize the wasm.<id>.* bridge cels by committing a wasmappGenesis output
// through setCel — the same shapes the genesis drain would commit, so the bridge
// + key fns have live cels to read/write. (No jail mode: wasmappGenesis has none.)
const seedBridge = async (state, id) => {
  const g = wasmappGenesis(id, id, `${id}.engine`);
  const setCel = resolveFn(state, "setCel");
  for (const [key, spec] of Object.entries(g.cels)) {
    await setCel(state, key, { ...spec, metadata: { key, ...spec.metadata } });
  }
  return g;
};

test("graphBridge: recv reads wasm.<id>.in, send writes wasm.<id>.out, active reflects wasm.<id>.active", async () => {
  const state = await boot();
  await seedBridge(state, "doom");
  const setValue = resolveFn(state, "setValue");
  const getCel = resolveFn(state, "getCel");
  const bridge = graphBridge(state, "doom");

  // graph → engine: recv() reads the inbox cel
  assert.equal(bridge.recv(), null, "empty inbox reads null");
  await setValue(state, "wasm.doom.in", { key: "a", code: "KeyA", down: true });
  assert.deepEqual(bridge.recv(), { key: "a", code: "KeyA", down: true }, "recv() reflects wasm.doom.in");

  // engine → graph: send(v) writes the outbox cel
  bridge.send({ frame: 7 });
  assert.deepEqual(getCel(state, "wasm.doom.out").v, { frame: 7 }, "send() writes wasm.doom.out");

  // active() reflects wasm.doom.active
  assert.equal(bridge.active(), false, "inactive by default");
  await setValue(state, "wasm.doom.active", 1);
  assert.equal(bridge.active(), true, "active() reflects wasm.doom.active");
});

test("wasmcanvas: a focusable <canvas id=wasm-<id>> dispatching wasmwin.focus/blur/key", () => {
  const vnode = wasmcanvas("doom");
  // host div wraps the canvas
  assert.equal(vnode.type, "el");
  assert.equal(vnode.tag, "div");
  const canvas = vnode.children[0];
  assert.equal(canvas.tag, "canvas");
  assert.equal(canvas.attrs.id, "wasm-doom", "canvas id is wasm-<id>");
  assert.equal(canvas.attrs.tabindex, "0", "focusable");
  // events dispatch the wasmwin verbs with the id payload
  assert.deepEqual(canvas.events.focus, { dispatch: "wasmwin.focus", payload: "doom" });
  assert.deepEqual(canvas.events.blur, { dispatch: "wasmwin.blur", payload: "doom" });
  assert.deepEqual(canvas.events.keydown, { dispatch: "wasmwin.key", payload: "doom" });
  assert.deepEqual(canvas.events.keyup, { dispatch: "wasmwin.key", payload: "doom" });
});

test("wasmFocus + wasmKeyHandler: focus marks active, then a keydown delivers into the inbox", async () => {
  const state = await boot();
  await seedBridge(state, "doom");
  assert.equal(isActive(state, "doom"), false, "starts inactive");

  // focusing the canvas marks the window active
  await wasmFocus(state, "doom");
  assert.equal(isActive(state, "doom"), true, "focus → active");

  // a keydown routes into the inbox (active-gated)
  await wasmKeyHandler(state, "doom", { type: "keydown", key: "ArrowUp", code: "ArrowUp" });
  assert.deepEqual(
    graphBridge(state, "doom").recv(),
    { key: "ArrowUp", code: "ArrowUp", down: true },
    "keydown delivered into the inbox",
  );
});

test("wasmKey: keystrokes reach the engine ONLY when active", async () => {
  const state = await boot();
  await seedBridge(state, "doom");
  const ev = { type: "keydown", key: "x", code: "KeyX" };

  // inactive → not delivered
  assert.equal(wasmKey(state, "doom", ev), false, "inactive → returns false");
  assert.equal(graphBridge(state, "doom").recv(), null, "nothing delivered while inactive");

  // after focus → delivered
  await wasmFocus(state, "doom");
  assert.equal(wasmKey(state, "doom", ev), true, "active → returns true");
  assert.deepEqual(
    graphBridge(state, "doom").recv(),
    { key: "x", code: "KeyX", down: true },
    "delivered into the inbox once active",
  );
});

test("wasmappGenesis: seeds the canvas window + bridge cels (keys, content formula, state.tabs)", () => {
  const g = wasmappGenesis("doom", "🐢 DOOM", "doom.engine", { w: 800, h: 600 });
  assert.equal(g.genesis, true);
  assert.equal(g.kind, "wasm");
  assert.equal(g.layer, "wasm.doom");

  // bridge cels exist with the right seed values
  assert.equal(g.cels["wasm.doom.in"].v, null);
  assert.equal(g.cels["wasm.doom.out"].v, null);
  assert.equal(g.cels["wasm.doom.active"].v, 0);

  // content formula calls (wasmcanvas "<id>")
  assert.equal(g.cels["wasm.doom.content"].f, '(wasmcanvas "doom")');

  // window state references the content cel as its (one) tab
  const ws = g.cels["wasm.doom.state"].v;
  assert.deepEqual([ws.w, ws.h], [800, 600], "geometry from opts");
  assert.equal(ws.tabs.length, 1);
  assert.equal(ws.tabs[0].ref, "wasm.doom.content", "the one tab references the content cel");
  assert.equal(ws.tabs[0].title, "🐢 DOOM");
});
