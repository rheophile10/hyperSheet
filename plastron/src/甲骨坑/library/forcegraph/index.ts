import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import { el as makeEl, text as TT } from "../dom/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// forcegraph — force-directed graph simulations as a reusable dom capability.
//
// One segment owns the whole force-graph lifecycle so every consumer
// (docgraph's wiki, future note graphs, dependency views) gets the same
// physics, drag, zoom, and render for free:
//
//   spec  = { nodes: [{ key, label?, size? }], edges: [[keyA, keyB], …],
//             pin?: key, onNode?: { dispatch } }
//   fg.set (dispatch)   — (state, { id, spec }): create the instance's layer
//                         cels (fg.<id>.spec/pos/zoom), run the layout to
//                         OVERLAP-FREE, then freeze. There is no ticker: the
//                         sim runs at set time and during interactions only.
//   fgview(id, spec, pos, zoom) — pure render verb. Reference it in a
//                         FORMULA and the graph re-renders reactively when a
//                         drag writes fg.<id>.pos — positions are cels, so
//                         the inputMap edge IS the animation loop.
//   fg.grab/move/drop   — node dragging (pointer capture, the windows
//                         pattern). While dragging, the grabbed node follows
//                         the pointer and the REST relax around it each move
//                         (springs + collision separation); on drop the
//                         layout relaxes until no two nodes overlap, then
//                         freezes again.
//   fg.wheel            — zoom (0.35–3×) around the box center, per instance.
//   fg.click            — node click: re-dispatches spec.onNode.dispatch with
//                         the node key UNLESS the pointer travelled (a drag
//                         must not also navigate).
//
// Layout space is a fixed 1000×460; chips position in PERCENTAGES over a
// 100%-stretched canvas, so the rendered graph grows with its container.
// Determinism: seeding is index-based (no Math.random — kernel doctrine).
// Instance cels live in the fg.<id> LAYER (layers are exempt from the
// one-direction rule; the win.wiki lesson).
// ============================================================================

type V = { type: "el" | "text"; tag?: string; attrs?: Record<string, unknown>; events?: Record<string, unknown>; children?: V[]; text?: string; style?: Record<string, unknown> };
const el = makeEl as unknown as (tag: string, attrs?: Record<string, unknown>, children?: V[], events?: Record<string, unknown>) => V;
const T = TT as unknown as (s: string) => V;

export const FG_W = 1000;
export const FG_H = 460;

export interface FgNode { key: string; label?: string; size?: number; kind?: string; tint?: string; accent?: string }
export interface FgSpec { nodes: FgNode[]; edges: Array<[string, string]>; pin?: string; onNode?: { dispatch: string } }
type Pos = Record<string, [number, number]>;

const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const specOf = (v: unknown): FgSpec => {
  const s = (v ?? {}) as Partial<FgSpec>;
  return { nodes: Array.isArray(s.nodes) ? s.nodes : [], edges: Array.isArray(s.edges) ? s.edges : [], pin: s.pin, onNode: s.onNode };
};

/** A node's collision radius — chips are text pills, approximated as circles
 *  wide enough for their label at their size scale. */
const radiusOf = (n: FgNode): number => {
  const label = String(n.label ?? n.key);
  const scale = num(n.size, 1);
  return Math.max(14, (Math.min(label.length, 19) * 2.1 + 10) * scale * 0.55);
};

const anyOverlap = (spec: FgSpec, pos: Pos): boolean => {
  const ns = spec.nodes;
  for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
    const a = pos[ns[i]!.key], b = pos[ns[j]!.key];
    if (!a || !b) continue;
    const dx = a[0] - b[0], dy = a[1] - b[1];
    const min = radiusOf(ns[i]!) + radiusOf(ns[j]!);
    if (dx * dx + dy * dy < min * min) return true;
  }
  return false;
};

