import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../dist/index.js";

// Tier B — the scene.paint pipeline against a call-logging Three mock
// (injected via globalThis.__three; loadThree checks it first):
//   1. the dom replay registry dispatches data-scene → replay.scene and
//      data-ops → replay.canvas2d through the REAL painter flush;
//   2. replay.scene builds + retains the handle (one renderer, one
//      InstancedMesh, full first upload);
//   3. a generation bump on a channel:["scene.paint"] cel + flush drains
//      exactly the dirty instances and renders ONCE more;
//   4. an unrelated dom.paint flush does NOT render.

// ── call-logging Three mock ──────────────────────────────────────────────────
const log = { renderers: 0, renders: 0, setMatrixAt: 0, meshes: [], disposed: 0 };
class M4 { makeTranslation() { return this; } }
class Vec { set() {} }
class MockRenderer {
  constructor() { log.renderers++; }
  render() { log.renders++; }
  dispose() { log.disposed++; }
  setClearColor() {}
}
class MockScene { add() {} }
class MockCamera { constructor() { this.position = new Vec(); } lookAt() {} }
class MockLight { constructor() { this.position = new Vec(); } }
class MockGeom {}
class MockMat {}
class MockInstancedMesh {
  constructor(_g, _m, count) { this.count = count; this.instanceMatrix = { setUsage() {}, needsUpdate: false }; log.meshes.push(this); }
  setMatrixAt() { log.setMatrixAt++; }
  setColorAt() {}
}
globalThis.__three = {
  WebGLRenderer: MockRenderer, Scene: MockScene, PerspectiveCamera: MockCamera,
  AmbientLight: MockLight, DirectionalLight: MockLight,
  BoxGeometry: MockGeom, SphereGeometry: MockGeom, MeshLambertMaterial: MockMat,
  InstancedMesh: MockInstancedMesh, Matrix4: M4, Color: class { setRGB() {} },
  DynamicDrawUsage: 1,
};

