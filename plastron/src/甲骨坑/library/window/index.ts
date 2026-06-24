import type { 甲骨, Cel, Fn, State, VNode, AttrValue, EventBinding } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import { el as makeEl, text as T } from "../dom/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// window — the PRIMITIVE, content-AGNOSTIC window frame (windowing-architecture.md).
// One optimized frame that drags / resizes / minimizes / fullscreens / closes AND
// TABS. A window's whole state is ONE cel (the source of truth):
//
//   win.<id>.state = { ref, x, y, w, h, z, min, max, closed, title, icon,
//                      tabs: [ { ref:"<contentCelKey>", title, icon }, … ],
//                      active: <tab index> }
//
// A TAB references a CONTENT CEL OF ANY KIND — a sheet's grid vnode, a wasmcanvas,
// a winapp body. The frame renders `wframe(state, win.active, <activeContent>)`,
// where <activeContent> is the active tab's content cel value; it does NOT care
// what produced it. So a spreadsheet can be tabbed next to DOOM in one frame.
//
// Every control (drag, ✕, min, fullscreen, tab select/close/dock/tear-off) is an
// UPSTREAM write to the window's state cel BY ITS REF, so the frame re-renders.
// This segment knows nothing about sheets, wasm, or toolbars — those compose it.
//
// Scaffolded ADDITIVELY (parallel to `windows`/`sheet-host`): distinct verb keys
// (`wframe`, `window.*`), shared focus/z (win.active / win.topz). At cutover these
// subsume winframe / windowed + the winx.* / winsheet.* handler families.
// ============================================================================

type V = VNode;
const el = makeEl as unknown as (tag: string, attrs?: Record<string, AttrValue>, children?: V[], events?: Record<string, EventBinding>) => V;
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const isVnode = (v: unknown): v is V => !!v && typeof v === "object" && ((v as { type?: unknown }).type === "el" || (v as { type?: unknown }).type === "text");

// A tab references a CONTENT cel (`ref`, what to render) + cached chrome (title/icon)
// + `win`: the source window it was docked FROM (so tear-off restores that exact
// window). `flush` overrides the derived <seg>.flush.
interface Tab { ref: string; title?: string; icon?: string; flush?: string; win?: string }
// `dockedIn` set ⇒ this window is a TAB inside another window (it self-hides; its host
// renders it). Otherwise it is a top-level window that SELF-MOUNTS into .origin.
interface WinState { ref?: string; x?: number; y?: number; w?: number; h?: number; z?: number; min?: number; max?: number; closed?: number; title?: string; icon?: string; tabs?: Tab[]; active?: number; dockedIn?: string }
interface DomEvt { clientX?: number; clientY?: number; pointerId?: number; currentTarget?: { setPointerCapture?: (id: number) => void }; target?: { setPointerCapture?: (id: number) => void } }

// ── shared state plumbing (painting is an explicit effect; drain after a write) ──
const repaint = (s: State): Promise<unknown> => Promise.resolve((resolveFn(s, "drain") as Fn)(s, "dom.paint"));
const stateOf = (s: State, ref: string): WinState => { const v = s.cels.get(ref)?.v; return (v && typeof v === "object" && !Array.isArray(v)) ? { ...(v as WinState) } : {}; };
const setState = (s: State, ref: string, patch: WinState): Promise<unknown> =>
  Promise.resolve((resolveFn(s, "setValue") as Fn)(s, ref, { ...stateOf(s, ref), ...patch })).then(() => repaint(s));
// putV — write a cel, creating it (ValueCel) if it doesn't exist yet (win.list /
// win.topz / win.active / window.drag / a torn-off window's new state cel).
const putV = async (s: State, k: string, v: unknown): Promise<void> => {
  if (s.cels.get(k)) await Promise.resolve((resolveFn(s, "setValue") as Fn)(s, k, v));
  else await Promise.resolve((resolveFn(s, "setCel") as Fn)(s, k, { celType: "ValueCel", v, metadata: { key: k, segment: "window" } }));
};
const listOf = (s: State): string[] => { const v = s.cels.get("win.list")?.v; return Array.isArray(v) ? v.map(String) : []; };
const nextZ = async (s: State): Promise<number> => { const z = (Number(s.cels.get("win.topz")?.v) || 100) + 1; await putV(s, "win.topz", z); return z; };
// A top-level window SELF-MOUNTS: its `<seg>.frame` formula renders the frame around
// its tabs' content cells, so it needs to REFERENCE each tab's content cel (for
// reactivity). dock/undock change the tab set, so they rewrite this formula — the
// price of skipping a central desktop view. Tab-switch / content changes don't rewrite
// (active + contents are already referenced).
const segOf = (ref: string): string => ref.replace(/\.state$/, "");
const frameFormula = (ref: string, tabs: Tab[]): string =>
  `(mount ".origin" (wframe ${ref} win.active ${tabs.map((t) => t.ref).join(" ")}))`;
