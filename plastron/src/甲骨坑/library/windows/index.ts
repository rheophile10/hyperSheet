import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import { el as makeEl, text as T } from "../dom/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// windows — cels as draggable/resizable windows (windows-segment.md, accepted).
// A LIBRARY capability (sibling of dom/plastron-canvas); the application only
// composes it. The window FRAME is a pure render verb; its geometry lives in
// cels (`${key}.x/.y/.w/.h`) so it persists, dehydrates, and is reactive — drag/
// resize are dispatch HANDLERS that setValue those cels (app/library divide:
// render is a formula, mutation is a handler). Drag uses POINTER CAPTURE on
// pointerdown, so element-level pointermove/up keep firing off the element — no
// global-listener plumbing for stage 1.
// ============================================================================

type V = { type: "el" | "text"; tag?: string; attrs?: Record<string, unknown>; events?: Record<string, unknown>; children?: V[]; text?: string };
const el = makeEl as unknown as (tag: string, attrs?: Record<string, unknown>, children?: V[], events?: Record<string, unknown>) => V;
const isVnode = (v: unknown): v is V => !!v && typeof v === "object" && ((v as V).type === "el" || (v as V).type === "text");
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// (window key x y w h title content) — a draggable/resizable frame around
// content. Geometry (x,y,w,h) is passed from the host's `${key}.*` cels so the
// formula re-renders reactively when they change. The titlebar drags; the
// corner handle resizes; the body scrolls.
const windowFn: Fn = ((key: unknown, x: unknown, y: unknown, w: unknown, h: unknown, title: unknown, content: unknown, z?: unknown, min?: unknown): V => {
  const k = String(key ?? "win");
  if (min) return el("div", { class: "pl-window-min", "data-win": k, style: "display:none" }, []);  // minimized → in the toolbar
  const fx = num(x), fy = num(y), fw = num(w, 320), fh = num(h, 200), fz = num(z, 1);
  const body = isVnode(content) ? content : T(content == null ? "" : String(content));
  // any pointerdown in the window raises it (event bubbles up from titlebar /
  // body / resize handle); z-index reads the reactive `${key}.z` cel.
  return el("div", { class: "pl-window", "data-win": k, style: `position:absolute;left:${fx}px;top:${fy}px;width:${fw}px;height:${fh}px;z-index:${fz};display:flex;flex-direction:column;border:1px solid #8886;border-radius:6px;background:Canvas;box-shadow:0 4px 16px #0004;overflow:hidden` }, [
    el("div", { class: "pl-titlebar", style: "flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:.4rem;padding:.25rem .55rem;background:#8881;cursor:move;user-select:none;touch-action:none;font:600 .8rem ui-monospace,monospace" }, [
      el("span", {}, [T(String(title ?? k))]),
      el("button", { class: "pl-min-btn", style: "border:0;background:transparent;cursor:pointer;font:600 1rem ui-monospace,monospace;padding:0 .3rem;line-height:1" }, [T("–")], { click: { dispatch: "win.minimize", payload: k } }),
    ], {
      pointerdown: { dispatch: "win.grab", payload: k },
      pointermove: { dispatch: "win.move" },
      pointerup: { dispatch: "win.drop" },
    }),
    el("div", { class: "pl-window-body", style: "flex:1 1 auto;overflow:auto;padding:.3rem;min-height:0" }, [body]),
    el("div", { class: "pl-resize", style: "position:absolute;right:0;bottom:0;width:15px;height:15px;cursor:nwse-resize;touch-action:none;background:linear-gradient(135deg,transparent 45%,#8886 45%,#8886 55%,transparent 55%)" }, [], {
      pointerdown: { dispatch: "win.grabResize", payload: k },
      pointermove: { dispatch: "win.resizeMove" },
      pointerup: { dispatch: "win.drop" },
    }),
  ], { pointerdown: { dispatch: "win.raise", payload: k } });
}) as Fn;

// ── drag/resize handlers (dispatch targets: (state, payload, event)) ─────────
interface DomEvt { clientX?: number; clientY?: number; pointerId?: number; currentTarget?: { setPointerCapture?: (id: number) => void }; target?: { setPointerCapture?: (id: number) => void } }
interface Drag { key: string; ox: number; oy: number; resize?: boolean }