/** Deterministic index-based seeding on rings around the center. */
const seedPositions = (spec: FgSpec): Pos => {
  const out: Pos = {};
  const n = Math.max(1, spec.nodes.length);
  spec.nodes.forEach((node, i) => {
    const a = (2 * Math.PI * i) / n;
    const r = 0.30 * Math.min(FG_W, FG_H) * (1 + (i % 3) * 0.22);
    out[node.key] = [FG_W / 2 + r * Math.cos(a), FG_H / 2 + r * Math.sin(a)];
  });
  if (spec.pin && out[spec.pin]) out[spec.pin] = [FG_W / 2, FG_H / 2];
  return out;
};

/** Relax the layout in place: springs along edges, repulsion between all
 *  pairs, COLLISION separation (the no-overlap force), light center gravity.
 *  `pins` are held still. Returns true when overlap-free at exit. Stops
 *  early once overlap-free AND motion has settled — that is the freeze. */
export const relax = (spec: FgSpec, pos: Pos, pins: Set<string>, iters: number): boolean => {
  const ns = spec.nodes;
  const idx = new Map(ns.map((n, i) => [n.key, i]));
  const K = Math.sqrt((FG_W * FG_H) / Math.max(1, ns.length)) * 0.7;
  for (let it = 0; it < iters; it++) {
    const fx = new Array(ns.length).fill(0), fy = new Array(ns.length).fill(0);
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
      const a = pos[ns[i]!.key]!, b = pos[ns[j]!.key]!;
      let dx = a[0] - b[0], dy = a[1] - b[1];
      if (dx === 0 && dy === 0) { dx = (i - j) * 0.7; dy = (j - i) * 0.5; } // deterministic split
      const d2 = Math.max(36, dx * dx + dy * dy);
      const rep = (K * K) / d2;
      // collision: a strong separating force inside the summed radii
      const min = radiusOf(ns[i]!) + radiusOf(ns[j]!);
      const d = Math.sqrt(d2);
      const col = d < min ? (min - d) * 0.45 : 0;
      const ux = dx / d, uy = dy / d;
      fx[i] += ux * (rep + col); fy[i] += uy * (rep + col);
      fx[j] -= ux * (rep + col); fy[j] -= uy * (rep + col);
    }
    for (const [a, b] of spec.edges) {
      const ia = idx.get(a), ib = idx.get(b);
      if (ia === undefined || ib === undefined) continue;
      const pa = pos[a]!, pb = pos[b]!;
      const dx = pa[0] - pb[0], dy = pa[1] - pb[1];
      const d = Math.max(8, Math.sqrt(dx * dx + dy * dy));
      const f = (d - K) / d * 0.12;
      fx[ia] -= dx * f; fy[ia] -= dy * f; fx[ib] += dx * f; fy[ib] += dy * f;
    }
    const cool = 1 - (it / iters) * 0.6;
    let moved = 0;
    for (let i = 0; i < ns.length; i++) {
      const key = ns[i]!.key;
      if (pins.has(key)) continue;
      const p = pos[key]!;
      const sx = Math.max(-14, Math.min(14, fx[i])) * cool + (FG_W / 2 - p[0]) * 0.008;
      const sy = Math.max(-14, Math.min(14, fy[i])) * cool + (FG_H / 2 - p[1]) * 0.008;
      p[0] = Math.max(16, Math.min(FG_W - 16, p[0] + sx));
      p[1] = Math.max(14, Math.min(FG_H - 14, p[1] + sy));
      moved = Math.max(moved, Math.abs(sx) + Math.abs(sy));
    }
    // freeze condition: separated AND settled — no point burning iterations
    if (moved < 0.6 && !anyOverlap(spec, pos)) return true;
  }
  return !anyOverlap(spec, pos);
};

/** Full layout: deterministic seed, pin honored, relax to overlap-free. */
export const layout = (spec: FgSpec): Pos => {
  const pos = seedPositions(spec);
  const pins = new Set<string>(spec.pin ? [spec.pin] : []);
  relax(spec, pos, pins, 220);
  return pos;
};