const rebuildFrame = async (s: State, ref: string): Promise<void> => {
  const fk = `${segOf(ref)}.frame`;
  const f = frameFormula(ref, stateOf(s, ref).tabs ?? []);
  if (s.cels.get(fk)) await Promise.resolve((resolveFn(s, "setValue") as Fn)(s, fk, f));
  else await Promise.resolve((resolveFn(s, "setCel") as Fn)(s, fk, { celType: "FormulaCel", f, metadata: { key: fk, segment: segOf(ref), name: "frame", parser: "f" } }));
};
// Each tab IS an app/window with its own teardown. Its content ref is `<seg>.content`
// / `<seg>.view`, so its contract flush cel is `<seg>.flush` (a tab may override with
// tab.flush). fireFlush runs it if it exists — that's the app's save-then-teardown
// (application-segment-contract.md). Closing a window runs every tab's flush.
const flushKeyOf = (tab: Tab): string => tab.flush ?? `${String(tab.ref).replace(/\.[^.]+$/, "")}.flush`;
const fireFlush = async (s: State, tab: Tab): Promise<boolean> => {
  const k = flushKeyOf(tab);
  if (!s.cels.get(k)) return false;                 // no contract flush → nothing app-specific to run
  const fn = resolveFn(s, k) as Fn | undefined;
  if (typeof fn !== "function") return false;
  await Promise.resolve(fn(s));
  return true;
};
const capture = (e?: DomEvt): void => { try { (e?.currentTarget ?? e?.target)?.setPointerCapture?.(num(e?.pointerId)); } catch { /* off-DOM */ } };
interface DragState { ref: string; ox?: number; oy?: number; resize?: boolean; dir?: string; x0?: number; y0?: number; w0?: number; h0?: number; px?: number; py?: number }
const dragOf = (s: State): DragState | null | undefined => s.cels.get("window.drag")?.v as DragState | null | undefined;

// ── the frame renderer ───────────────────────────────────────────────────────
const BTN = "border:0;background:transparent;cursor:pointer;font:600 .9rem ui-monospace,monospace;padding:0 .3rem;line-height:1";

// 8 resize handles — [direction, position css]. 4 edges (6px) + 4 corners (14px);
// corners come last so they paint over the edges and win the cursor. Ported from
// sheet-host's WIN_RESIZE_EDGES so gen-2 windows resize from every edge/corner.
const WIN_RESIZE_EDGES: ReadonlyArray<readonly [string, string]> = [
  ["n", "top:0;left:0;right:0;height:6px;cursor:ns-resize"],
  ["s", "left:0;right:0;bottom:0;height:6px;cursor:ns-resize"],
  ["e", "top:0;right:0;bottom:0;width:6px;cursor:ew-resize"],
  ["w", "top:0;left:0;bottom:0;width:6px;cursor:ew-resize"],
  ["nw", "top:0;left:0;width:14px;height:14px;cursor:nwse-resize"],
  ["ne", "top:0;right:0;width:14px;height:14px;cursor:nesw-resize"],
  ["sw", "bottom:0;left:0;width:14px;height:14px;cursor:nesw-resize"],
  ["se", "bottom:0;right:0;width:14px;height:14px;cursor:nwse-resize"],
];
const RESIZE_MINW = 160, RESIZE_MINH = 90;

