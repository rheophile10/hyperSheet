import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn, withAccessor, bundleSegments } from "../../../kernel/index.js";
import { el as makeEl, text as T } from "../dom/index.js";
import { README_INNER } from "./readme-content.js";
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
      el("button", { class: "pl-min-btn", style: "border:0;background:transparent;cursor:pointer;font:600 1rem ui-monospace,monospace;padding:0 .3rem;line-height:1" }, [T("–")], { pointerdown: { dispatch: "win.stop" }, click: { dispatch: "win.minimize", payload: k } }),
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

// win.stop — pointerdown on a titlebar BUTTON: stop the event reaching the
// titlebar's drag handler (which would pointer-capture + swallow the click).
const stopFn: Fn = ((_state: State, _p: unknown, event?: { stopPropagation?: () => void }): void => { try { event?.stopPropagation?.(); } catch { /* no-op off-DOM */ } }) as Fn;

const dropFn: Fn = (async (state: State, _p: unknown, event?: DomEvt): Promise<void> => {
  const d = dragOf(state);
  await setV(state, "win.drag", null);
  if (!d || d.resize || !event) return;                 // only a drag-drop snaps
  const g = globalThis as { innerWidth?: number; innerHeight?: number };
  const rect = snapRegion(num(event.clientX), num(event.clientY), num(g.innerWidth), num(g.innerHeight));
  if (rect) await setBatch(state, [[`${d.key}.x`, rect.x], [`${d.key}.y`, rect.y], [`${d.key}.w`, rect.w], [`${d.key}.h`, rect.h]]);
}) as Fn;

