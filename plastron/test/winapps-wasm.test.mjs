import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, setPainter } from "../dist/index.js";

// winapps-wasm — wasmapp puts a wasm app on the NEW window frame (wframe), with the
// graph↔engine bridge cels, so a DOOM tab can sit next to a sheet. (The full fold of
// wasm-window + the doom-as-formula-cells rewrite is the cutover.)

const boot = async () => {
  const state = createInitialState();
  setPainter(state, { enqueue: () => {}, drain: () => {}, flush: () => {} });
  await resolveFn(state, "ensureSegments")(state, ["winapps-wasm", "window", "wasm-window", "dom"]);
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

  // content is the focusable canvas (reuses wasm-window's verb)
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