// ── instance cels ────────────────────────────────────────────────────────────

const posKey = (id: string): string => `fg.${id}.pos`;
const specKey = (id: string): string => `fg.${id}.spec`;
const zoomKey = (id: string): string => `fg.${id}.zoom`;
const armKey = (id: string): string => `fg.${id}.armed`;
const hideKey = (id: string): string => `fg.${id}.hide`;

/** fg.set — (state, { id, spec }): create the instance's layer cels if
 *  missing, lay the graph out to overlap-free, freeze. Re-set with a new
 *  spec re-lays out (positions of surviving keys are kept as seeds). */
const fgSet: Fn = (async (state: State, payload?: unknown): Promise<void> => {
  const { id, spec: rawSpec } = (payload ?? {}) as { id?: string; spec?: unknown };
  const gid = String(id ?? "g");
  const spec = specOf(rawSpec);
  const setCel = resolveFn(state, "setCel") as Fn;
  const setValue = resolveFn(state, "setValue") as Fn;
  for (const [key, v] of [[specKey(gid), {}], [posKey(gid), {}], [zoomKey(gid), 1], [armKey(gid), 0], [hideKey(gid), []]] as Array<[string, unknown]>) {
    if (!state.cels.has(key)) {
      await setCel(state, key, { celType: "ValueCel", v, metadata: { segment: `fg.${gid}`, name: key.split(".").pop() } });
    }
  }
  // keep surviving positions as warm seeds, lay out the rest
  const prev = (state.cels.get(posKey(gid))?.v ?? {}) as Pos;
  const pos = layout(spec);
  for (const n of spec.nodes) if (prev[n.key] && n.key !== spec.pin) pos[n.key] = prev[n.key]!;
  relax(spec, pos, new Set(spec.pin ? [spec.pin] : []), 80);
  await setValue(state, specKey(gid), spec);
  await setValue(state, posKey(gid), pos);
  await setValue(state, zoomKey(gid), Number(state.cels.get(zoomKey(gid))?.v) || 1);
}) as Fn;

// ── render ───────────────────────────────────────────────────────────────────

/** fgview(id, spec, pos, zoom) — the pure render. Use it in a FORMULA with
 *  the instance cels as args so drags/zooms re-render through the graph:
 *  `(fgview "wiki" fg.wiki.spec fg.wiki.pos fg.wiki.zoom)` */
