import type { State, Key, Fn, VNode, AttrValue, EventBinding, 甲骨, Cel } from "../../../types/index.js";
import { resolveFn, bindNativeFns } from "../../../kernel/index.js";
import { el as makeEl, text } from "../dom/index.js";
import seed from "./甲骨.json" with { type: "json" };

const el = (tag: string, attrs: Record<string, unknown>, children: VNode[], events?: Record<string, unknown>): VNode =>
  makeEl(tag, attrs as Record<string, AttrValue>, children, events as Record<string, EventBinding> | undefined);

// The generic WASI host an engine's harness composes with its own env.* ABI — the
// reusable half of doom-harness. A TS export (it closes over a live wasm instance /
// memory, so it's harness glue, not a formula verb). See wasi-host.ts.
export { createWasiHost } from "./wasi-host.js";
export type { WasiHost, WasiHostOptions, WasiInstance } from "./wasi-host.js";

// ============================================================================
// winapps-wasm — the WASM-app specifics of the windowed-app stack
// (windowing-architecture.md). A wasm app = a `window` (the tabbable frame) whose
// content is a <canvas> the engine draws to, plus the graph↔engine message bridge
// + ACTIVE-gated key routing. Everything PECULIAR to wasm apps lives here; generic
// chrome + install live in `winapps`; the frame in `window`.
//
// This segment is the single home for the wasm-window kind: the canvas/bridge/key
// LockedLambdas (wasmcanvas + wasmwin.focus/blur/key), the graph↔engine bridge
// (graphBridge/isActive/wasmKey), and `wasmapp` — the genesis that builds the
// window on the new `wframe`, so a DOOM tab can sit next to a sheet. (Folds in the
// retired `wasm-window` segment.)
// ============================================================================

const lay = (id: string): Key => `wasm.${id}`;

// ── the graph bridge: host imports a graph-aware wasm engine calls ───────────
export interface GraphBridge { recv(): unknown; send(v: unknown): void; active(): boolean }

/** Host fns that bridge a wasm engine (window `id`) to the graph: `recv()` reads
 *  the inbox cel (graph→engine), `send(v)` writes the outbox cel (engine→graph),
 *  `active()` reports focus. Pure over `state` — a provider merges these into its
 *  `host.*` imports; testable without a live instance. */
export const graphBridge = (state: State, id: string): GraphBridge => {
  const setValue = resolveFn(state, "setValue") as Fn;
  return {
    recv: () => state.cels.get(`${lay(id)}.in`)?.v ?? null,
    send: (v: unknown) => { void setValue(state, `${lay(id)}.out`, v); },
    active: () => !!state.cels.get(`${lay(id)}.active`)?.v,
  };
};

// ── active-gated key routing ────────────────────────────────────────────────
export interface KeyEvent { type?: string; code?: string; key?: string; keyCode?: number }

/** Should a keystroke reach window `id`'s engine? Only when it is the ACTIVE wasm
 *  window — so a key meant for the focused game doesn't leak into another. The
 *  engine's own listeners (e.g. doom-harness's global keydown/keyup) should consult
 *  this, or the host should route through `wasmKey`. */
export const isActive = (state: State, id: string): boolean =>
  !!state.cels.get(`${lay(id)}.active`)?.v;

/** Route a keystroke to window `id`'s engine if it is active, by writing the
 *  inbox the engine polls: { key, code, down }. Returns whether it was delivered.
 *  (The real-time path is the engine's own canvas/window listeners; this is the
 *  graph-visible, testable routing + the path a JAILED engine gets via postMessage.) */
export const wasmKey = (state: State, id: string, event: KeyEvent): boolean => {
  if (!isActive(state, id)) return false;
  const setValue = resolveFn(state, "setValue") as Fn;
  void setValue(state, `${lay(id)}.in`, { key: event.key, code: event.code, down: event.type !== "keyup" });
  return true;
};

// ── the canvas renderer (the thing keys land on) ────────────────────────────
const OVERLAY_STYLE =
  "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;" +
  "background:#000;color:#eee;font-family:system-ui,sans-serif;text-align:center;padding:16px;box-sizing:border-box";

/** Boot status (the `.out` cel) → a loading/error overlay vnode, or null once the
 *  engine is running (so the bare canvas shows). The engine streams its boot
 *  through `.out` (fetching… → creating harness… → starting… → running, or
 *  `#ERROR(…)` on failure); the content formula passes that here so a missing
 *  asset surfaces as a readable card instead of a silent black canvas. */
