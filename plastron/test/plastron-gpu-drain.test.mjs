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
const log = { renderers: 0, renders: 0, setMatrixAt: 0, meshes: [], disposed: 0, cameras: [] };
class M4 { makeTranslation() { return this; } }
class Vec { set() {} }
// a REAL 3-vector so a camera dolly is observable (position tracks x/y/z)
class Vec3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }
class MockRenderer {
  constructor() { log.renderers++; }
  render() { log.renders++; }
  dispose() { log.disposed++; }
  setClearColor() {}
}
class MockScene { add() {} }
class MockCamera { constructor() { this.position = new Vec3(); log.cameras.push(this); } lookAt() {} }
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
    dispatchEvent(ev) { for (const fn of [...(L.get(ev.type) ?? [])]) fn(ev); return true; },
    listenerCount(t) { return L.get(t)?.size ?? 0; },
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
  const { state, r, m, root, positions } = await boot();

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

  // ── wheel-dolly (design §3): the effect lives on the retained handle ────────
  const findScene = (el) => {
    if (el?.attrs && el.attrs["data-scene"] !== undefined) return el;
    for (const c of el?.childNodes ?? []) { const f = findScene(c); if (f) return f; }
    return null;
  };
  const canvas = findScene(root);
  assert.ok(canvas, "found the retained <canvas data-scene> in the painted tree");
  const cam = log.cameras[log.cameras.length - 1];   // the retained scene camera
  const distOf = (c) => Math.hypot(c.position.x, c.position.y, c.position.z);
  // authored camera(0,4,8) → distance sqrt(80); ratio defaults min 0.25·d0, max 4·d0
  const d0 = Math.hypot(0, 4, 8);
  assert.ok(Math.abs(distOf(cam) - d0) < 1e-9, "camera framed at the authored distance before any wheel");

  // 5. wheel-in dollies the retained camera CLOSER and renders ONCE — sim pump
  //    IDLE (no scene.paint frame), proving zoom works on a paused scene.
  let prevented = 0;
  const rBeforeWheel = log.renders, mmBeforeWheel = log.setMatrixAt;
  canvas.dispatchEvent({ type: "wheel", deltaY: -100, preventDefault() { prevented++; } });
  assert.equal(prevented, 1, "the handler preventDefault'd the wheel (page never scrolls)");
  assert.ok(distOf(cam) < d0 - 1e-9, "wheel-forward dollied the camera closer to the origin");
  assert.equal(log.renders, rBeforeWheel + 1, "exactly one extra render fired — while the pump was idle");
  assert.equal(log.setMatrixAt, mmBeforeWheel, "a wheel dolly uploads no instances (camera-only)");

  // 6. clamp holds: many scroll-OUT notches saturate at maxDistance and never exceed
  const maxD = 4 * d0;
  for (let i = 0; i < 200; i++) canvas.dispatchEvent({ type: "wheel", deltaY: 100, preventDefault() {} });
  assert.ok(distOf(cam) <= maxD + 1e-6, "camera never dollies past maxDistance");
  assert.ok(Math.abs(distOf(cam) - maxD) < 1e-6, "sustained scroll-out saturates exactly at maxDistance");

  // 7. no duplicate listener across a rebuild: change the data-scene attr to
  //    force buildHandle to rebuild on the SAME element, then one wheel notch
  //    must apply ONE dolly step (the old listener was removed on rebuild).
  const rebuiltAttr = JSON.stringify([
    { spec: "camera", x: 0, y: 6, z: 12 },
    { spec: "instances", geometry: { spec: "box", w: 1, h: 1, d: 1 }, material: { spec: "material", color: "#e67" }, count: 3, key: "t.buffers" },
  ]);
  canvas.setAttribute("data-scene", rebuiltAttr);
  await r("replay.scene")(canvas, state);
  await tick(); await tick();
  assert.equal(canvas.listenerCount("wheel"), 1, "exactly one wheel listener after a rebuild (old one removed)");
  const cam2 = log.cameras[log.cameras.length - 1];
  const d0b = Math.hypot(0, 6, 12);
  const rBeforeRebuiltWheel = log.renders;
  canvas.dispatchEvent({ type: "wheel", deltaY: -100, preventDefault() {} });
  // one listener → exactly one render and one dolly step of exp(-0.1); a stacked
  // duplicate listener would render twice and compound the step to exp(-0.2).
  assert.equal(log.renders, rBeforeRebuiltWheel + 1, "one render per wheel after rebuild (no duplicate listener)");
  assert.ok(Math.abs(distOf(cam2) - d0b * Math.exp(-0.1)) < 1e-6, "a single dolly step applied (not double)");
});