// Painting is an explicit effect (the graph owns value propagation; the host's
// raf does NOT auto-drain). A dispatch handler that changes a window's geometry
// must repaint — so setV/setBatch drain dom.paint after the write. (A structure
// CREATE rides settleStructural's view.refresh instead; both end in a paint.)
const repaint = (state: State): Promise<unknown> => Promise.resolve((resolveFn(state, "drain") as Fn)(state, "dom.paint"));
const setV = (state: State, k: string, v: unknown): Promise<unknown> => Promise.resolve((resolveFn(state, "setValue") as Fn)(state, k, v)).then(() => repaint(state));
const setBatch = (state: State, pairs: [string, unknown][]): Promise<unknown> => Promise.resolve((resolveFn(state, "setValueBatch") as Fn)(state, pairs)).then(() => repaint(state));
const capture = (e?: DomEvt): void => { try { (e?.currentTarget ?? e?.target)?.setPointerCapture?.(num(e?.pointerId)); } catch { /* no pointer capture off-DOM */ } };
const dragOf = (state: State): Drag | null => (state.cels.get("win.drag")?.v as Drag | null) ?? null;

// pointerdown on the titlebar — record the mouse→origin offset, capture the
// pointer so the move/up phase stays bound even off the element.
const grabFn: Fn = (async (state: State, key: unknown, event?: DomEvt): Promise<void> => {
  const k = String(key); capture(event);
  const x = num(state.cels.get(`${k}.x`)?.v), y = num(state.cels.get(`${k}.y`)?.v);
  await setV(state, "win.drag", { key: k, ox: num(event?.clientX) - x, oy: num(event?.clientY) - y });
}) as Fn;

const moveFn: Fn = (async (state: State, _p: unknown, event?: DomEvt): Promise<void> => {
  const d = dragOf(state); if (!d || d.resize) return;
  await setBatch(state, [[`${d.key}.x`, num(event?.clientX) - d.ox], [`${d.key}.y`, num(event?.clientY) - d.oy]]);
}) as Fn;

// pointerdown on the corner handle — offset is mouse→size, so resize tracks it.
const grabResizeFn: Fn = (async (state: State, key: unknown, event?: DomEvt): Promise<void> => {
  const k = String(key); capture(event);
  const w = num(state.cels.get(`${k}.w`)?.v, 320), h = num(state.cels.get(`${k}.h`)?.v, 200);
  await setV(state, "win.drag", { key: k, ox: num(event?.clientX) - w, oy: num(event?.clientY) - h, resize: true });
}) as Fn;

const resizeMoveFn: Fn = (async (state: State, _p: unknown, event?: DomEvt): Promise<void> => {
  const d = dragOf(state); if (!d?.resize) return;
  await setBatch(state, [[`${d.key}.w`, Math.max(120, num(event?.clientX) - d.ox)], [`${d.key}.h`, Math.max(80, num(event?.clientY) - d.oy)]]);
}) as Fn;

// snapRegion — Ubuntu-style edge tiling. Given the pointer at drop + the
// viewport, return the rect to snap to (left/right half, top=maximize, corner
// quarters), or null for "no snap" (dropped in the interior). Pure geometry,
// unit-tested.
export const snapRegion = (mx: number, my: number, vw: number, vh: number, edge = 24): { x: number; y: number; w: number; h: number } | null => {
  if (!vw || !vh) return null;
  const L = mx <= edge, R = mx >= vw - edge, T = my <= edge, B = my >= vh - edge;
  if (L && T) return { x: 0, y: 0, w: vw / 2, h: vh / 2 };
  if (L && B) return { x: 0, y: vh / 2, w: vw / 2, h: vh / 2 };
  if (R && T) return { x: vw / 2, y: 0, w: vw / 2, h: vh / 2 };
  if (R && B) return { x: vw / 2, y: vh / 2, w: vw / 2, h: vh / 2 };
  if (T) return { x: 0, y: 0, w: vw, h: vh };            // top → maximize
  if (L) return { x: 0, y: 0, w: vw / 2, h: vh };        // left half
  if (R) return { x: vw / 2, y: 0, w: vw / 2, h: vh };   // right half
  return null;
};

const dropFn: Fn = (async (state: State, _p: unknown, event?: DomEvt): Promise<void> => {
  const d = dragOf(state);
  await setV(state, "win.drag", null);
  if (!d || d.resize || !event) return;                 // only a drag-drop snaps
  const g = globalThis as { innerWidth?: number; innerHeight?: number };
  const rect = snapRegion(num(event.clientX), num(event.clientY), num(g.innerWidth), num(g.innerHeight));
  if (rect) await setBatch(state, [[`${d.key}.x`, rect.x], [`${d.key}.y`, rect.y], [`${d.key}.w`, rect.w], [`${d.key}.h`, rect.h]]);
}) as Fn;

// z-order: any pointerdown in a window raises it. A module-scope counter assigns
// the next-highest z; the window's z-index reads the reactive `${key}.z` cel.
let topZ = 10;
const raiseFn: Fn = (async (state: State, key: unknown): Promise<void> => {
  const zk = `${String(key)}.z`;
  if (state.cels.get(zk)) await setV(state, zk, ++topZ);
  else await Promise.resolve((resolveFn(state, "setCel") as Fn)(state, zk, { celType: "ValueCel", v: ++topZ, metadata: { key: zk, segment: "win" } }));
}) as Fn;