// wframe(state, active, content) — render ONE window. `active` = win.active's value
// (the focused window's ref, for highlight). `content` = the ACTIVE tab's content
// vnode (the host evaluates `tabs[active].ref` and passes its value). Inactive tabs
// are NOT rendered (lazy — only the active content is built).
const wframeFn: Fn = ((st: unknown, active: unknown, ...contents: unknown[]): V => {
  const s = (st && typeof st === "object" && !Array.isArray(st)) ? st as WinState : {};
  const ref = s.ref ?? "win";
  // a docked window is a TAB inside its host — the host renders it, so its own
  // self-mounted frame draws nothing (no double render).
  if (s.dockedIn) return el("div", { class: "pl-win-docked", "data-win": ref, style: "display:none" }, []);
  if (s.closed) return el("div", { class: "pl-win-closed", "data-win": ref, style: "display:none" }, []);
  if (s.min) return el("div", { class: "pl-window-min", "data-win": ref, style: "display:none" }, []);
  const isActive = ref === active;
  const gg = globalThis as { innerWidth?: number; innerHeight?: number };
  const x = s.max ? 0 : num(s.x, 80), y = s.max ? 0 : num(s.y, 80);
  const w = s.max ? num(gg.innerWidth, 1200) : num(s.w, 380);
  const h = s.max ? num(gg.innerHeight, 800) - 46 : num(s.h, 260);
  const z = num(s.z, 1);
  const tabs = Array.isArray(s.tabs) ? s.tabs : [];
  const activeIdx = tabs.length ? Math.max(0, Math.min(tabs.length - 1, num(s.active, 0))) : 0;
  const activeTab = tabs[activeIdx];
  const title = activeTab?.title ?? s.title ?? ref;
  const icon = activeTab?.icon ?? s.icon ?? "";
  // contents[i] is tab i's content value (the frame formula passes one per tab);
  // render the ACTIVE one. (A single content arg also works for a 1-tab window.)
  const content = contents.length > 1 ? contents[activeIdx] : contents[0];
  const body = isVnode(content) ? content : T(content == null ? "" : String(content));

  const ctrlBtn = (cls: string, glyph: string, ttl: string, dispatch: string, color?: string): V =>
    el("button", { class: cls, title: ttl, style: BTN + (color ? `;color:${color}` : "") }, [T(glyph)], { pointerdown: { dispatch: "window.stop" }, click: { dispatch, payload: ref } });
  const titlebar = el("div", { class: "pl-titlebar", style: "flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:.4rem;padding:.25rem .55rem;background:#8881;cursor:move;user-select:none;touch-action:none;font:600 .8rem ui-monospace,monospace" }, [
    el("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto" }, [T((icon ? icon + " " : "") + title)]),
    el("div", { style: "display:flex;flex:0 0 auto;gap:.05rem" }, [
      ctrlBtn("pl-min-btn", "–", "minimize", "window.min"),
      s.max ? ctrlBtn("pl-win-btn", "◱", "mid size", "window.max") : ctrlBtn("pl-win-btn", "⛶", "fullscreen", "window.max"),
      ctrlBtn("pl-close-btn", "✕", "close", "window.close", "#d4453e"),
    ]),
  ], { pointerdown: { dispatch: "window.grab", payload: ref }, pointermove: { dispatch: "window.move" }, pointerup: { dispatch: "window.drop" } });

  // tab strip — only when ≥2 tabs. Each chip: click selects, its ✕ closes the tab,
  // pointerdown starts a tab drag (reorder / tear-off, wired later).
  const tabStrip = tabs.length >= 2 ? el("div", { class: "pl-tabs", style: "flex:0 0 auto;display:flex;gap:.15rem;padding:.25rem .3rem 0;background:#8881;overflow-x:auto" },
    tabs.map((tb, i) => el("button", {
      class: "pl-tab" + (i === activeIdx ? " active" : ""), "data-tab": tb.ref, "data-idx": String(i),
      style: `flex:0 0 auto;border:1px solid #8884;border-bottom:0;border-radius:.3rem .3rem 0 0;background:${i === activeIdx ? "Canvas" : "#8882"};color:CanvasText;cursor:pointer;touch-action:none;user-select:none;font:600 .74rem ui-monospace,monospace;padding:.18rem .55rem;white-space:nowrap;opacity:${i === activeIdx ? "1" : ".7"}`,
    }, [
      T((tb.icon ? tb.icon + " " : "") + (tb.title ?? tb.ref)),
      el("span", { class: "pl-tab-x", title: "close tab", style: "margin-left:.45rem;opacity:.6" }, [T("✕")], { pointerdown: { dispatch: "window.stop" }, click: { dispatch: "window.tabClose", payload: { ref, index: i } } }),
    ], { pointerdown: { dispatch: "window.tabGrab", payload: { ref, index: i } }, click: { dispatch: "window.tab", payload: { ref, index: i } } }))
  ) : null;

  const children: V[] = [titlebar];
  if (tabStrip) children.push(tabStrip);
  children.push(el("div", { class: "pl-window-body", style: "flex:1 1 auto;overflow:auto;padding:.3rem;min-height:0" }, [body]));
  if (!s.max) for (const [dir, pos] of WIN_RESIZE_EDGES) children.push(el("div", {
    class: "pl-resize pl-resize-" + dir,
    style: `position:absolute;${pos};touch-action:none;z-index:6${dir === "se" ? ";background:linear-gradient(135deg,transparent 45%,#8886 45%,#8886 55%,transparent 55%)" : ""}`,
  }, [], { pointerdown: { dispatch: "window.grabResize", payload: { ref, dir } }, pointermove: { dispatch: "window.resizeMove" }, pointerup: { dispatch: "window.drop" } }));

  return el("div", { class: "pl-window" + (isActive ? " active" : ""), "data-win": ref, style: `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:${z};display:flex;flex-direction:column;border:${isActive ? "2px solid #4a90d9" : "1px solid #8886"};border-radius:6px;background:Canvas;box-shadow:${isActive ? "0 6px 22px #4a90d966" : "0 4px 16px #0004"};overflow:hidden` }, children, { pointerdown: { dispatch: "window.raise", payload: ref } });
}) as Fn;

