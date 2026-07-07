import type { State, 甲骨, Cel, Fn } from "../../../types/index.js";
import type { ChannelEnqueue } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// plastron-gpu — the 3-D renderer tier (01-rendering.md, accepted).
//
// Same shape as plastron-canvas, one dimension up: PURE spec constructors
// upstream (box/mesh/instances/... return plain JSON nodes, never a Three
// object), a host replay step downstream. `scene(w,h,...)` returns a
// <canvas data-scene> VNODE through the normal vnode pipeline; the dom
// replay registry dispatches it to `replay.scene`, which lazy-imports Three,
// builds the object graph ONCE, and retains it per canvas element.
//
// Frame-to-frame updates do NOT re-enter the vnode diff: a `sceneframe`
// FormulaCel on the `scene.paint` channel carries {bufferKey, generation};
// the drain reads the buffer cel's SoA struct ({positions: Float32Array(3N)
// [, colors]}), dirty-diffs against the last upload, setMatrixAt's the
// changed instances, and renders. Residency-agnostic: the drain sees only
// "a struct of arrays + an upload" — a GPU-resident buffer can satisfy the
// same contract later without touching callers (overview doctrine #4).
// ============================================================================

const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v: unknown, d = ""): string => (v === undefined || v === null ? d : String(v));
const isStyle = (c: unknown): c is { __style: Record<string, unknown> } =>
  !!c && typeof c === "object" && typeof (c as { __style?: unknown }).__style === "object";
const isSpec = (c: unknown): boolean => !!c && typeof c === "object" && typeof (c as { spec?: unknown }).spec === "string";

// ── pure spec constructors ──────────────────────────────────────────────────

const box: Fn = (w, h, d) => ({ spec: "box", w: num(w, 1), h: num(h, 1), d: num(d, 1) });
const sphere: Fn = (r) => ({ spec: "sphere", r: num(r, 1) });
const material: Fn = (color) => ({ spec: "material", color: str(color, "#4a90d9") });
const meshSpec: Fn = (geometry, mat) => ({ spec: "mesh", geometry, material: mat });
const light: Fn = (x, y, z, color, intensity) =>
  ({ spec: "light", x: num(x), y: num(y, 10), z: num(z), color: str(color, "#ffffff"), intensity: num(intensity, 1) });
const cameraSpec: Fn = (x, y, z, minDistance, maxDistance, zoomSpeed) => {
  // Optional trailing args are AUTHORED, overridable wheel-dolly policy on the
  // surface (R2/R10). Omitted → the key is absent (undefined optionals dropped,
  // like light()/material() defaults); the renderer fills ratio defaults from
  // the authored distance d0 = |(x,y,z)|.
  const opt = (v: unknown): number | undefined => (v === undefined || v === null ? undefined : num(v));
  const minD = opt(minDistance), maxD = opt(maxDistance), spd = opt(zoomSpeed);
  return {
    spec: "camera", x: num(x), y: num(y, 5), z: num(z, 10),
    ...(minD !== undefined ? { minDistance: minD } : {}),
    ...(maxD !== undefined ? { maxDistance: maxD } : {}),
    ...(spd !== undefined ? { zoomSpeed: spd } : {}),
  };
};
const instances: Fn = (geometry, mat, count, bufferKey) =>
  ({ spec: "instances", geometry, material: mat, count: Math.max(1, Math.trunc(num(count, 1))), key: str(bufferKey) });

/** scene(w, h, …nodes) — a <canvas data-scene> vnode (3-D twin of canvas()). */
const scene: Fn = (width, height, ...rest) => {
  let style: Record<string, unknown> | undefined;
  const nodes: unknown[] = [];
  for (const c of rest) {
    if (isStyle(c)) { style = { ...style, ...c.__style }; continue; }
    if (Array.isArray(c)) { for (const s of (c as unknown[]).flat(8)) if (isSpec(s)) nodes.push(s); continue; }
    if (isSpec(c)) nodes.push(c);
  }
  return {
    type: "el", tag: "canvas",
    attrs: { width: Math.max(1, num(width, 300)), height: Math.max(1, num(height, 150)), "data-scene": JSON.stringify(nodes) },
    ...(style ? { style: style as Record<string, string | number | boolean | null> } : {}),
    children: [],
  };
};

/** sceneframe(bufferKey, generation) — the scene.paint channel payload. */
const sceneframe: Fn = (bufferKey, generation) => ({ key: str(bufferKey), gen: num(generation) });