// ── window registry + toolbar (minimize/restore) ────────────────────────────
const putV = async (state: State, k: string, v: unknown): Promise<void> => {
  if (state.cels.get(k)) await setV(state, k, v);
  else await Promise.resolve((resolveFn(state, "setCel") as Fn)(state, k, { celType: "ValueCel", v, metadata: { key: k, segment: "win" } }));
};
const listOf = (state: State): string[] => { const v = state.cels.get("win.list")?.v; return Array.isArray(v) ? v.map(String) : []; };

// winopen(key, title) — register a window: add to win.list + seed its geometry cels.
const openFn: Fn = (async (state: State, key: unknown, title: unknown): Promise<void> => {
  const k = String(key); const list = listOf(state);
  if (!list.includes(k)) await putV(state, "win.list", [...list, k]);
  for (const [suf, dv] of [["x", 60], ["y", 60], ["w", 320], ["h", 200], ["z", 1], ["min", 0]] as [string, number][]) if (!state.cels.get(`${k}.${suf}`)) await putV(state, `${k}.${suf}`, dv);
  await putV(state, `${k}.title`, title == null ? k : String(title));
  await (raiseFn as (s: State, key: unknown) => Promise<void>)(state, k);
}) as Fn;
const closeFn: Fn = (async (state: State, key: unknown): Promise<void> => { const k = String(key); await putV(state, "win.list", listOf(state).filter((x) => x !== k)); }) as Fn;
const minimizeFn: Fn = (async (state: State, key: unknown): Promise<void> => { await putV(state, `${String(key)}.min`, 1); }) as Fn;
const restoreFn: Fn = (async (state: State, key: unknown): Promise<void> => { const k = String(key); await putV(state, `${k}.min`, 0); await (raiseFn as (s: State, key: unknown) => Promise<void>)(state, k); }) as Fn;

// wintoolbar(keys, titles) — a taskbar of open windows; click a chip → restore + raise.
const toolbarFn: Fn = ((keys: unknown, titles: unknown): V => {
  const ks = Array.isArray(keys) ? keys.map(String) : [];
  const ts = Array.isArray(titles) ? titles : [];
  return el("div", { class: "pl-toolbar", style: "position:fixed;left:0;right:0;bottom:0;display:flex;gap:.4rem;padding:.35rem;background:#8881;border-top:1px solid #8883;z-index:9998" },
    ks.map((k, i) => el("button", { class: "pl-task", "data-win": k, style: "padding:.25rem .7rem;border:1px solid #8884;border-radius:.3rem;background:Canvas;cursor:pointer;font:600 .78rem ui-monospace,monospace" }, [T(String(ts[i] ?? k))], { click: { dispatch: "win.restore", payload: k } })));
}) as Fn;

// win(key, title, content) — the ONE-STEP entry: emits a genesis worksheet that
// seeds the reactive geometry cels (${key}.x/.y/.w/.h/.z/.min) + a mounted view
// cell whose formula references them — so the window is draggable/resizable out
// of the box (the geometry must be CELS for the drag to re-render). Origin's
// drain materializes the {genesis}. =win("w1", "Demo", "drag my titlebar!")
const winFn: Fn = ((key: unknown, title: unknown, content: unknown): unknown => {
  const k = String(key ?? "w1");
  const t = String(title ?? k).replace(/"/g, "'");
  const c = String(content ?? "").replace(/"/g, "'");
  const vcel = (name: string, v: unknown): unknown => ({ celType: "ValueCel", v, metadata: { segment: k, name } });
  return { genesis: true, layer: k, cels: {
    [`${k}.x`]: vcel("x", 80), [`${k}.y`]: vcel("y", 90), [`${k}.w`]: vcel("w", 340), [`${k}.h`]: vcel("h", 210), [`${k}.z`]: vcel("z", 1), [`${k}.min`]: vcel("min", 0),
    [`${k}.view`]: { celType: "FormulaCel", f: `(mount ".origin" (window "${k}" ${k}.x ${k}.y ${k}.w ${k}.h "${t}" "${c}" ${k}.z ${k}.min))`, metadata: { segment: k, name: "view", parser: "f" } },
  } };
}) as Fn;

export const name = "windows" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["win", winFn],
  ["window", windowFn],
  ["win.grab", grabFn],
  ["win.move", moveFn],
  ["win.grabResize", grabResizeFn],
  ["win.resizeMove", resizeMoveFn],
  ["win.drop", dropFn],
  ["win.raise", raiseFn],
  ["winopen", openFn],
  ["winclose", closeFn],
  ["win.minimize", minimizeFn],
  ["win.restore", restoreFn],
  ["wintoolbar", toolbarFn],
]));