// z-order: any pointerdown in a window raises it. A SHARED `win.topz` ValueCel
// (default 100) is the single z fountain for BOTH window kinds — worksheet
// windows (winsheet.*) and state-cel windows (winx.*) read the same counter, so
// clicking ANY window raises it above ALL others. Each raise bumps win.topz and
// uses the new value (the window's z-index reads its `${key}.z` cel / state.z).
const nextZ = async (state: State): Promise<number> => {
  const z = (Number(state.cels.get("win.topz")?.v) || 100) + 1;
  await putV(state, "win.topz", z);
  return z;
};
const raiseFn: Fn = (async (state: State, key: unknown): Promise<void> => {
  const zk = `${String(key)}.z`;
  const z = await nextZ(state);
  if (state.cels.get(zk)) await setV(state, zk, z);
  else await Promise.resolve((resolveFn(state, "setCel") as Fn)(state, zk, { celType: "ValueCel", v: z, metadata: { key: zk, segment: "win" } }));
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
const winFn: Fn = ((key: unknown, title: unknown, content: unknown, x?: unknown, y?: unknown): unknown => {
  const k = String(key ?? "w1");
  const t = String(title ?? k).replace(/"/g, "'");
  const c = String(content ?? "").replace(/"/g, "'");
  const px = num(x, 80), py = num(y, 90);
  const vcel = (name: string, v: unknown): unknown => ({ celType: "ValueCel", v, metadata: { segment: k, name } });
  return { genesis: true, layer: k, cels: {
    [`${k}.x`]: vcel("x", px), [`${k}.y`]: vcel("y", py), [`${k}.w`]: vcel("w", 340), [`${k}.h`]: vcel("h", 210), [`${k}.z`]: vcel("z", 1), [`${k}.min`]: vcel("min", 0),
    [`${k}.view`]: { celType: "FormulaCel", f: `(mount ".origin" (window "${k}" ${k}.x ${k}.y ${k}.w ${k}.h "${t}" "${c}" ${k}.z ${k}.min))`, metadata: { segment: k, name: "view", parser: "f" } },
  } };
}) as Fn;

// ── state-cel windows ────────────────────────────────────────────────────────
// A window's whole state is ONE cel (the source of truth): win.<id> = { ref, x,
// y, w, h, z, min, max, closed, title }. The FRAME is downstream — winframe(state,
// content) renders it. Every control (drag, ✕ close, min, max) is an UPSTREAM
// write to that cel BY ITS REF, so to close/open/move/repaint a window you just
// modify its state value; the frame re-renders. winmake() genesis-creates the
// state cel + the frame; sheetView ignores it (no grid cells), so no double-window.
interface WinState { ref?: string; x?: number; y?: number; w?: number; h?: number; z?: number; min?: number; max?: number; closed?: number; title?: string; linked?: string[]; glow?: number }
const segOf = (ref: string): string => ref.replace(/\.state$/, "");
const stateOf = (state: State, ref: string): WinState => { const v = state.cels.get(ref)?.v; return (v && typeof v === "object" && !Array.isArray(v)) ? { ...(v as WinState) } : {}; };
const setState = (state: State, ref: string, patch: WinState): Promise<unknown> => Promise.resolve((resolveFn(state, "setValue") as Fn)(state, ref, { ...stateOf(state, ref), ...patch })).then(() => repaint(state));
const xdrag = (state: State): { ref: string; ox: number; oy: number; resize?: boolean } | null | undefined => state.cels.get("winx.drag")?.v as { ref: string; ox: number; oy: number; resize?: boolean } | null | undefined;

const XBTN = "border:0;background:transparent;cursor:pointer;font:600 .9rem ui-monospace,monospace;padding:0 .3rem;line-height:1";
// winframe(state, active, content) — `active` is the FOCUS POINTER's value (the
// ref of whichever window the local keyboard is pointed at). Highlight when it
// matches us. (Network/gamepad streams add their OWN pointers; this one is just
// the local-keyboard stream's.)
const frameFn: Fn = ((st: unknown, active: unknown, content: unknown): V => {
  const s = (st && typeof st === "object" && !Array.isArray(st)) ? st as WinState : {};
  const ref = s.ref ?? "win";
  if (s.closed) return el("div", { class: "pl-win-closed", "data-win": ref, style: "display:none" }, []);
  // minimized → the taskbar lists it (winx.show restores). The frame hides,
  // mirroring the worksheet frame's `g.min` stub — without this, winx.min only
  // toggled state.min and the window stayed visible.
  if (s.min) return el("div", { class: "pl-window-min", "data-win": ref, style: "display:none" }, []);
  const isActive = ref === active;
  // the wiki window IS the wiki — a W on it would re-open the wiki on itself.
  const isWiki = segOf(ref) === "win.wiki";
  const gg = globalThis as { innerWidth?: number; innerHeight?: number };
  const x = s.max ? 0 : num(s.x, 80), y = s.max ? 0 : num(s.y, 80), w = s.max ? num(gg.innerWidth, 1200) : num(s.w, 380), h = s.max ? num(gg.innerHeight, 800) - 46 : num(s.h, 260), z = num(s.z, 1);
  const body = isVnode(content) ? content : T(content == null ? "" : String(content));
  // a drop-target GLOW while another window is dragged over this one (winx.drop
  // stacks them); cleared on leave/drop. Wins over the active highlight.
  const glowOutline = s.glow ? ";outline:3px solid #4a90d9;outline-offset:1px" : "";
  return el("div", { class: "pl-window" + (isActive ? " active" : "") + (s.glow ? " drop-target" : ""), "data-win": ref, style: `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:${z};display:flex;flex-direction:column;border:${isActive ? "2px solid #4a90d9" : "1px solid #8886"};border-radius:6px;background:Canvas;box-shadow:${s.glow ? "0 0 0 3px #4a90d955,0 6px 22px #4a90d966" : (isActive ? "0 6px 22px #4a90d966" : "0 4px 16px #0004")}${glowOutline};overflow:hidden` }, [
    el("div", { class: "pl-titlebar", style: "flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:.4rem;padding:.25rem .55rem;background:#8881;cursor:move;user-select:none;touch-action:none;font:600 .8rem ui-monospace,monospace" }, [
      el("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, [T(String((s.linked?.length ? "🔗 " : "") + (s.title ?? ref)))]),
      el("div", { style: "display:flex;flex:0 0 auto;gap:.05rem" }, [
        // W — open this window's wiki article (docgraph's wiki.open). A host
        // without docgraph logs "not registered" on click; nothing breaks. The
        // wiki window omits it (it IS the wiki — a W there is redundant).
        ...(isWiki ? [] : [el("button", { class: "pl-wiki-btn", title: "wiki — what is this window?", style: XBTN + ";font-family:Georgia,serif" }, [T("W")], { pointerdown: { dispatch: "winx.stop" }, click: { dispatch: "wiki.open", payload: ref } })]),
        el("button", { class: "pl-win-btn", title: "minimize", style: XBTN }, [T("–")], { pointerdown: { dispatch: "winx.stop" }, click: { dispatch: "winx.min", payload: ref } }),
        // ONE of ◱ (mid/restore, when maximized) and ⛶ (maximize, when not); winx.max toggles s.max.
        s.max
          ? el("button", { class: "pl-win-btn", title: "mid size", style: XBTN }, [T("◱")], { pointerdown: { dispatch: "winx.stop" }, click: { dispatch: "winx.max", payload: ref } })
          : el("button", { class: "pl-win-btn", title: "maximize", style: XBTN }, [T("⛶")], { pointerdown: { dispatch: "winx.stop" }, click: { dispatch: "winx.max", payload: ref } }),
        el("button", { class: "pl-close-btn", title: "close", style: XBTN + ";color:#d4453e" }, [T("✕")], { pointerdown: { dispatch: "winx.stop" }, click: { dispatch: "winx.close", payload: ref } }),
      ]),
    ], { pointerdown: { dispatch: "winx.grab", payload: ref }, pointermove: { dispatch: "winx.move" }, pointerup: { dispatch: "winx.drop" } }),
    el("div", { class: "pl-window-body", style: "flex:1 1 auto;overflow:auto;padding:.3rem;min-height:0" }, [body]),
    ...(s.max ? [] : [el("div", { class: "pl-resize", style: "position:absolute;right:0;bottom:0;width:15px;height:15px;cursor:nwse-resize;touch-action:none;background:linear-gradient(135deg,transparent 45%,#8886 45%,#8886 55%,transparent 55%)" }, [], { pointerdown: { dispatch: "winx.grabResize", payload: ref }, pointermove: { dispatch: "winx.resizeMove" }, pointerup: { dispatch: "winx.drop" } })]),
  ], { pointerdown: { dispatch: "winx.raise", payload: ref } });
}) as Fn;

// the data-win of a state-cel window's titlebar under (x,y), excluding selfRef.
const winRefAtPoint = (x: number, y: number, selfRef?: string): string | undefined => {
  const doc = (globalThis as { document?: { elementsFromPoint?: (x: number, y: number) => Array<{ closest?: (s: string) => { getAttribute?: (a: string) => string | null } | null }> } }).document;
  for (const e of doc?.elementsFromPoint?.(x, y) ?? []) {
    if (!e.closest?.(".pl-titlebar")) continue;
    const w = e.closest?.(".pl-window"); const dw = (w as { getAttribute?: (a: string) => string | null } | null)?.getAttribute?.("data-win") ?? undefined;
    if (dw && dw !== selfRef) return dw;
  }
  return undefined;
};
// set/clear the glow flag across all state-cel windows so exactly `target` (a
// .state ref) glows. Repaints once via setState's drain.
const setGlowState = async (state: State, target?: string): Promise<void> => {
  for (const [k, cel] of state.cels) {
    if (!k.endsWith(".state")) continue;
    const v = cel.v as WinState | undefined; if (!v || typeof v !== "object") continue;
    const want = k === target ? 1 : undefined;
    if ((v.glow ? 1 : undefined) !== want) await setState(state, k, { glow: want });
  }
};
const xGrab: Fn = (async (state: State, ref: unknown, event?: DomEvt): Promise<void> => { capture(event); const s = stateOf(state, String(ref)); await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, "winx.drag", { ref: String(ref), ox: num(event?.clientX) - num(s.x, 80), oy: num(event?.clientY) - num(s.y, 80) })); }) as Fn;
const xMove: Fn = (async (state: State, _p: unknown, event?: DomEvt): Promise<void> => { const d = xdrag(state); if (!d || d.resize) return; await setState(state, d.ref, { x: num(event?.clientX) - d.ox, y: num(event?.clientY) - d.oy }); await setGlowState(state, winRefAtPoint(num(event?.clientX), num(event?.clientY), d.ref)); }) as Fn;
const xGrabResize: Fn = (async (state: State, ref: unknown, event?: DomEvt): Promise<void> => { capture(event); const s = stateOf(state, String(ref)); await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, "winx.drag", { ref: String(ref), ox: num(event?.clientX) - num(s.w, 380), oy: num(event?.clientY) - num(s.h, 260), resize: true })); }) as Fn;
const xResizeMove: Fn = (async (state: State, _p: unknown, event?: DomEvt): Promise<void> => { const d = xdrag(state); if (!d?.resize) return; await setState(state, d.ref, { w: Math.max(160, num(event?.clientX) - d.ox), h: Math.max(90, num(event?.clientY) - d.oy) }); }) as Fn;
// xDrop — release. If a window was dropped ONTO another window's titlebar, STACK
// them: bundle the two window SEGMENTS (Layer-1 bundleSegments) so each can now
// read the other's cels — "connecting windows into shared memory". Both titlebars
// then show 🔗. A SEALED segment still can't be widened (bundling never opens a
// seal; see segment-minting test) — so stacking a chat onto a sealed secrets
// window does NOT leak the secret.
const xDrop: Fn = (async (state: State, _p: unknown, event?: DomEvt): Promise<void> => {
  const d = xdrag(state);
  await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, "winx.drag", null));
  await setGlowState(state);                            // clear any drop-target glow
  if (!d || d.resize || !event) return;
  const target = winRefAtPoint(num(event.clientX), num(event.clientY), d.ref);
  if (!target) return;
  const a = segOf(d.ref), b = segOf(target);
  bundleSegments(state, [a, b]);
  const merge = (st: WinState): string[] => Array.from(new Set([...(st.linked ?? []), a, b]));
  await setState(state, d.ref, { linked: merge(stateOf(state, d.ref)) });
  await setState(state, target, { linked: merge(stateOf(state, target)) });
}) as Fn;
const xRaise: Fn = (async (state: State, ref: unknown): Promise<void> => { const r = String(ref); await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, "win.active", r)); if (state.cels.get("keys.active")) await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, "keys.active", r)); await setState(state, r, { z: await nextZ(state) }); }) as Fn;
const xMin: Fn = (async (state: State, ref: unknown): Promise<void> => { const s = stateOf(state, String(ref)); await setState(state, String(ref), { min: s.min ? 0 : 1 }); }) as Fn;
const xMax: Fn = (async (state: State, ref: unknown): Promise<void> => { const s = stateOf(state, String(ref)); await setState(state, String(ref), { max: s.max ? 0 : 1, z: await nextZ(state) }); }) as Fn;
const xClose: Fn = (async (state: State, ref: unknown): Promise<void> => { await setState(state, String(ref), { closed: 1 }); }) as Fn;
const xShow: Fn = (async (state: State, ref: unknown): Promise<void> => { const r = String(ref); await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, "win.active", r)); if (state.cels.get("keys.active")) await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, "keys.active", r)); await setState(state, r, { closed: 0, min: 0, z: await nextZ(state) }); }) as Fn;
const xStop: Fn = ((_state: State, _p: unknown, event?: { stopPropagation?: () => void }): void => { try { event?.stopPropagation?.(); } catch { /* off-DOM */ } }) as Fn;