const fgviewFn: Fn = (id?: unknown, specArg?: unknown, posArg?: unknown, zoomArg?: unknown, armedArg?: unknown, hideArg?: unknown): V => {
  const gid = String(id ?? "g");
  const spec = specOf(specArg);
  const pos = (posArg ?? {}) as Pos;
  const zoom = Math.max(0.35, Math.min(3, num(zoomArg, 1)));
  const armed = !!(typeof armedArg === "number" ? armedArg : num(armedArg, 0));
  const hidden = new Set(Array.isArray(hideArg) ? (hideArg as unknown[]).map(String) : []);
  // filter: a node hides with its kind (the PIN never hides — it is the
  // subject); an edge hides with either endpoint.
  const visible = spec.nodes.filter((n) => n.key === spec.pin || !n.kind || !hidden.has(n.kind));
  const visKeys = new Set(visible.map((n) => n.key));
  const zx = (x: number): number => Math.max(8, Math.min(FG_W - 8, FG_W / 2 + (x - FG_W / 2) * zoom));
  const zy = (y: number): number => Math.max(8, Math.min(FG_H - 8, FG_H / 2 + (y - FG_H / 2) * zoom));
  const ops = spec.edges.flatMap(([a, b]) => {
    if (!visKeys.has(a) || !visKeys.has(b)) return [];
    const pa = pos[a], pb = pos[b];
    if (!pa || !pb) return [];
    return [{ op: "line", points: [[zx(pa[0]), zy(pa[1])], [zx(pb[0]), zy(pb[1])]], stroke: "#8886", lineWidth: 1 }];
  });
  const chips = visible.flatMap((n) => {
    const p = pos[n.key];
    if (!p) return [];
    const isPin = n.key === spec.pin;
    const scale = Math.min(2, Math.max(0.6, num(n.size, 1))) * (isPin ? 1.15 : 1);
    const label = String(n.label ?? n.key);
    const short = label.length > 18 ? label.slice(0, 17) + "…" : label;
    const border = isPin ? "#4a90d9" : (n.accent ?? "#8885");
    const bg = n.tint ?? (isPin ? "#4a90d922" : "Canvas");
    return [el("button", {
      class: isPin ? "fg-node fg-node-pin" : "fg-node",
      title: `${n.key}${n.kind ? ` · ${n.kind}` : ""} — drag to move, click to open`,
      style: `position:absolute;left:${(zx(p[0]) / FG_W * 100).toFixed(2)}%;top:${(zy(p[1]) / FG_H * 100).toFixed(2)}%;transform:translate(-50%,-50%) scale(${scale.toFixed(2)});font:.66rem ui-monospace,monospace;padding:.06rem .35rem;border-radius:.7rem;cursor:grab;white-space:nowrap;touch-action:none;border:1.5px solid ${border};background:${bg};color:CanvasText`,
    }, [T(short)], {
      pointerdown: { dispatch: "fg.grab", payload: { id: gid, key: n.key } },
      pointermove: { dispatch: "fg.move" },
      pointerup: { dispatch: "fg.drop" },
      click: { dispatch: "fg.click", payload: { id: gid, key: n.key } },
    })];
  });
  // legend-as-filter: one chip per kind present; click toggles that kind.
  const kinds = new Map<string, FgNode>();
  for (const n of spec.nodes) if (n.kind && !kinds.has(n.kind)) kinds.set(n.kind, n);
  const legend = kinds.size ? [el("div", {
    class: "fg-legend",
    style: "position:absolute;top:.3rem;left:.4rem;display:flex;gap:.25rem;flex-wrap:wrap;z-index:2",
  }, [...kinds.entries()].map(([kind, sample]) => {
    const off = hidden.has(kind);
    return el("button", {
      class: off ? "fg-kind fg-kind-off" : "fg-kind",
      title: off ? `show ${kind} nodes` : `hide ${kind} nodes`,
      style: `font:.62rem ui-monospace,monospace;padding:.04rem .35rem;border-radius:.6rem;cursor:pointer;border:1px solid ${sample.accent ?? "#8885"};background:${off ? "transparent" : (sample.tint ?? "#8881")};color:CanvasText;opacity:${off ? ".45" : "1"};text-decoration:${off ? "line-through" : "none"}`,
    }, [T(kind)], { pointerdown: { dispatch: "winx.stop" }, click: { dispatch: "fg.toggleKind", payload: { id: gid, kind } } });
  }))] : [];
  // the scroll-containment convention (the maps-embed pattern): the graph
  // owns the wheel ONLY while armed — click in to arm (wheel zooms, the
  // window does not scroll: prevent claims the default), leave to release.
  return el("div", {
    class: armed ? "fg-box fg-armed" : "fg-box", "data-fg": gid,
    title: armed ? "scroll zooms · move the pointer out to release" : "drag nodes · click to enable scroll-zoom",
    style: `position:relative;width:100%;height:340px;border:1px solid ${armed ? "#4a90d9" : "#8883"};border-radius:.5rem;overflow:hidden;background:#8880;box-shadow:${armed ? "0 0 0 2px #4a90d933" : "none"}`,
  }, [
    { type: "el", tag: "canvas", attrs: { width: FG_W, height: FG_H, "data-ops": JSON.stringify(ops) },
      style: { width: "100%", height: "100%", display: "block" }, children: [] } as V,
    ...legend,
    ...chips,
  ], {
    wheel: { dispatch: "fg.wheel", payload: gid, prevent: armed },
    click: { dispatch: "fg.arm", payload: gid },
    pointerleave: { dispatch: "fg.disarm", payload: gid },
  });
};