/** dirtyIndices(prev, next, stride) — instance indices whose stride-wide
 *  slice changed; prev missing/mismatched → null, meaning "all" (a full
 *  upload). Pure — Tier-A testable. */
export const dirtyIndices = (
  prev: Float32Array | undefined, next: Float32Array, stride: number,
): number[] | null => {
  const s = Math.max(1, Math.trunc(stride));
  if (!prev || prev.length !== next.length) return null;
  const out: number[] = [];
  const n = Math.floor(next.length / s);
  for (let i = 0; i < n; i++) {
    const base = i * s;
    for (let k = 0; k < s; k++) {
      if (prev[base + k] !== next[base + k]) { out.push(i); break; }
    }
  }
  return out;
};

/** dollyDistance(distance, deltaY, minD, maxD, speed) — clamp
 *  `distance · exp(deltaY·speed)` into `[minD, maxD]`. Convention: wheel-forward
 *  / scroll-up (deltaY < 0) → smaller distance → zoom IN; scroll-down
 *  (deltaY > 0) → zoom OUT. Zero policy — every bound is an argument.
 *  Pure — Tier-A testable. */
export const dollyDistance = (
  distance: number, deltaY: number, minD: number, maxD: number, speed: number,
): number => Math.min(maxD, Math.max(minD, distance * Math.exp(deltaY * speed)));

// ── lazy Three (Decision 0: same-origin vendor import, CSP-clean) ───────────

type ThreeMod = Record<string, any>;
let threePromise: Promise<ThreeMod> | null = null;
const loadThree = (state: State): Promise<ThreeMod> => {
  const injected = (globalThis as { __three?: ThreeMod }).__three;
  if (injected) return Promise.resolve(injected);            // Tier-B mock injection
  if (threePromise) return threePromise;
  const url = str(state.cels.get("three.url")?.v, "/three.module.js");
  const fallback = "https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js";
  // keep the specifier a runtime VARIABLE so bundlers leave the import dynamic
  threePromise = import(/* @vite-ignore */ url).catch(() => import(/* @vite-ignore */ fallback)) as Promise<ThreeMod>;
  threePromise.catch(() => { threePromise = null; });        // allow retry after total failure
  return threePromise;
};

// ── retained handles ─────────────────────────────────────────────────────────

interface Handle {
  el: { isConnected?: boolean; width?: unknown; height?: unknown };
  spec: string;                                   // the data-scene JSON that built this handle
  renderer: any; scene: any; camera: any;
  meshes: Map<string, { mesh: any; count: number; hasColors: boolean }>;  // bufferKey → instanced mesh
  last: Map<string, Float32Array>;                // bufferKey → last-uploaded positions copy
  three: ThreeMod;
  m4: any;                                        // scratch Matrix4
  building?: boolean;
  // ephemeral view-local wheel-dolly state (never a cel — losing it resets to
  // the authored framing; see design §Zoom state). Fixed look-at target + the
  // view ray + the clamp policy, plus the attached listener for cleanup.
  onWheel?: (e: any) => void;
  target?: { x: number; y: number; z: number };
  dir?: { x: number; y: number; z: number };
  minD?: number; maxD?: number; zoomSpeed?: number;
}
const handleByEl = new WeakMap<object, Handle>();
const handles = new Set<Handle>();                // drain lookup (pruned on disconnect)

const prune = (): void => {
  for (const h of handles) {
    if (h.el.isConnected === false) {
      if (h.onWheel) { try { (h.el as any).removeEventListener?.("wheel", h.onWheel); } catch { /* guarded */ } }
      try { h.renderer?.dispose?.(); } catch { /* guarded */ }
      handles.delete(h);
    }
  }
};

const readBuffers = (state: State, key: string): { positions?: Float32Array; colors?: Float32Array } | undefined => {
  const v = state.cels.get(key)?.v as { positions?: Float32Array; colors?: Float32Array } | undefined;
  return v && typeof v === "object" ? v : undefined;
};

/** Upload instance transforms (and colors) for one buffer key into a handle.
 *  `indices === null` → full upload. The residency-agnostic seam: everything
 *  above this fn deals in cel keys + generations; everything below in
 *  typed-array slices. */
