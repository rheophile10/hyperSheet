import type { State, Key, Fn, VNode, AttrValue, EventBinding, 甲骨, Cel } from "../../../types/index.js";
import { resolveFn, bindNativeFns } from "../../../kernel/index.js";
import { el as makeEl } from "../dom/index.js";
import seed from "./甲骨.json" with { type: "json" };

const el = (tag: string, attrs: Record<string, unknown>, children: VNode[], events?: Record<string, unknown>): VNode =>
  makeEl(tag, attrs as Record<string, AttrValue>, children, events as Record<string, EventBinding> | undefined);

// wasm-window — a reusable WINDOW (like a dom/winapp window) that hosts a wasm app
// on a <canvas>, routes keystrokes to it WHEN ACTIVE, and bridges messages to/from
// the graph. Two modes: IN-PROCESS (a kind:"wasm" cel in the page) and JAILED (an
// iframe sub-kernel, messaged via postMessage). Doom is the first user segment.
//
// What the library provides (engine-agnostic):
//   • the window genesis (geometry + canvas + the engine cel + the bridge cels),
//   • the graph↔engine MESSAGE BRIDGE (wasm.<id>.in graph→engine, .out engine→graph),
//   • ACTIVE-gated key routing (keys land on the focused wasm window only).
// What a user segment (doom) provides: the wasm bytes + its imports/provider (the
// WASI/env harness) + any engine-specific input mapping.

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

// ── the window genesis (a canvas window, like winapp) ───────────────────────
interface CelSpec { celType: string; f?: string; v?: unknown; metadata: Record<string, unknown> }
export interface WasmWinOpts { x?: number; y?: number; w?: number; h?: number; jail?: boolean; seed?: string }

/** wasmwin(id, title, engineCel, opts) — a draggable window whose body is a
 *  <canvas> driven by a wasm engine. `engineCel` is the cel key of a kind:"wasm"
 *  cel (in-process) the canvas binds to; `opts.jail` + `opts.seed` instead embeds
 *  a jail iframe running `seed` (isolated). Seeds the bridge cels (.in/.out/.active)
 *  the graph and key router use. */
export const wasmwinGenesis = (id: string, title: string, engineCel: string, opts: WasmWinOpts = {}): { genesis: true; kind: string; layer: Key; cels: Record<Key, CelSpec> } => {
  const L = lay(id), sref = `${L}.state`, cref = `${L}.content`;
  const t = String(title ?? id).replace(/"/g, "'");
  // the canvas is a STATIC dom element (the engine draws to its 2d context
  // imperatively + grabs it by id) — so the content formula does NOT reference the
  // (not-yet-existing) engine cel, which would error and render nothing. engineCel
  // is kept in the signature for callers that want a reactive binding.
  void engineCel;
  const body = opts.jail
    ? `(jail "${String(opts.seed ?? "").replace(/"/g, "'")}")`
    : `(wasmcanvas "${id}")`;
  return { genesis: true, kind: opts.jail ? "jail" : "wasm", layer: L, cels: {
    [sref]: { celType: "ValueCel", v: { ref: sref, x: opts.x ?? 90, y: opts.y ?? 70, w: opts.w ?? 640, h: opts.h ?? 420, z: 1, min: 0, max: 0, closed: 0, title: t }, metadata: { name: "state" } },
    [`${L}.in`]:     { celType: "ValueCel", v: null, metadata: { name: "in", segment: L } },   // graph → engine (+ keystrokes)
    [`${L}.out`]:    { celType: "ValueCel", v: null, metadata: { name: "out", segment: L } },  // engine → graph
    [`${L}.active`]: { celType: "ValueCel", v: 0, metadata: { name: "active", segment: L } },  // is this window focused?
    [cref]:          { celType: "FormulaCel", f: body, metadata: { name: "content", parser: "f", segment: L } },
    [`${L}.frame`]:  { celType: "FormulaCel", f: `(mount ".origin" (winframe ${sref} win.active ${cref}))`, metadata: { name: "frame", parser: "f", segment: L, channel: ["dom.paint"] } },
  } };
};

// ── the canvas renderer (the thing keys land on) ────────────────────────────
/** wasmcanvas(id, engine?, active?) — the window body: a focusable <canvas id=
 *  "wasm-<id>"> the engine's onInstantiate grabs BY ID. Focus/blur toggle
 *  wasm.<id>.active (so key routing targets the focused game); keydown/keyup
 *  dispatch wasmwin.key (active-gated routing into the engine's inbox). The
 *  engine value is accepted so the formula re-renders when the engine (re)loads. */
export const wasmcanvas = (id: unknown, _engine?: unknown, _active?: unknown): VNode => {
  const i = String(id ?? "w");
  return el("div", { class: "wasm-host", style: "width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000;overflow:hidden" }, [
    el("canvas", {
      id: `wasm-${i}`, "data-wasm": i, tabindex: "0", width: "640", height: "400",
      style: "max-width:100%;max-height:100%;image-rendering:pixelated;outline:none;cursor:pointer",
    }, [], {
      focus:   { dispatch: "wasmwin.focus", payload: i },
      blur:    { dispatch: "wasmwin.blur",  payload: i },
      keydown: { dispatch: "wasmwin.key",   payload: i },
      keyup:   { dispatch: "wasmwin.key",   payload: i },
    }),
  ]);
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

// wasmcanvas as a formula-callable verb (the content formula calls it).
const wasmcanvasFn: Fn = ((id: unknown, engine?: unknown, active?: unknown): VNode => wasmcanvas(id, engine, active)) as Fn;

export const name = "wasm-window" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["wasmcanvas", wasmcanvasFn],
  ["wasmwin.focus", wasmFocus],
  ["wasmwin.blur", wasmBlur],
  ["wasmwin.key", wasmKeyHandler],
]));