// ── drag / resize / focus / state controls (operate on the state cel by ref) ──
const grab: Fn = (async (s: State, ref: unknown, e?: DomEvt): Promise<void> => { const r = String(ref); capture(e); const st = stateOf(s, r); await putV(s, "window.drag", { ref: r, ox: num(e?.clientX) - num(st.x, 80), oy: num(e?.clientY) - num(st.y, 80) }); }) as Fn;
const move: Fn = (async (s: State, _p: unknown, e?: DomEvt): Promise<void> => { const d = dragOf(s); if (!d || d.resize) return; await setState(s, d.ref, { x: num(e?.clientX) - num(d.ox), y: num(e?.clientY) - num(d.oy) }); }) as Fn;
// grabResize — payload is { ref, dir } (dir ∈ n/s/e/w/nw/ne/sw/se); a bare string ref
// is tolerated for backward compat (treated as "se"). Snapshots the start rect +
// pointer so resizeMove can anchor the OPPOSITE edge with absolute deltas.
const grabResize: Fn = (async (s: State, payload: unknown, e?: DomEvt): Promise<void> => {
  capture(e);
  const p = (payload && typeof payload === "object" && !Array.isArray(payload)) ? payload as { ref?: unknown; dir?: unknown } : { ref: payload, dir: "se" };
  const r = String(p.ref); const dir = String(p.dir ?? "se"); const st = stateOf(s, r);
  await putV(s, "window.drag", { ref: r, resize: true, dir, x0: num(st.x, 80), y0: num(st.y, 80), w0: num(st.w, 380), h0: num(st.h, 260), px: num(e?.clientX), py: num(e?.clientY) });
}) as Fn;
// resizeMove — resize per direction: e/w change width (w also moves x), n/s change
// height (n also moves y), corners combine. Min sizes preserved (w>=160, h>=90).
const resizeMove: Fn = (async (s: State, _p: unknown, e?: DomEvt): Promise<void> => {
  const d = dragOf(s); if (!d?.resize) return;
  const dir = String(d.dir ?? "se");
  const dx = num(e?.clientX) - num(d.px), dy = num(e?.clientY) - num(d.py);
  let x = num(d.x0), y = num(d.y0), w = num(d.w0), h = num(d.h0);
  if (dir.includes("e")) w = Math.max(RESIZE_MINW, num(d.w0) + dx);
  if (dir.includes("s")) h = Math.max(RESIZE_MINH, num(d.h0) + dy);
  if (dir.includes("w")) { const nw = Math.max(RESIZE_MINW, num(d.w0) - dx); x = num(d.x0) + (num(d.w0) - nw); w = nw; }
  if (dir.includes("n")) { const nh = Math.max(RESIZE_MINH, num(d.h0) - dy); y = num(d.y0) + (num(d.h0) - nh); h = nh; }
  await setState(s, d.ref, { x, y, w, h });
}) as Fn;
const drop: Fn = (async (s: State): Promise<void> => { await putV(s, "window.drag", null); }) as Fn;
const raise: Fn = (async (s: State, ref: unknown): Promise<void> => { const r = String(ref); await putV(s, "win.active", r); await setState(s, r, { z: await nextZ(s) }); }) as Fn;
const minimize: Fn = (async (s: State, ref: unknown): Promise<void> => { const r = String(ref); const st = stateOf(s, r); await setState(s, r, { min: st.min ? 0 : 1 }); }) as Fn;
const maximize: Fn = (async (s: State, ref: unknown): Promise<void> => { const r = String(ref); const st = stateOf(s, r); await setState(s, r, { max: st.max ? 0 : 1, z: await nextZ(s) }); }) as Fn;
// close — run EACH tab's <seg>.flush (every tab is an app with its own teardown),
// then drop the window. (Full destroy — remove from win.list / flush the segment from
// memory — lands with the desktop view + the contract phase; for now: closed:1.)
const close: Fn = (async (s: State, ref: unknown): Promise<void> => {
  const r = String(ref); const st = stateOf(s, r);
  for (const tab of st.tabs ?? []) await fireFlush(s, tab);
  // a WORKBOOK has no `tabs` — run the window segment's own <seg>.flush so the
  // sheetapp doc save-on-close hook (win.<doc>.flush) still fires on close.
  const wf = resolveFn(s, `${segOf(r)}.flush`) as Fn | undefined;
  if (typeof wf === "function") { try { await wf(s); } catch { /* best-effort save */ } }
  await setState(s, r, { closed: 1 });
}) as Fn;
const stop: Fn = ((_s: State, _p: unknown, e?: { stopPropagation?: () => void }): void => { try { e?.stopPropagation?.(); } catch { /* off-DOM */ } }) as Fn;