const upload = (h: Handle, key: string, buf: { positions?: Float32Array; colors?: Float32Array }): void => {
  const entry = h.meshes.get(key);
  const pos = buf.positions;
  if (!entry || !pos) return;
  const indices = dirtyIndices(h.last.get(key), pos, 3);
  const n = Math.min(entry.count, Math.floor(pos.length / 3));
  const THREE = h.three;
  const apply = (i: number): void => {
    h.m4.makeTranslation(pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!);
    entry.mesh.setMatrixAt(i, h.m4);
  };
  if (indices === null) { for (let i = 0; i < n; i++) apply(i); }
  else for (const i of indices) { if (i < n) apply(i); }
  entry.mesh.instanceMatrix.needsUpdate = true;
  if (buf.colors && entry.hasColors && entry.mesh.instanceColor) {
    const c = new THREE.Color();
    const cn = Math.min(n, Math.floor(buf.colors.length / 3));
    for (let i = 0; i < cn; i++) {
      c.setRGB(buf.colors[i * 3]!, buf.colors[i * 3 + 1]!, buf.colors[i * 3 + 2]!);
      entry.mesh.setColorAt(i, c);
    }
    entry.mesh.instanceColor.needsUpdate = true;
  }
  h.last.set(key, pos.slice());   // copy — the sim mutates in place
};

const buildGeometry = (THREE: ThreeMod, g: any): any => {
  if (g?.spec === "sphere") return new THREE.SphereGeometry(num(g.r, 1), 12, 8);
  return new THREE.BoxGeometry(num(g?.w, 1), num(g?.h, 1), num(g?.d, 1));
};
const buildMaterial = (THREE: ThreeMod, m: any): any =>
  new THREE.MeshLambertMaterial({ color: str(m?.color, "#4a90d9") });

/** Build (or rebuild) the retained Three graph for one <canvas data-scene>. */
const buildHandle = async (el: any, state: State, specAttr: string): Promise<void> => {
  const THREE = await loadThree(state);
  let nodes: any[];
  try { nodes = JSON.parse(specAttr); } catch { return; }
  if (!Array.isArray(nodes)) return;

  const old = handleByEl.get(el as object);
  if (old) {
    // remove the prior wheel listener so a spec-change rebuild on the SAME
    // reused canvas doesn't stack listeners (→ double-speed zoom).
    if (old.onWheel) { try { el.removeEventListener?.("wheel", old.onWheel); } catch { /* guarded */ } }
    try { old.renderer?.dispose?.(); } catch { /* guarded */ }
    handles.delete(old);
  }

  const w = num(el.width, 300), hgt = num(el.height, 150);
  const renderer = new THREE.WebGLRenderer({ canvas: el, antialias: true });
  renderer.setClearColor?.(0x0b1020, 1);
  const scn = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, w / Math.max(1, hgt), 0.1, 2000);
  camera.position.set(0, 5, 10); camera.lookAt(0, 0, 0);
  scn.add(new THREE.AmbientLight(0xffffff, 0.45));

  const h: Handle = { el, spec: specAttr, renderer, scene: scn, camera, meshes: new Map(), last: new Map(), three: THREE, m4: new THREE.Matrix4() };

  let cameraNode: any = null;
  for (const nd of nodes) {
    if (nd?.spec === "camera") { cameraNode = nd; camera.position.set(num(nd.x), num(nd.y, 5), num(nd.z, 10)); camera.lookAt(0, 0, 0); }
    else if (nd?.spec === "light") {
      const dl = new THREE.DirectionalLight(str(nd.color, "#ffffff"), num(nd.intensity, 1));
      dl.position.set(num(nd.x), num(nd.y, 10), num(nd.z));
      scn.add(dl);
    } else if (nd?.spec === "mesh") {
      scn.add(new THREE.Mesh(buildGeometry(THREE, nd.geometry), buildMaterial(THREE, nd.material)));
    } else if (nd?.spec === "instances") {
      const count = Math.max(1, Math.trunc(num(nd.count, 1)));
      const im = new THREE.InstancedMesh(buildGeometry(THREE, nd.geometry), buildMaterial(THREE, nd.material), count);
      im.instanceMatrix?.setUsage?.(THREE.DynamicDrawUsage);
      const key = str(nd.key);
      const buf = readBuffers(state, key);
      const hasColors = !!buf?.colors;               // instanceColor only when asked (decision)
      scn.add(im);
      h.meshes.set(key, { mesh: im, count, hasColors });
      if (buf?.positions) upload(h, key, buf);
    }
  }

  // ── wheel-dolly effect on the retained handle ──────────────────────────────
  // Derive the fixed look-at target (origin), the view ray, and the clamp
  // policy from the (possibly defaulted) authored camera. Defaults are ratios
  // of the authored distance d0 — omitted-arg defaults, the R2 pattern already
  // used by light()/material(); any scene overrides them on its camera() call.
  const cpx = num(camera.position?.x), cpy = num(camera.position?.y), cpz = num(camera.position?.z);
  const d0 = Math.hypot(cpx, cpy, cpz) || 1;
  h.target = { x: 0, y: 0, z: 0 };
  h.dir = { x: cpx / d0, y: cpy / d0, z: cpz / d0 };
  h.minD = cameraNode?.minDistance !== undefined ? num(cameraNode.minDistance) : 0.25 * d0;
  h.maxD = cameraNode?.maxDistance !== undefined ? num(cameraNode.maxDistance) : 4 * d0;
  h.zoomSpeed = cameraNode?.zoomSpeed !== undefined ? num(cameraNode.zoomSpeed) : 0.001;
  const onWheel = (event: any): void => {
    event?.preventDefault?.();                     // synchronous — the page never scrolls
    const t = h.target!, dir = h.dir!;
    const dx = num(camera.position?.x) - t.x, dy = num(camera.position?.y) - t.y, dz = num(camera.position?.z) - t.z;
    const dist = Math.hypot(dx, dy, dz);
    const next = dollyDistance(dist, num(event?.deltaY), h.minD!, h.maxD!, h.zoomSpeed!);
    camera.position.set(t.x + dir.x * next, t.y + dir.y * next, t.z + dir.z * next);
    camera.lookAt(t.x, t.y, t.z);
    try { h.renderer.render(h.scene, h.camera); } catch { /* guarded */ }  // shows the new framing even while the pump is idle
  };
  h.onWheel = onWheel;

  handleByEl.set(el as object, h);
  handles.add(h);
  el.addEventListener?.("wheel", onWheel, { passive: false });
  el.addEventListener?.("webglcontextlost", () => {
    try { el.removeEventListener?.("wheel", onWheel); } catch { /* guarded */ }
    handles.delete(h); handleByEl.delete(el as object);
  });
  try { renderer.render(scn, camera); } catch { /* guarded */ }
};