// ── fake DOM + mock-raf painter (the fragments.test.ts pattern) ─────────────
const ctxLog = { fillRect: 0 };
const mkEl = (tag) => {
  const L = new Map();
  const el = {
    nodeType: 1, tag, tagName: tag.toUpperCase(), childNodes: [], attrs: {}, isConnected: true,
    style: { props: {}, setProperty(p, v) { this.props[p] = v; }, removeProperty(p) { delete this.props[p]; } },
    get firstChild() { return el.childNodes[0] ?? null; },
    get lastChild() { return el.childNodes[el.childNodes.length - 1] ?? null; },
    get width() { return Number(el.attrs.width ?? 0); },
    get height() { return Number(el.attrs.height ?? 0); },
    setAttribute(n, v) { el.attrs[n] = v; }, removeAttribute(n) { delete el.attrs[n]; },
    getAttribute(n) { return el.attrs[n] ?? null; },
    getContext(kind) { return kind === "2d" ? { canvas: el, fillRect() { ctxLog.fillRect++; }, strokeRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, clearRect() {}, fillText() {}, save() {}, restore() {}, setLineDash() {}, moveTo() {}, lineTo() {}, closePath() {} } : null; },
    appendChild(c) { el.childNodes.push(c); return c; },
    removeChild(c) { const i = el.childNodes.indexOf(c); if (i >= 0) el.childNodes.splice(i, 1); return c; },
    replaceChild(nn, o) { const i = el.childNodes.indexOf(o); if (i >= 0) el.childNodes[i] = nn; return o; },
    insertBefore(nn, r) { const i = r ? el.childNodes.indexOf(r) : -1; if (i >= 0) el.childNodes.splice(i, 0, nn); else el.childNodes.push(nn); return nn; },
    replaceChildren(...c) { el.childNodes = [...c]; },
    addEventListener(t, fn) { (L.get(t) ?? L.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { L.get(t)?.delete(fn); },
  };
  return el;
};
const mockRaf = () => { const q = []; return { raf: (cb) => q.push(cb), caf: () => {}, run: () => { for (const cb of q.splice(0)) cb(); } }; };

const tick = () => new Promise((r) => setTimeout(r, 0));

const boot = async () => {
  const root = mkEl("app");
  globalThis.document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }), querySelector: (s) => (s === "#app" ? root : null) };
  const m = mockRaf();
  const state = createInitialState();
  if (state.cels.get("元.mount")) state.cels.get("元.mount").v = null;
  setPainter(state, createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: true, doc: globalThis.document, resolveMount: (x) => (x === "#app" ? root : null) }));
  const r = (k) => resolveFn(state, k);

  // the RenderSpec wrapper the view formula calls (the test's stand-in for
  // origin's `mount` verb, which lives in a parked application segment)
  await r("setCel")(state, "t.mkspec", {
    celType: "LockedLambdaCel", locked: true,
    fn: (vnode) => ({ vnode, mount: "#app", listeners: [] }),
    metadata: { segment: "gputest", kind: "native" },
  });

  // the sim boundary: buffers (3 instances) + generation + the sceneframe cel,
  // plus a VIEW FormulaCel composing a scene canvas AND a 2-D ops canvas
  // (registry dispatch test) — views are FormulaCels, the repo-wide idiom
  const positions = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]);
  const seg = {
    name: "gputest", version: "0.0.1", dependencies: ["plastron-gpu", "dom", "plastron-canvas"], role: "library",
    cels: [
      { key: "t.buffers", celType: "ValueCel", metadata: { key: "t.buffers", segment: "gputest" }, v: { positions } },
      { key: "t.gen", celType: "ValueCel", metadata: { key: "t.gen", segment: "gputest" }, v: 0 },
      { key: "t.frame", celType: "FormulaCel", metadata: { key: "t.frame", segment: "gputest", parser: "f", channel: ["scene.paint"] },
        f: '(sceneframe "t.buffers" t.gen)' },
      { key: "t.view", celType: "FormulaCel", metadata: { key: "t.view", segment: "gputest", parser: "f", channel: ["dom.paint"] },
        f: '(t.mkspec (dom "div" (scene 100 80 (camera 0 4 8) (instances (box 1 1 1) (material "#e67") 3 "t.buffers")) (canvas 50 40 (rect 0 0 50 40 "#111"))))' },
    ],
  };
  await r("hydrate")(state, [seg], [{ name: "gputest", version: "0.0.1", dependencies: seg.dependencies, role: "library" }]);
  await precomputeOptional(state);
  await r("runCycle")(state);
  await r("drain")(state, "all");
  m.run();          // painter flush → applyPatch → runReplayers
  await tick(); await tick();  // replay.scene's async buildHandle settles (mock import)
  return { state, r, m, root, positions };
};

test("registry dispatch + retained handle + gen-bump drain + dirty-diff exactness", async () => {
  const { state, r, m, positions } = await boot();

  // 1. registry dispatched both replayers off ONE painter flush
  assert.equal(log.renderers, 1, "one retained WebGLRenderer built for the data-scene canvas");
  assert.equal(log.meshes.length, 1, "one InstancedMesh");
  assert.equal(log.meshes[0].count, 3, "instance count from the spec");
  assert.ok(ctxLog.fillRect >= 1, "data-ops canvas replayed via replay.canvas2d in the same flush");
  const rendersAfterBuild = log.renders;
  assert.ok(rendersAfterBuild >= 1, "initial render");
  assert.equal(log.setMatrixAt, 3, "full first upload (3 instances)");

  // 2. mutate ONE instance in place, bump the generation, flush scene.paint
  positions[4] = 9;
  await r("setValueBatch")(state, [["t.gen", 1]], { flush: "scene.paint" });
  assert.equal(log.setMatrixAt, 4, "dirty-diff uploaded exactly the 1 changed instance");
  assert.equal(log.renders, rendersAfterBuild + 1, "one render per drained frame");

  // 3. an unrelated dom.paint flush does NOT render the scene
  await r("setValue")(state, "t.buffers2", undefined).catch(() => {}); // no-op guard
  await r("drain")(state, "dom.paint");
  m.run();
  await tick();
  assert.equal(log.renders, rendersAfterBuild + 1, "no render without a scene.paint frame");

  // 4. second gen bump with NO buffer change → zero new setMatrixAt, still renders
  await r("setValueBatch")(state, [["t.gen", 2]], { flush: "scene.paint" });
  assert.equal(log.setMatrixAt, 4, "unchanged buffers upload nothing");
  assert.equal(log.renders, rendersAfterBuild + 2, "render still fires per frame");
});