// ── drag / zoom / click handlers ─────────────────────────────────────────────

interface DomEvt { clientX?: number; clientY?: number; pointerId?: number; deltaY?: number; currentTarget?: { setPointerCapture?: (id: number) => void; closest?: (s: string) => { getBoundingClientRect?: () => { left: number; top: number; width: number; height: number } } | null }; target?: { setPointerCapture?: (id: number) => void; closest?: (s: string) => { getBoundingClientRect?: () => { left: number; top: number; width: number; height: number } } | null } }
interface Drag { id: string; key: string; sx: number; sy: number; moved: number }

const capture = (e?: DomEvt): void => { try { (e?.currentTarget ?? e?.target)?.setPointerCapture?.(num(e?.pointerId)); } catch { /* off-DOM */ } };
const boxRect = (e?: DomEvt): { left: number; top: number; width: number; height: number } | null => {
  const t = (e?.currentTarget ?? e?.target) as { closest?: (s: string) => { getBoundingClientRect?: () => { left: number; top: number; width: number; height: number } } | null } | undefined;
  const box = t?.closest?.(".fg-box");
  return box?.getBoundingClientRect?.() ?? null;
};
const toGraph = (e: DomEvt, rect: { left: number; top: number; width: number; height: number }, zoom: number): [number, number] => {
  // invert the render's zoom mapping so the node lands under the pointer
  const px = (num(e.clientX) - rect.left) / Math.max(1, rect.width) * FG_W;
  const py = (num(e.clientY) - rect.top) / Math.max(1, rect.height) * FG_H;
  return [FG_W / 2 + (px - FG_W / 2) / zoom, FG_H / 2 + (py - FG_H / 2) / zoom];
};

const repaint = (state: State): Promise<unknown> => Promise.resolve((resolveFn(state, "drain") as Fn)(state, "dom.paint"));
const setV = (state: State, k: string, v: unknown): Promise<unknown> =>
  Promise.resolve((resolveFn(state, "setValue") as Fn)(state, k, v)).then(() => repaint(state));
const dragOf = (state: State): Drag | null => (state.cels.get("fg.drag")?.v as Drag | null) ?? null;

const fgGrab: Fn = (async (state: State, payload?: unknown, event?: DomEvt): Promise<void> => {
  const { id, key } = (payload ?? {}) as { id?: string; key?: string };
  if (!id || !key) return;
  capture(event);
  await ((resolveFn(state, "setValue") as Fn)(state, "fg.drag",
    { id: String(id), key: String(key), sx: num(event?.clientX), sy: num(event?.clientY), moved: 0 }));
}) as Fn;

const fgMove: Fn = (async (state: State, _p?: unknown, event?: DomEvt): Promise<void> => {
  const d = dragOf(state);
  if (!d) return;
  const rect = boxRect(event);
  if (!rect) return;
  const spec = specOf(state.cels.get(specKey(d.id))?.v);
  const zoom = Number(state.cels.get(zoomKey(d.id))?.v) || 1;
  const pos = { ...((state.cels.get(posKey(d.id))?.v ?? {}) as Pos) };
  pos[d.key] = toGraph(event!, rect, zoom);
  // the grabbed node leads; the rest relax around it — live, but cheap
  relax(spec, pos, new Set([d.key, ...(spec.pin && spec.pin !== d.key ? [] : [])]), 6);
  const moved = d.moved + Math.abs(num(event?.clientX) - d.sx) + Math.abs(num(event?.clientY) - d.sy);
  await ((resolveFn(state, "setValue") as Fn)(state, "fg.drag", { ...d, sx: num(event?.clientX), sy: num(event?.clientY), moved }));
  await setV(state, posKey(d.id), pos);
}) as Fn;