// ── tabs: select / close / dock (combine windows) / reorder / tear-off ────────
const clampActive = (len: number, a: number, removed: number): number => Math.max(0, Math.min(len - 1, a > removed ? a - 1 : a));
const tabSelect: Fn = (async (s: State, payload: unknown): Promise<void> => { const p = payload as { ref?: string; index?: number }; if (!p?.ref) return; await setState(s, p.ref, { active: num(p.index, 0) }); }) as Fn;
const tabClose: Fn = (async (s: State, payload: unknown): Promise<void> => {
  const p = payload as { ref?: string; index?: number }; if (!p?.ref) return;
  const st = stateOf(s, p.ref); const tabs = [...(st.tabs ?? [])]; const i = num(p.index, 0);
  if (i < 0 || i >= tabs.length) return;
  const [removed] = tabs.splice(i, 1);
  await fireFlush(s, removed!);                                 // this one tab/app tears down
  if (removed!.win) await setState(s, removed!.win, { closed: 1 });   // and its backing window, if any
  if (tabs.length === 0) { await setState(s, p.ref, { closed: 1 }); return; }
  await setState(s, p.ref, { tabs, active: clampActive(tabs.length, num(st.active, 0), i) });
  await rebuildFrame(s, p.ref);
}) as Fn;
// dock — COMBINE windows: pull `win` (an existing window) in as a tab of `into`, OR
// append a raw `tab` ({ref:<contentCel>, title, icon}). When docking a window, mark
// it dockedIn (it self-hides; the host renders it) and remember it as the tab's `win`
// so tear-off restores that exact window. The host frame is rebuilt to reference the
// new content cel (so it stays reactive — the cost of self-mounting, no central view).
const dock: Fn = (async (s: State, payload: unknown): Promise<void> => {
  const p = payload as { into?: string; win?: string; tab?: Tab }; if (!p?.into) return;
  let tab: Tab | undefined;
  if (p.win) { const ws = stateOf(s, p.win); tab = { ...(ws.tabs?.[0] ?? { ref: `${segOf(p.win)}.content` }), title: ws.title ?? ws.tabs?.[0]?.title, win: p.win }; }
  else if (p.tab?.ref) tab = p.tab;
  if (!tab?.ref) return;
  const st = stateOf(s, p.into); const tabs = [...(st.tabs ?? []), tab];
  await setState(s, p.into, { tabs, active: tabs.length - 1, closed: 0, min: 0 });
  if (p.win) await setState(s, p.win, { dockedIn: p.into });
  await rebuildFrame(s, p.into);
}) as Fn;
const reorder: Fn = (async (s: State, payload: unknown): Promise<void> => {
  const p = payload as { ref?: string; from?: number; to?: number }; if (!p?.ref) return;
  const st = stateOf(s, p.ref); const tabs = [...(st.tabs ?? [])]; const from = num(p.from), to = num(p.to);
  if (from < 0 || from >= tabs.length || to < 0 || to >= tabs.length) return;
  const [m] = tabs.splice(from, 1); tabs.splice(to, 0, m!); await setState(s, p.ref, { tabs, active: to });
  await rebuildFrame(s, p.ref);
}) as Fn;
// undock(ref, index) — tear a tab OUT (inverse of dock): remove it from `ref` + rebuild
// `ref`'s frame. If the tab backs a real window (tab.win — docked via dock), RESTORE it
// (clear dockedIn → it self-mounts again at its own geometry). Otherwise mint a fresh
// standalone window for the content + add it to win.list.
const undock: Fn = (async (s: State, payload: unknown): Promise<void> => {
  const p = payload as { ref?: string; index?: number }; if (!p?.ref) return;
  const st = stateOf(s, p.ref); const tabs = [...(st.tabs ?? [])]; const i = num(p.index, 0);
  if (i < 0 || i >= tabs.length || tabs.length < 2) return;     // need ≥2 to tear one off
  const [tab] = tabs.splice(i, 1);
  await setState(s, p.ref, { tabs, active: clampActive(tabs.length, num(st.active, 0), i) });
  await rebuildFrame(s, p.ref);
  if (tab!.win) { await setState(s, tab!.win, { dockedIn: undefined, z: await nextZ(s) }); return; }  // restore the existing window
  const newRef = `win.${String(tab!.ref).replace(/[^\w]/g, "_")}.state`;
  const z = await nextZ(s);
  await putV(s, newRef, { ref: newRef, x: num(st.x, 80) + 40, y: num(st.y, 80) + 40, w: num(st.w, 380), h: num(st.h, 260), z, min: 0, max: 0, closed: 0, tabs: [tab], active: 0 });
  await putV(s, `${segOf(newRef)}.frame`, frameFormula(newRef, [tab!]));   // its self-mounting frame
  const list = listOf(s); if (!list.includes(newRef)) await putV(s, "win.list", [...list, newRef]);
  await repaint(s);
}) as Fn;
// tabGrab — pointerdown on a chip; records the grab so a later move can reorder /
// a release outside can tear off. (Reorder/tear-off DnD wiring lands with the
// desktop view; for now the grab just seeds window.tabdrag.)
const tabGrab: Fn = (async (s: State, payload: unknown, e?: DomEvt): Promise<void> => { const p = payload as { ref?: string; index?: number }; if (!p?.ref) return; capture(e); await putV(s, "window.tabdrag", { ref: p.ref, index: num(p.index, 0) }); }) as Fn;

// ── the constructor ──────────────────────────────────────────────────────────
// wopen(id, title, body, where?) — genesis a SELF-MOUNTING window:
//   win.<id>.content  FormulaCel = body (the app's render)
//   win.<id>.state    its window state (one tab = its own content)
//   win.<id>.frame    (mount ".origin" (wframe <state> win.active <content>))  ← self-mounts
// `where` = geom(x,y,w,h) sizes it. To DOCK on create instead of standing alone, call
// wopen then window.dock({into:<host>, win:"win.<id>.state"}) (a one-call sugar can wrap
// these once origin's genesis drain routes a host arg). No central desktop view: the
// frame mounts itself, so a window IS the renderer.
interface WGeom { x?: number; y?: number; w?: number; h?: number; minW?: number; minH?: number }
const wopen: Fn = ((id: unknown, title: unknown, body: unknown, where?: unknown): unknown => {
  const lay = `win.${String(id ?? "w")}`;
  const sref = `${lay}.state`, cref = `${lay}.content`;
  const t = String(title ?? id ?? "window");
  const src = String(body ?? "");
  const g: WGeom = (where && typeof where === "object" && "__geom" in (where as object)) ? (where as { __geom: WGeom }).__geom : {};
  const tab: Tab = { ref: cref, title: t, flush: `${lay}.flush` };
  return { genesis: true, kind: "window", layer: lay, cels: {
    [cref]: { celType: "FormulaCel", f: src, metadata: { name: "content", parser: src.trim().startsWith("=") ? "infix" : "f" } },
    [sref]: { celType: "ValueCel", v: { ref: sref, x: g.x ?? 90, y: g.y ?? 70, w: g.w ?? 440, h: g.h ?? 320, z: 1, min: 0, max: 0, closed: 0, title: t, tabs: [tab], active: 0 }, metadata: { name: "state" } },
    [`${lay}.frame`]: { celType: "FormulaCel", f: frameFormula(sref, [tab]), metadata: { name: "frame", parser: "f" } },
  } };
}) as Fn;