const bootOverlay = (status: unknown): VNode | null => {
  const s = status == null ? "" : String(status);
  if (s.startsWith("#ERROR")) {
    const detail = s.replace(/^#ERROR\(/, "").replace(/\)$/, "");
    const notFound = /HTTP (404|0|5\d\d)|not found|Failed to fetch|NetworkError/i.test(detail);
    return el("div", { class: "wasm-overlay wasm-overlay-error", style: OVERLAY_STYLE }, [
      el("div", { style: "font-size:40px;line-height:1" }, [text("💀")]),
      el("div", { style: "font-weight:600;font-size:16px;margin-top:10px" }, [text("DOOM could not load")]),
      el("div", { style: "font-size:13px;opacity:.85;margin-top:6px;max-width:90%" }, [
        text(notFound ? "Game files were not found — doom.wasm / freedoom1.wad are missing from the server." : detail),
      ]),
      el("div", { class: "wasm-overlay-detail", style: "font-size:11px;opacity:.5;margin-top:10px;font-family:monospace;word-break:break-all;max-width:90%" }, [text(detail)]),
    ]);
  }
  // loading: the known boot messages (empty/armed before the first fetch, the
  // asset-loader's fetching/cached/saved, then creating harness…/starting…).
  const loading = s === "" || s === "armed" ||
    /^(fetching|cached|saved) /.test(s) || s === "creating harness…" || s === "starting…";
  if (!loading) return null; // running / stopped / exited / engine data → no overlay
  const label =
    s === "" || s === "armed" ? "Gathering files…" :
    /^fetching (.+)…$/.test(s) ? `Downloading ${s.replace(/^fetching (.+)…$/, "$1")}…` :
    /^cached (.+)$/.test(s) ? `Loading ${s.replace(/^cached (.+)$/, "$1")} (cached)…` :
    /^saved (.+)$/.test(s) ? `Caching ${s.replace(/^saved (.+)$/, "$1")}…` :
    s === "creating harness…" ? "Starting engine…" :
    s === "starting…" ? "Launching…" : "Loading…";
  // a stepped bar — no byte-progress is available, so advance through the known
  // boot stages (the WAD is the big download, so it gets the widest band).
  const pct =
    /freedoom1\.wad/.test(s) ? (/^fetching/.test(s) ? 30 : 50) :
    /doom\.wasm/.test(s) ? (/^fetching/.test(s) ? 66 : 74) :
    s === "creating harness…" ? 86 :
    s === "starting…" ? 95 : 12;
  return el("div", { class: "wasm-overlay wasm-overlay-loading", style: OVERLAY_STYLE }, [
    el("div", { style: "font-weight:600;font-size:15px" }, [text(label)]),
    el("div", { style: "width:60%;max-width:280px;height:8px;border-radius:4px;background:#222;margin-top:14px;overflow:hidden" }, [
      el("div", { class: "wasm-overlay-bar", style: `width:${pct}%;height:100%;background:#b33;transition:width .3s ease` }, []),
    ]),
  ]);
};

/** wasmcanvas(id, status?) — the window body: a focusable <canvas id="wasm-<id>">
 *  the engine's onInstantiate grabs BY ID, plus a boot overlay driven by `status`
 *  (the engine's `.out` cel). Focus/blur toggle wasm.<id>.active (so key routing
 *  targets the focused game); keydown/keyup dispatch wasmwin.key (active-gated
 *  routing into the engine's inbox). Passing `.out` makes the body re-render on
 *  every boot status change — so loading progress and load failures are visible,
 *  not a silent black canvas. The canvas stays mounted under the overlay (the
 *  harness needs it by id; the overlay just covers it until the engine runs). */
export const wasmcanvas = (id: unknown, status?: unknown): VNode => {
  const i = String(id ?? "w");
  const canvas = el("canvas", {
    id: `wasm-${i}`, "data-wasm": i, tabindex: "0", width: "640", height: "400",
    style: "max-width:100%;max-height:100%;image-rendering:pixelated;outline:none;cursor:pointer",
  }, [], {
    focus:   { dispatch: "wasmwin.focus", payload: i },
    blur:    { dispatch: "wasmwin.blur",  payload: i },
    keydown: { dispatch: "wasmwin.key",   payload: i },
    keyup:   { dispatch: "wasmwin.key",   payload: i },
  });
  const overlay = bootOverlay(status);
  return el("div", { class: "wasm-host", style: "position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000;overflow:hidden" },
    overlay ? [canvas, overlay] : [canvas]);
};

// ── focus / key handlers (dispatch targets the canvas wires) ────────────────
const setActive = async (state: State, id: string, on: number): Promise<State> => {
  await (resolveFn(state, "setValue") as Fn)(state, `${lay(id)}.active`, on);
  return state;
};
/** wasmwin.focus — this canvas gained focus → it's the active wasm window. */
export const wasmFocus: Fn = (async (state: State, id: unknown): Promise<State> => setActive(state, String(id ?? ""), 1)) as Fn;
/** wasmwin.blur — lost focus → no longer active (keys stop routing here). */
export const wasmBlur: Fn = (async (state: State, id: unknown): Promise<State> => setActive(state, String(id ?? ""), 0)) as Fn;
/** wasmwin.key — a keystroke on the canvas → route to the engine if active. */
export const wasmKeyHandler: Fn = (async (state: State, id: unknown, event: unknown): Promise<State> => {
  wasmKey(state, String(id ?? ""), (event ?? {}) as KeyEvent);
  return state;
}) as Fn;

// ── the window genesis (a canvas window on the new tabbable frame) ──────────
interface CelSpec { celType: string; f?: string; v?: unknown; metadata: Record<string, unknown> }
export interface WGeom { x?: number; y?: number; w?: number; h?: number; icon?: string }

/** wasmappGenesis(id, title, engineCel, opts?) — genesis a SELF-MOUNTING wasm
 *  window on the `wframe`: the graph↔engine bridge cels (.in/.out/.active), a
 *  <canvas> content cel `(wasmcanvas id)`, a window state cel (one tab = the
 *  canvas), and a self-mounting `(mount ".origin" (wframe …))` frame. `engineCel`
 *  is kept for API symmetry — the canvas grabs the engine instance BY ID at boot,
 *  so the content formula does not reference the (not-yet-existing) engine cel. */
export const wasmappGenesis = (id: string, title: string, engineCel: string, opts: WGeom = {}): { genesis: true; kind: string; layer: Key; cels: Record<Key, CelSpec> } => {
  const i = String(id ?? "w"); const L = lay(i);
  const sref = `${L}.state`, cref = `${L}.content`;
  const t = String(title ?? i).replace(/"/g, "'");
  void engineCel;
  return { genesis: true, kind: "wasm", layer: L, cels: {
    [`${L}.in`]:     { celType: "ValueCel", v: null, metadata: { name: "in", segment: L } },   // graph → engine (+ keystrokes)
    [`${L}.out`]:    { celType: "ValueCel", v: null, metadata: { name: "out", segment: L } },   // engine → graph
    [`${L}.active`]: { celType: "ValueCel", v: 0, metadata: { name: "active", segment: L } },    // focused?
    [cref]:  { celType: "FormulaCel", f: `(wasmcanvas "${i}" ${L}.out)`, metadata: { name: "content", parser: "f", segment: L } },  // refs .out → re-renders on every boot status (loading bar / error card)
    [sref]:  { celType: "ValueCel", v: { ref: sref, x: opts.x ?? 90, y: opts.y ?? 70, w: opts.w ?? 640, h: opts.h ?? 420, z: 1, min: 0, max: 0, closed: 0, title: t, tabs: [{ ref: cref, title: t, ...(opts.icon ? { icon: opts.icon } : {}) }], active: 0 }, metadata: { name: "state" } },
    [`${L}.frame`]: { celType: "FormulaCel", f: `(mount ".origin" (wframe ${sref} win.active ${cref}))`, metadata: { name: "frame", parser: "f", segment: L } },
  } };
};

const wasmapp: Fn = ((id: unknown, title: unknown, engineCel: unknown, opts?: unknown): unknown =>
  wasmappGenesis(String(id ?? "w"), String(title ?? id ?? "w"), String(engineCel ?? ""), (opts && typeof opts === "object") ? opts as WGeom : {})) as Fn;

// wasmcanvas as a formula-callable verb (the content formula calls it with .out).
const wasmcanvasFn: Fn = ((id: unknown, status?: unknown): VNode => wasmcanvas(id, status)) as Fn;

export const name = "winapps-wasm" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["wasmapp", wasmapp],
  ["wasmcanvas", wasmcanvasFn],
  ["wasmwin.focus", wasmFocus],
  ["wasmwin.blur", wasmBlur],
  ["wasmwin.key", wasmKeyHandler],
]));