// ── the two natives the paint pipeline calls ────────────────────────────────

/** replay.scene(el, state) — dom replay registry entry for data-scene. */
const replayScene: Fn = (el: any, state: State): null => {
  try {
    if (!el || typeof el.getAttribute !== "function") return null;
    const specAttr = el.getAttribute("data-scene");
    if (!specAttr) return null;
    const existing = handleByEl.get(el as object);
    if (existing && existing.spec === specAttr) return null;   // frame-stable spec → retained handle stands
    if (existing?.building) return null;
    const marker = existing ?? ({ building: true } as unknown as Handle);
    if (!existing) handleByEl.set(el as object, marker);
    void buildHandle(el, state, specAttr).catch(() => { handleByEl.delete(el as object); });
  } catch { /* a replay failure must never break the paint */ }
  return null;
};

/** scene.paint.drain(items, state) — upload dirty instances + render. */
const scenePaintDrain: Fn = (items: ChannelEnqueue[], state: State): null => {
  try {
    prune();
    const frames = new Map<string, number>();          // key → latest gen this flush
    for (const { cel } of items ?? []) {
      const f = cel?.v as { key?: unknown; gen?: unknown } | undefined;
      if (f && typeof f === "object" && f.key) frames.set(String(f.key), num(f.gen));
    }
    for (const [key] of frames) {
      const buf = readBuffers(state, key);
      if (!buf) continue;
      for (const h of handles) {
        if (!h.meshes.has(key)) continue;
        try {
          upload(h, key, buf);
          h.renderer.render(h.scene, h.camera);
        } catch { /* guarded per handle */ }
      }
    }
  } catch { /* a paint failure must never break a flush */ }
  return null;
};

export const name = "plastron-gpu" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["box",       box],
  ["sphere",    sphere],
  ["material",  material],
  ["mesh",      meshSpec],
  ["light",     light],
  ["camera",    cameraSpec],
  ["instances", instances],
  ["scene",     scene],
  ["sceneframe", sceneframe],
  ["scene.paint.drain", scenePaintDrain],
  ["replay.scene", replayScene],
]));