// ── the WORKBOOK frame: two tabbed panes (sheets ‖ dom-views) + per-pane fullscreen ──
// A workbook window hosts TWO tab stacks at once: worksheets (left, Excel-style tabs
// at the bottom) and dom views (right, tabs on top) — both visible, split by a
// draggable divider. `wb.full` fullscreens one pane ("L"/"R"); "" shows both.
// State (on the window's state cel): { …geom…, sheets:[Tab], asheet, views:[Tab],
// aview, split:0..1, full:"L"|"R"|"" }. The frame formula references every sheet AND
// view content cel; wbframe slices `contents` by sheets.length (lead = sheets, rest
// = views). Realizes the sheetapp workbook DoD (cross-sheet refs + dom views +
// fullscreen toggle).
interface WbTool { icon?: string; title?: string; dispatch?: string }
interface WbState extends WinState { sheets?: Tab[]; asheet?: number; views?: Tab[]; aview?: number; split?: number; full?: string; tools?: WbTool[] }
const wbStateOf = (s: State, ref: string): WbState => stateOf(s, ref) as WbState;
const wbFrameFormula = (ref: string, sheets: Tab[], views: Tab[]): string =>
  `(mount ".origin" (wbframe ${ref} win.active ${[...sheets, ...views].map((t) => t.ref).join(" ")}))`;

const TABBTN = (on: boolean, top: boolean): string =>
  `flex:0 0 auto;border:1px solid #8884;border-${top ? "bottom" : "top"}:0;border-radius:${top ? ".3rem .3rem 0 0" : "0 0 .3rem .3rem"};background:${on ? "Canvas" : "#8882"};color:CanvasText;cursor:pointer;font:600 .72rem ui-monospace,monospace;padding:.16rem .5rem;white-space:nowrap;opacity:${on ? "1" : ".7"}`;
const tabRow = (tabs: Tab[], active: number, dispatch: string, ref: string, top: boolean, fullBtn: V): V =>
  el("div", { class: top ? "pl-wb-vtabs" : "pl-wb-stabs", style: `flex:0 0 auto;display:flex;gap:.15rem;padding:${top ? "0 .3rem .15rem" : ".15rem .3rem 0"};background:#8881;overflow-x:auto;align-items:center` },
    [...tabs.map((tb, i) => el("button", { class: "pl-wb-tab" + (i === active ? " active" : ""), "data-idx": String(i), style: TABBTN(i === active, top) },
      [T((tb.icon ? tb.icon + " " : "") + (tb.title ?? tb.ref))], { click: { dispatch, payload: { ref, index: i } } })), fullBtn]);