// winmake(id, title, content) — the formula: genesis a window-STATE cel + its
// FRAME render (mounted). The state cel is the source of truth; modify it to
// open/close/move. =winmake("d1", "Window 1", "drag me; close me with ✕")
const makeFn: Fn = ((id: unknown, title: unknown, content: unknown): unknown => {
  const lay = `win.${String(id ?? "w")}`;
  const sref = `${lay}.state`;
  let hsh = 0; for (const ch of String(id ?? "w")) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;  // stagger defaults by id so windows do not stack
  const dx = 60 + (hsh % 7) * 46, dy = 50 + (hsh % 5) * 40;
  const t = String(title ?? id ?? "window").replace(/"/g, "'");
  const c = String(content ?? "").replace(/"/g, "'");
  return { genesis: true, layer: lay, cels: {
    [sref]: { celType: "ValueCel", v: { ref: sref, x: dx, y: dy, w: 380, h: 260, z: 1, min: 0, max: 0, closed: 0, title: t }, metadata: { name: "state" } },
    [`${lay}.frame`]: { celType: "FormulaCel", f: `(mount ".origin" (winframe ${sref} win.active "${c}"))`, metadata: { name: "frame", parser: "f" } },
  } };
}) as Fn;

// winapp(id, title, contentSource) — like winmake, but the content is a FORMULA,
// not a string: it creates win.<id>.content as a FormulaCel and the frame mounts
// THAT cel, so a window can hold a real app — the secrets panel, a chat, the
// readme, anything renderable.
//   =winapp("secrets","Secrets","(secrets (locked secretsNote) (apiKeys))")
// The content formula must REFERENCE the cels it should react to (inputMap
// doctrine): a bare "(secrets)" renders the locked panel and never re-fires,
// so unlocking appears to do nothing.
// linkList — normalize an optional `linked` arg (an array, or a space/comma-
// separated string of segment names) into a string[] | undefined. Used by
// winapp/chatapp to seed state.linked at creation (a 🔗 titlebar).
const linkList = (linked: unknown): string[] | undefined => {
  if (Array.isArray(linked)) { const a = linked.map(String).filter(Boolean); return a.length ? a : undefined; }
  if (typeof linked === "string") { const a = linked.split(/[\s,]+/).filter(Boolean); return a.length ? a : undefined; }
  return undefined;
};

const appFn: Fn = ((id: unknown, title: unknown, contentSource: unknown, linked?: unknown): unknown => {
  const lay = `win.${String(id ?? "w")}`;
  const sref = `${lay}.state`, cref = `${lay}.content`;
  let hsh = 0; for (const ch of String(id ?? "w")) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  const dx = 60 + (hsh % 7) * 46, dy = 50 + (hsh % 5) * 40;
  const t = String(title ?? id ?? "window").replace(/"/g, "'");
  const src = String(contentSource ?? "");
  const parser = src.trim().startsWith("=") ? "infix" : "f";
  // optional `linked` (array OR a space-separated string of segment names) seeds
  // state.linked at creation so the titlebar shows 🔗 — a STATIC declaration of a
  // link, the seeded twin of winx.drop's runtime bundling. Pure cosmetic
  // indicator; no bundle is granted.
  const link = linkList(linked);
  return { genesis: true, layer: lay, cels: {
    [sref]: { celType: "ValueCel", v: { ref: sref, x: dx, y: dy, w: 440, h: 320, z: 1, min: 0, max: 0, closed: 0, title: t, ...(link && link.length ? { linked: link } : {}) }, metadata: { name: "state" } },
    [cref]: { celType: "FormulaCel", f: src, metadata: { name: "content", parser } },
    [`${lay}.frame`]: { celType: "FormulaCel", f: `(mount ".origin" (winframe ${sref} win.active ${cref}))`, metadata: { name: "frame", parser: "f" } },
  } };
}) as Fn;

// ── generic chat app ─────────────────────────────────────────────────────────
// One chat UI; the OTHER party (claude, grok, a peer) is just a "user". Messages
// live in chat.<channel>.log; chat.send appends your line, then for an LLM
// channel appends the assistant's reply, for a peer channel broadcasts it.
interface Msg { from?: string; text?: string }
const chatFn: Fn = ((channel: unknown, log: unknown, input: unknown): V => {
  const ch = String(channel ?? "chat");
  const msgs: Msg[] = Array.isArray(log) ? log as Msg[] : [];
  const inputVal = input == null ? "" : String(input);
  return el("div", { class: "chat", style: "display:flex;flex-direction:column;height:100%;gap:.4rem" }, [
    el("div", { class: "chat-log", style: "flex:1 1 auto;overflow:auto;display:flex;flex-direction:column;gap:.35rem;padding:.2rem" }, msgs.map((m) => {
      const from = String(m?.from ?? "?"), me = from === "me";
      return el("div", { style: `align-self:${me ? "flex-end" : "flex-start"};max-width:82%;padding:.3rem .55rem;border-radius:.6rem;background:${me ? "#4a90d9" : "#8883"};color:${me ? "white" : "CanvasText"};font-size:.85rem;white-space:pre-wrap` }, [
        el("div", { style: "font-size:.62rem;opacity:.65;margin-bottom:.1rem" }, [T(from)]),
        T(String(m?.text ?? "")),
      ]);
    })),
    el("div", { style: "flex:0 0 auto;display:flex;gap:.3rem" }, [
      el("input", { class: "chat-input", value: inputVal, placeholder: `message ${ch}…`, style: "flex:1;padding:.35rem .5rem;border:1px solid #8884;border-radius:.4rem;font-size:.85rem;background:Canvas;color:CanvasText" }, [], { input: { set: `chat.${ch}.input`, extract: "value" }, keydown: { dispatch: "chat.key", payload: ch } }),
      el("button", { style: "padding:.35rem .8rem;border:1px solid #8884;border-radius:.4rem;cursor:pointer;font-size:.85rem;background:#8881;color:CanvasText" }, [T("send")], { pointerdown: { dispatch: "winx.stop" }, click: { dispatch: "chat.send", payload: ch } }),
    ]),
  ]);
}) as Fn;

const pushMsg = async (state: State, ch: string, m: Msg): Promise<void> => {
  const k = `chat.${ch}.log`; const cur = state.cels.get(k)?.v;
  const log = Array.isArray(cur) ? [...cur as Msg[], m] : [m];
  await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, k, log)); await repaint(state);
};
// ── agentic loop (capability D) — the LLM may edit ITS chat's segment ─────────
// The bot can return COMMANDS in a fenced ```plastron block; each runs under
// withAccessor(<chat segment>), so Layer 1 CONFINES every write to that segment
// (refused by the kernel, not by trusting the model). The cel KEY is also forced
// into the chat's prefix — double-confined. Same executor a peer/game would feed.
const AGENT_PROMPT = "You are in a plastron chat workspace. You MAY edit THIS chat's cels: end your reply with a fenced ```plastron block holding a JSON array of commands — {\"op\":\"cel\",\"key\":\"<name>\",\"value\":<v>} to set a value, {\"op\":\"cel\",\"key\":\"<name>\",\"formula\":\"(+ 1 2)\"} for a formula cel (s-expression: + - * /, cel refs), or {\"op\":\"msg\",\"text\":\"…\"}. Cels are scoped to this chat ONLY. Include the block ONLY when you actually want to change something.\n\n";
const parseCommands = (reply: string): { clean: string; commands: unknown[] } => {
  const m = reply.match(/```(?:plastron|cmds|json)?\s*(\[[\s\S]*?\])\s*```/);
  if (!m) return { clean: reply, commands: [] };
  let commands: unknown[] = [];
  try { const j = JSON.parse(m[1]!); if (Array.isArray(j)) commands = j; } catch { /* malformed → ignore */ }
  return { clean: reply.replace(m[0], "").trim(), commands };
};
const chatSegOf = (state: State, ch: string): string => (state.cels.get(`chat.${ch}.log`)?.metadata as { segment?: string } | undefined)?.segment ?? `win.chat-${ch}`;
const runCommands: Fn = (async (state: State, ch: unknown, commands: unknown): Promise<string[]> => {
  const channel = String(ch); const seg = chatSegOf(state, channel);
  const applied: string[] = [];
  for (const c of (Array.isArray(commands) ? commands : [])) {
    const cmd = c as { op?: string; key?: string; value?: unknown; formula?: string; text?: string };
    if (cmd.op === "msg" && cmd.text != null) { await pushMsg(state, channel, { from: channel, text: String(cmd.text) }); applied.push("msg"); continue; }
    if (cmd.op === "cel" && cmd.key) {
      const name = String(cmd.key).replace(/[^\w-]/g, "");                  // forced into the chat's prefix — can't escape via the key
      if (!name) continue;
      const key = `chat.${channel}.${name}`;
      const spec = cmd.formula != null
        ? { celType: "FormulaCel", f: String(cmd.formula), metadata: { segment: seg, name, parser: "f" } }
        : { celType: "ValueCel", v: cmd.value, metadata: { segment: seg, name } };
      try { await withAccessor(state, seg, () => Promise.resolve((resolveFn(state, "setCel") as Fn)(state, key, spec))); applied.push(`cel ${name}`); }
      catch { applied.push(`refused ${name}`); }                            // Layer 1 confined it
    }
  }
  if (applied.length) await repaint(state);
  return applied;
}) as Fn;

const chatSend: Fn = (async (state: State, channel: unknown): Promise<void> => {
  const ch = String(channel);
  const text = String(state.cels.get(`chat.${ch}.input`)?.v ?? "").trim();
  if (!text) return;
  await Promise.resolve((resolveFn(state, "setValueBatch") as Fn)(state, [[`chat.${ch}.input`, ""]]));
  await pushMsg(state, ch, { from: "me", text });
  if (ch === "claude" || ch === "grok") {                 // LLM channels — the bot is a user
    const client = (state.cels.get(`chat.${ch}.client`)?.v ?? state.cels.get(`clients.${ch}`)?.v) as { __client?: boolean } | undefined;  // explicit, else the clients sheet
    const agentic = !!(state.cels.get(`chat.${ch}.agentic`)?.v);   // opt-in: lets the bot edit this chat's cels
    const prompt = agentic ? AGENT_PROMPT + text : text;
    let reply = "";
    try {
      if (client && client.__client) {                    // a captured CLIENT cel — the chat never touches the key
        reply = String(await (resolveFn(state, "client.send") as Fn)(client, prompt));
      } else {                                            // fallback: a raw key cel (pre-client path)
        const key = state.cels.get("chat.key")?.v ?? state.cels.get(`chat.${ch}.key`)?.v ?? "";
        reply = ch === "claude"
          ? String(await (resolveFn(state, "claude") as Fn)(prompt, key, ""))
          : String(await (resolveFn(state, "llm.chat") as Fn)("", prompt, key, ""));
      }
    } catch (e) { reply = "⚠ " + String((e as { message?: unknown })?.message ?? e); }
    const { clean, commands } = agentic ? parseCommands(reply) : { clean: reply, commands: [] };
    await pushMsg(state, ch, { from: ch, text: clean });
    if (commands.length) { const applied = await (runCommands as unknown as (s: State, c: unknown, cmds: unknown) => Promise<string[]>)(state, ch, commands); if (applied.length) await pushMsg(state, ch, { from: "system", text: "✎ " + applied.join("; ") }); }
  } else {                                                // a peer channel — broadcast over shared.*
    try { await (resolveFn(state, "peersend") as Fn)(state, `shared.chat.${ch}`, { from: "me", text }); } catch { /* offline */ }
  }
}) as Fn;
const chatKey: Fn = (async (state: State, channel: unknown, event?: { key?: string; preventDefault?: () => void }): Promise<void> => {
  if (event?.key === "Enter") { try { event.preventDefault?.(); } catch { /* */ } await (chatSend as unknown as (s: State, c: unknown) => Promise<void>)(state, channel); }
}) as Fn;

// chatapp(channel, title) — a chat WINDOW: seeds the log/input + a winframe whose
// content is (chat channel …). =chatapp("claude","Claude") / chatapp("grok","Grok").
// An LLM channel (claude/grok) reads its client via clients.<channel> (the
// clientsheet whitelists win.chat-<channel> into the clients get-policy), so its
// titlebar seeds 🔗 to surface that link. An explicit `linked` overrides.
const chatappFn: Fn = ((channel: unknown, title: unknown, linked?: unknown): unknown => {
  const ch = String(channel ?? "chat");
  const lay = `win.chat-${ch}`, sref = `${lay}.state`;
  let hsh = 0; for (const c of ch) hsh = (hsh * 31 + c.charCodeAt(0)) >>> 0;
  const dx = 70 + (hsh % 6) * 50, dy = 60 + (hsh % 4) * 44;
  const t = String(title ?? ch).replace(/"/g, "'");
  // optional `linked` seeds state.linked → titlebar 🔗 (see appFn). For an LLM
  // channel, default it to the clients ↔ chat link so the boot call stays bare.
  const link = linkList(linked) ?? ((ch === "claude" || ch === "grok") ? ["clients", lay] : undefined);
  return { genesis: true, layer: lay, cels: {
    [`chat.${ch}.log`]: { celType: "ValueCel", v: [], metadata: { name: "log" } },
    [`chat.${ch}.input`]: { celType: "ValueCel", v: "", metadata: { name: "input" } },
    [sref]: { celType: "ValueCel", v: { ref: sref, x: dx, y: dy, w: 360, h: 460, z: 1, min: 0, max: 0, closed: 0, title: t, ...(link && link.length ? { linked: link } : {}) }, metadata: { name: "state" } },
    [`${lay}.content`]: { celType: "FormulaCel", f: `(chatui "${ch}" chat.${ch}.log chat.${ch}.input)`, metadata: { name: "content", parser: "f" } },
    [`${lay}.frame`]: { celType: "FormulaCel", f: `(mount ".origin" (winframe ${sref} win.active ${lay}.content))`, metadata: { name: "frame", parser: "f" } },
  } };
}) as Fn;

// desktop() — GENESIS: a wallpaper layer with NO bespoke render fn. desktop.bg
// is a plain mount formula over the dom `img` verb; desktop.wallpaper is an
// EDITABLE cel holding an OPFS path ("" → fall through to windows.wallpaper,
// the locked shipped default). Re-skinning the desktop = uploading an image
// and writing its path into a cel — no code, the north-star way.
const desktopFn: Fn = ((): unknown => ({ genesis: true, layer: "desktop", cels: {
  "desktop.wallpaper": { celType: "ValueCel", v: "", metadata: { name: "wallpaper" } },
  "desktop.bg": { celType: "FormulaCel", f: `(mount ".origin" (img desktop.wallpaper windows.wallpaper (attr "class" "desktop-bg") (style "position" "fixed" "inset" "0" "width" "100vw" "height" "100vh" "object-fit" "cover" "z-index" "-1")))`, metadata: { name: "bg", parser: "f" } },
} })) as Fn;

// explorerwin() — GENESIS: a standalone OPFS file-explorer WINDOW. Seeds the
// navigation cels (explorer.cwd = "/", explorer.preview = "") and a content
// formula (explorer explorer.cwd explorer.preview) that REFERENCES them, so
// clicking a folder (→ origin.explorerNav writes explorer.cwd) or a file (→
// origin.explorerOpen writes explorer.preview) re-fires the listing. The
// explorer verb itself lives in origin (where the OPFS vocabulary lives); this
// only wires it into a draggable window with its reactive state.
const explorerwinFn: Fn = ((): unknown => {
  const lay = "win.explorer", sref = `${lay}.state`;
  return { genesis: true, layer: lay, cels: {
    "explorer.cwd": { celType: "ValueCel", v: "/", metadata: { name: "cwd", segment: lay } },
    "explorer.preview": { celType: "ValueCel", v: "", metadata: { name: "preview", segment: lay } },
    "explorer.listing": { celType: "ValueCel", v: { entries: [], previewText: "" }, metadata: { name: "listing", segment: lay } },
    [sref]: { celType: "ValueCel", v: { ref: sref, x: 90, y: 70, w: 460, h: 340, z: 1, min: 0, max: 0, closed: 0, title: "Files" }, metadata: { name: "state" } },
    [`${lay}.content`]: { celType: "FormulaCel", f: "(explorer explorer.cwd explorer.preview explorer.listing)", metadata: { name: "content", parser: "f" } },
    [`${lay}.frame`]: { celType: "FormulaCel", f: `(mount ".origin" (winframe ${sref} win.active ${lay}.content))`, metadata: { name: "frame", parser: "f" } },
  } };
}) as Fn;

// readme() — the plastron readme as a vnode, for a readme WINDOW.
const readmeFn: Fn = ((): V => el("div", { class: "readme", style: "font:13px/1.6 ui-monospace,monospace;padding:.2rem .35rem" }, [
  el("h2", { style: "margin:.15rem 0;font-size:1.1rem" }, [T("元 · plastron")]),
  el("p", { style: "margin:.3rem 0;opacity:.85" }, [T("A reactive cel substrate. Every worksheet is a window; formulas build apps; chat treats claude / grok / peers as users.")]),
  el("p", { style: "margin:.3rem 0 .15rem" }, [T("Type a formula in any cell:")]),
  el("pre", { style: "background:#8881;padding:.45rem;border-radius:.35rem;white-space:pre-wrap;margin:.15rem 0" }, [T('=cels(3, 3)                              a sheet, in its own window\n=chatapp("claude", "Claude")             a chat window\n=winapp("secrets", "Secrets", "(secrets (locked secretsNote) (apiKeys))")   the secrets panel\n=desktop()                               the wallpaper')]),
  el("p", { style: "margin:.35rem 0;opacity:.85" }, [T("Drag a titlebar onto another window's titlebar to make tabs; double-click a tab to pop it back out. ◱ mid · ⛶ max · – min · ✕ close.")]),
]) ) as Fn;

// readmewin() — GENESIS: the readme WINDOW, content = the full plastron README
// (preserved from the original boot, in readme-content.ts).
const readmewinFn: Fn = ((): unknown => {
  const lay = "win.readme", sref = `${lay}.state`;
  return { genesis: true, layer: lay, cels: {
    [sref]: { celType: "ValueCel", v: { ref: sref, x: 60, y: 48, w: 580, h: 500, z: 1, min: 0, max: 0, closed: 0, title: "README" }, metadata: { name: "state" } },
    [`${lay}.content`]: { celType: "FormulaCel", f: README_INNER, metadata: { name: "content", parser: "f" } },
    [`${lay}.frame`]: { celType: "FormulaCel", f: `(mount ".origin" (winframe ${sref} win.active ${lay}.content))`, metadata: { name: "frame", parser: "f" } },
  } };
}) as Fn;

export const name = "windows" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["win", winFn],
  ["winmake", makeFn],
  ["winapp", appFn],
  ["readme", readmeFn], ["readmewin", readmewinFn],
  ["explorerwin", explorerwinFn],
  ["desktop", desktopFn],
  ["chatui", chatFn], ["chat.send", chatSend], ["chat.key", chatKey], ["chat.run", runCommands], ["chatapp", chatappFn],
  ["winframe", frameFn],
  ["winx.grab", xGrab], ["winx.move", xMove], ["winx.grabResize", xGrabResize], ["winx.resizeMove", xResizeMove], ["winx.drop", xDrop],
  ["winx.raise", xRaise], ["winx.min", xMin], ["winx.max", xMax], ["winx.close", xClose], ["winx.show", xShow], ["winx.stop", xStop],
  ["window", windowFn],
  ["win.grab", grabFn],
  ["win.move", moveFn],
  ["win.grabResize", grabResizeFn],
  ["win.resizeMove", resizeMoveFn],
  ["win.drop", dropFn],
  ["win.raise", raiseFn],
  ["win.stop", stopFn],
  ["winopen", openFn],
  ["winclose", closeFn],
  ["win.minimize", minimizeFn],
  ["win.restore", restoreFn],
  ["wintoolbar", toolbarFn],
]));
