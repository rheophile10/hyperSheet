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
const windowFn: Fn = ((key: unknown, x: unknown, y: unknown, w: unknown, h: unknown, title: unknown, content: unknown, z?: unknown): V => {
  const k = String(key ?? "win");
  const fx = num(x), fy = num(y), fw = num(w, 320), fh = num(h, 200), fz = num(z, 1);
  const body = isVnode(content) ? content : T(content == null ? "" : String(content));
  // any pointerdown in the window raises it (event bubbles up from titlebar /
  // body / resize handle); z-index reads the reactive `${key}.z` cel.
  return el("div", { class: "pl-window", "data-win": k, style: `position:absolute;left:${fx}px;top:${fy}px;width:${fw}px;height:${fh}px;z-index:${fz};display:flex;flex-direction:column;border:1px solid #8886;border-radius:6px;background:Canvas;box-shadow:0 4px 16px #0004;overflow:hidden` }, [
    el("div", { class: "pl-titlebar", style: "flex:0 0 auto;display:flex;align-items:center;gap:.4rem;padding:.25rem .55rem;background:#8881;cursor:move;user-select:none;touch-action:none;font:600 .8rem ui-monospace,monospace" }, [T(String(title ?? k))], {
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

const setV = (state: State, k: string, v: unknown): Promise<unknown> => Promise.resolve((resolveFn(state, "setValue") as Fn)(state, k, v));
const setBatch = (state: State, pairs: [string, unknown][]): Promise<unknown> => Promise.resolve((resolveFn(state, "setValueBatch") as Fn)(state, pairs));
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

const dropFn: Fn = (async (state: State): Promise<void> => { await setV(state, "win.drag", null); }) as Fn;

// z-order: any pointerdown in a window raises it. A module-scope counter assigns
// the next-highest z; the window's z-index reads the reactive `${key}.z` cel.
let topZ = 10;
const raiseFn: Fn = (async (state: State, key: unknown): Promise<void> => {
  const zk = `${String(key)}.z`;
  if (state.cels.get(zk)) await setV(state, zk, ++topZ);
  else await Promise.resolve((resolveFn(state, "setCel") as Fn)(state, zk, { celType: "ValueCel", v: ++topZ, metadata: { key: zk, segment: "win" } }));
}) as Fn;

export const name = "windows" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["window", windowFn],
  ["win.grab", grabFn],
  ["win.move", moveFn],
  ["win.grabResize", grabResizeFn],
  ["win.resizeMove", resizeMoveFn],
  ["win.drop", dropFn],
  ["win.raise", raiseFn],
]));