// wbframe(state, active, …contents) — render one workbook window.
const wbframeFn: Fn = ((st: unknown, active: unknown, ...contents: unknown[]): V => {
  const s = (st && typeof st === "object" && !Array.isArray(st)) ? st as WbState : {};
  const ref = s.ref ?? "win";
  if (s.dockedIn) return el("div", { class: "pl-win-docked", "data-win": ref, style: "display:none" }, []);
  if (s.closed) return el("div", { class: "pl-win-closed", "data-win": ref, style: "display:none" }, []);
  if (s.min) return el("div", { class: "pl-window-min", "data-win": ref, style: "display:none" }, []);
  const isActive = ref === active;
  const gg = globalThis as { innerWidth?: number; innerHeight?: number };
  const x = s.max ? 0 : num(s.x, 80), y = s.max ? 0 : num(s.y, 80);
  const w = s.max ? num(gg.innerWidth, 1200) : num(s.w, 640);
  const h = s.max ? num(gg.innerHeight, 800) - 46 : num(s.h, 440);
  const z = num(s.z, 1);
  const sheets = Array.isArray(s.sheets) ? s.sheets : [];
  const views = Array.isArray(s.views) ? s.views : [];
  const asheet = sheets.length ? Math.max(0, Math.min(sheets.length - 1, num(s.asheet, 0))) : 0;
  const aview = views.length ? Math.max(0, Math.min(views.length - 1, num(s.aview, 0))) : 0;
  const sheetBodies = contents.slice(0, sheets.length);
  const viewBodies = contents.slice(sheets.length);
  // an empty pane forces the other to full width (a sheets-only doc reads as one
  // clean pane, no divider); otherwise honor the user's fullscreen toggle.
  const onlyOne = (views.length === 0 && sheets.length > 0) ? "L" : (sheets.length === 0 && views.length > 0) ? "R" : "";
  const full = onlyOne || (s.full === "L" || s.full === "R" ? s.full : "");
  const split = Math.max(0.15, Math.min(0.85, num(s.split, 0.6)));
  const bodyOf = (v: unknown): V => isVnode(v) ? v as V : T(v == null ? "" : String(v));

  const fullBtn = (pane: string): V => el("button", { class: "pl-wb-full", title: "fullscreen this pane", style: "margin-left:auto;border:0;background:transparent;cursor:pointer;font:.8rem ui-monospace,monospace;padding:0 .35rem;opacity:.7" },
    [T(full === pane ? "🗗" : "⛶")], { pointerdown: { dispatch: "window.stop" }, click: { dispatch: "window.paneFull", payload: { ref, pane } } });

  const leftPane = el("div", { class: "pl-wb-left", style: `display:flex;flex-direction:column;min-width:0;min-height:0;${full === "L" ? "flex:1 1 100%" : full === "R" ? "display:none" : `flex:0 0 ${(split * 100).toFixed(1)}%`}` }, [
    el("div", { class: "pl-wb-sbody", style: "flex:1 1 auto;overflow:auto;min-height:0;padding:.3rem" }, [bodyOf(sheetBodies[asheet])]),
    tabRow(sheets, asheet, "window.sheetTab", ref, false, fullBtn("L")),
  ]);
  const divider = el("div", { class: "pl-wb-divider", style: "flex:0 0 6px;cursor:col-resize;background:#8883;touch-action:none" }, [],
    { pointerdown: { dispatch: "window.splitGrab", payload: ref }, pointermove: { dispatch: "window.splitMove" }, pointerup: { dispatch: "window.drop" } });
  const rightPane = el("div", { class: "pl-wb-right", style: `display:flex;flex-direction:column;min-width:0;min-height:0;${full === "R" ? "flex:1 1 100%" : full === "L" ? "display:none" : "flex:1 1 auto"}` }, [
    tabRow(views, aview, "window.viewTab", ref, true, fullBtn("R")),
    el("div", { class: "pl-wb-vbody", style: "flex:1 1 auto;overflow:auto;min-height:0;padding:.3rem;background:#0000000a" }, [bodyOf(viewBodies[aview])]),
  ]);

  const ctrlBtn = (cls: string, glyph: string, ttl: string, dispatch: string, color?: string): V =>
    el("button", { class: cls, title: ttl, style: BTN + (color ? `;color:${color}` : "") }, [T(glyph)], { pointerdown: { dispatch: "window.stop" }, click: { dispatch, payload: ref } });
  // app-supplied toolbar (e.g. sheetapp's 💾 Save) — generic: each tool dispatches
  // its own verb with the window ref as payload, so `window` stays decoupled.
  const tools = Array.isArray(s.tools) ? s.tools : [];
  const toolBtn = (tl: WbTool): V => el("button", { class: "pl-wb-tool", title: tl.title ?? "", style: BTN }, [T(tl.icon ?? "•")], { pointerdown: { dispatch: "window.stop" }, click: { dispatch: String(tl.dispatch ?? ""), payload: ref } });
  const titlebar = el("div", { class: "pl-titlebar", style: "flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:.4rem;padding:.25rem .55rem;background:#8881;cursor:move;user-select:none;touch-action:none;font:600 .8rem ui-monospace,monospace" }, [
    el("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto" }, [T((s.icon ? s.icon + " " : "📚 ") + (s.title ?? ref))]),
    el("div", { class: "pl-wb-tools", style: "display:flex;flex:0 0 auto;gap:.1rem" }, tools.map(toolBtn)),
    el("div", { style: "display:flex;flex:0 0 auto;gap:.05rem" }, [
      ctrlBtn("pl-min-btn", "–", "minimize", "window.min"),
      s.max ? ctrlBtn("pl-win-btn", "◱", "mid size", "window.max") : ctrlBtn("pl-win-btn", "⛶", "fullscreen", "window.max"),
      ctrlBtn("pl-close-btn", "✕", "close", "window.close", "#d4453e"),
    ]),
  ], { pointerdown: { dispatch: "window.grab", payload: ref }, pointermove: { dispatch: "window.move" }, pointerup: { dispatch: "window.drop" } });

  const row = el("div", { class: "pl-wb-row", style: "flex:1 1 auto;display:flex;min-height:0;overflow:hidden" },
    [leftPane, ...(full === "" ? [divider] : []), rightPane]);
  const children: V[] = [titlebar, row];
  if (!s.max) children.push(el("div", { class: "pl-resize", style: "position:absolute;right:0;bottom:0;width:15px;height:15px;cursor:nwse-resize;touch-action:none;background:linear-gradient(135deg,transparent 45%,#8886 45%,#8886 55%,transparent 55%)" }, [], { pointerdown: { dispatch: "window.grabResize", payload: { ref, dir: "se" } }, pointermove: { dispatch: "window.resizeMove" }, pointerup: { dispatch: "window.drop" } }));
  return el("div", { class: "pl-window pl-workbook" + (isActive ? " active" : ""), "data-win": ref, style: `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:${z};display:flex;flex-direction:column;border:${isActive ? "2px solid #4a90d9" : "1px solid #8886"};border-radius:6px;background:Canvas;box-shadow:${isActive ? "0 6px 22px #4a90d966" : "0 4px 16px #0004"};overflow:hidden` }, children, { pointerdown: { dispatch: "window.raise", payload: ref } });
}) as Fn;

// workbook tab / pane handlers (upstream writes to the state cel → re-render)
const sheetTab: Fn = (async (s: State, payload: unknown): Promise<void> => { const p = payload as { ref?: string; index?: number }; if (!p?.ref) return; await setState(s, p.ref, { asheet: num(p.index, 0) } as WinState); }) as Fn;
const viewTab: Fn = (async (s: State, payload: unknown): Promise<void> => { const p = payload as { ref?: string; index?: number }; if (!p?.ref) return; await setState(s, p.ref, { aview: num(p.index, 0) } as WinState); }) as Fn;
const paneFull: Fn = (async (s: State, payload: unknown): Promise<void> => { const p = payload as { ref?: string; pane?: string }; if (!p?.ref) return; const cur = wbStateOf(s, p.ref).full ?? ""; await setState(s, p.ref, { full: cur === p.pane ? "" : String(p.pane ?? "") } as WinState); }) as Fn;
const splitGrab: Fn = (async (s: State, ref: unknown, e?: DomEvt): Promise<void> => { capture(e); await putV(s, "window.drag", { ref: String(ref), ox: 0, oy: 0, split: true }); }) as Fn;
const splitMove: Fn = (async (s: State, _p: unknown, e?: DomEvt): Promise<void> => { const d = s.cels.get("window.drag")?.v as { ref?: string; split?: boolean } | undefined; if (!d?.split || !d.ref) return; const st = wbStateOf(s, d.ref); const x = num(st.x, 80), w = Math.max(1, num(st.w, 640)); const frac = (num(e?.clientX) - x) / w; await setState(s, d.ref, { split: Math.max(0.15, Math.min(0.85, frac)) } as WinState); }) as Fn;