const fgDrop: Fn = (async (state: State): Promise<void> => {
  const d = dragOf(state);
  if (!d) return;
  const spec = specOf(state.cels.get(specKey(d.id))?.v);
  const pos = { ...((state.cels.get(posKey(d.id))?.v ?? {}) as Pos) };
  // settle: hold the dropped node, relax the rest until no overlaps → freeze
  relax(spec, pos, new Set([d.key]), 120);
  await ((resolveFn(state, "setValue") as Fn)(state, "fg.drag", null));
  await ((resolveFn(state, "setValue") as Fn)(state, "fg.lastMoved", d.moved));
  await setV(state, posKey(d.id), pos);
}) as Fn;

const fgWheel: Fn = (async (state: State, payload?: unknown, event?: DomEvt): Promise<void> => {
  const gid = String(payload ?? "g");
  const dy = num(event?.deltaY);
  if (!dy || !state.cels.has(zoomKey(gid))) return;
  if (!num(state.cels.get(armKey(gid))?.v)) return; // unarmed → the page scrolls
  const cur = Number(state.cels.get(zoomKey(gid))?.v) || 1;
  const next = Math.max(0.35, Math.min(3, cur * (dy < 0 ? 1.15 : 0.87)));
  if (next !== cur) await setV(state, zoomKey(gid), next);
}) as Fn;

const fgClick: Fn = (async (state: State, payload?: unknown, event?: unknown): Promise<void> => {
  const { id, key } = (payload ?? {}) as { id?: string; key?: string };
  if (!id || !key) return;
  // a drag is not a click — suppress navigation when the pointer travelled
  if (num(state.cels.get("fg.lastMoved")?.v) > 6) {
    await ((resolveFn(state, "setValue") as Fn)(state, "fg.lastMoved", 0));
    return;
  }
  const spec = specOf(state.cels.get(specKey(String(id)))?.v);
  const target = spec.onNode?.dispatch;
  if (!target) return;
  const fn = resolveFn(state, target) as Fn | undefined;
  if (fn) await fn(state, key, event);
}) as Fn;

/** legend click — toggle a kind in fg.<id>.hide; the formula re-renders. */
const fgToggleKind: Fn = (async (state: State, payload?: unknown): Promise<void> => {
  const { id, kind } = (payload ?? {}) as { id?: string; kind?: string };
  if (!id || !kind || !state.cels.has(hideKey(String(id)))) return;
  const cur = (state.cels.get(hideKey(String(id)))?.v ?? []) as string[];
  const next = cur.includes(kind) ? cur.filter((k) => k !== kind) : [...cur, kind];
  await setV(state, hideKey(String(id)), next);
}) as Fn;

const fgArm: Fn = (async (state: State, payload?: unknown): Promise<void> => {
  const gid = String(payload ?? "g");
  if (!state.cels.has(armKey(gid)) || num(state.cels.get(armKey(gid))?.v) === 1) return;
  await setV(state, armKey(gid), 1);
}) as Fn;

const fgDisarm: Fn = (async (state: State, payload?: unknown): Promise<void> => {
  const gid = String(payload ?? "g");
  if (!state.cels.has(armKey(gid)) || num(state.cels.get(armKey(gid))?.v) === 0) return;
  await setV(state, armKey(gid), 0);
}) as Fn;

export const name = "forcegraph" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["fgview", fgviewFn],
  ["fg.set", fgSet],
  ["fg.grab", fgGrab],
  ["fg.move", fgMove],
  ["fg.drop", fgDrop],
  ["fg.wheel", fgWheel],
  ["fg.arm", fgArm],
  ["fg.toggleKind", fgToggleKind],
  ["fg.disarm", fgDisarm],
  ["fg.click", fgClick],
]));