// wbopen(id, title, sheetTabs, viewTabs, where?) — genesis a SELF-MOUNTING workbook
// window. sheetTabs/viewTabs are [{ref, title, icon}] over existing content cels.
const wbopen: Fn = ((id: unknown, title: unknown, sheetTabsArg: unknown, viewTabsArg: unknown, where?: unknown): unknown => {
  const lay = `win.${String(id ?? "wb")}`; const sref = `${lay}.state`;
  const t = String(title ?? id ?? "workbook");
  const asTabs = (a: unknown): Tab[] => Array.isArray(a) ? a.filter((x) => x && typeof x === "object" && (x as Tab).ref).map((x) => x as Tab) : [];
  const sheets = asTabs(sheetTabsArg), views = asTabs(viewTabsArg);
  const g: WGeom = (where && typeof where === "object" && "__geom" in (where as object)) ? (where as { __geom: WGeom }).__geom : {};
  return { genesis: true, kind: "window", layer: lay, cels: {
    [sref]: { celType: "ValueCel", v: { ref: sref, x: g.x ?? 100, y: g.y ?? 70, w: g.w ?? 760, h: g.h ?? 500, z: 1, min: 0, max: 0, closed: 0, title: t, sheets, asheet: 0, views, aview: 0, split: 0.58, full: "" }, metadata: { name: "state" } },
    [`${lay}.frame`]: { celType: "FormulaCel", f: wbFrameFormula(sref, sheets, views), metadata: { name: "frame", parser: "f" } },
  } };
}) as Fn;

// rebuild a workbook's self-mounting frame formula after its sheet/view stacks
// change (so it references every content cell — same price as wframe's rebuildFrame).
const rebuildWbFrame = async (s: State, ref: string): Promise<void> => {
  const st = wbStateOf(s, ref); const fk = `${segOf(ref)}.frame`;
  const f = wbFrameFormula(ref, st.sheets ?? [], st.views ?? []);
  if (s.cels.get(fk)) await Promise.resolve((resolveFn(s, "setValue") as Fn)(s, fk, f));
  else await Promise.resolve((resolveFn(s, "setCel") as Fn)(s, fk, { celType: "FormulaCel", f, metadata: { key: fk, segment: segOf(ref), name: "frame", parser: "f" } }));
};
// window.addView / window.addSheet — push a NEW tab onto a workbook's view (dom)
// or sheet stack: { ref:<win.<id>.state>, viewRef:<contentCelKey>, title?, f?:<formula> }.
// If `f` is given, the content cel is authored (a FormulaCel) first — so a formula
// can OPEN a fresh dom window in the stack. The new tab is selected + the frame
// rebuilt to reference its content cell (reactivity).
const addPane = (paneKey: "views" | "sheets", activeKey: "aview" | "asheet"): Fn => (async (s: State, payload: unknown): Promise<void> => {
  const p = (payload ?? {}) as { ref?: string; viewRef?: string; title?: string; icon?: string; f?: string };
  if (!p.ref || !p.viewRef) return;
  if (typeof p.f === "string") {
    if (s.cels.get(p.viewRef)) await Promise.resolve((resolveFn(s, "setValue") as Fn)(s, p.viewRef, p.f));
    else await Promise.resolve((resolveFn(s, "setCel") as Fn)(s, p.viewRef, { celType: "FormulaCel", f: p.f, metadata: { key: p.viewRef, segment: p.viewRef.split(".")[0], name: p.viewRef.split(".").slice(1).join("."), parser: "infix" } }));
  }
  const st = wbStateOf(s, p.ref);
  const list = [...((st[paneKey] as Tab[] | undefined) ?? []), { ref: p.viewRef, title: p.title ?? p.viewRef, ...(p.icon ? { icon: p.icon } : {}) }];
  await setState(s, p.ref, { [paneKey]: list, [activeKey]: list.length - 1 } as WinState);
  await rebuildWbFrame(s, p.ref);
}) as Fn;
const addView = addPane("views", "aview");
const addSheet = addPane("sheets", "asheet");

export const name = "window" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["wframe", wframeFn], ["wopen", wopen], ["wbframe", wbframeFn], ["wbopen", wbopen],
  ["window.grab", grab], ["window.move", move], ["window.grabResize", grabResize], ["window.resizeMove", resizeMove], ["window.drop", drop],
  ["window.raise", raise], ["window.min", minimize], ["window.max", maximize], ["window.close", close], ["window.stop", stop],
  ["window.tab", tabSelect], ["window.tabClose", tabClose], ["window.dock", dock], ["window.reorder", reorder], ["window.undock", undock], ["window.tabGrab", tabGrab],
  ["window.sheetTab", sheetTab], ["window.viewTab", viewTab], ["window.paneFull", paneFull], ["window.splitGrab", splitGrab], ["window.splitMove", splitMove],
  ["window.addView", addView], ["window.addSheet", addSheet],
]));
