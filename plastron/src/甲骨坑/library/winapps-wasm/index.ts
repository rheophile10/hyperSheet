import type { 甲骨, Cel, Fn, Key } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// The generic WASI host an engine's harness composes with its own env.* ABI — the
// reusable half of doom-harness. A TS export (it closes over a live wasm instance /
// memory, so it's harness glue, not a formula verb). See wasi-host.ts.
export { createWasiHost } from "./wasi-host.js";
export type { WasiHost, WasiHostOptions, WasiInstance } from "./wasi-host.js";

// ============================================================================
// winapps-wasm — the WASM-app specifics of the windowed-app stack
// (windowing-architecture.md). A wasm app = a `window` (the new tabbable frame)
// whose content is a <canvas> the engine draws to, plus the graph↔engine message
// bridge + ACTIVE-gated key routing. Everything PECULIAR to wasm apps lives here;
// generic chrome + install live in `winapps`; the frame in `window`.
//
// `wasmapp` builds the window on the NEW `window` frame (wframe), so a DOOM tab can
// sit next to a sheet. It reuses the canvas/bridge/key LockedLambdas the wasm-window
// segment already ships (wasmcanvas + wasmwin.focus/blur/key) — the CUTOVER folds
// those in here and retires wasm-window (+ rewrites doom as install + wasmapp +
// load + a harness provider, "mostly formula-cells"). Additive for now.
// ============================================================================

interface WGeom { x?: number; y?: number; w?: number; h?: number; icon?: string }

// wasmapp(id, title, engineCel, opts?) — genesis a SELF-MOUNTING wasm window on the
// new frame: the graph↔engine bridge cels (.in/.out/.active), a <canvas> content cel
// `(wasmcanvas id)`, a window state cel (one tab = the canvas), and a self-mounting
// `(mount ".origin" (wframe …))` frame. `engineCel` is kept for API symmetry — the
// canvas grabs the engine instance BY ID (set up at boot), so the content formula does
// not reference the (not-yet-existing) engine cel.
const wasmapp: Fn = ((id: unknown, title: unknown, engineCel: unknown, opts?: unknown): unknown => {
  const i = String(id ?? "w"); const lay = `wasm.${i}`;
  const sref = `${lay}.state`, cref = `${lay}.content`;
  const t = String(title ?? i).replace(/"/g, "'");
  const o = (opts && typeof opts === "object") ? opts as WGeom : {};
  void engineCel;
  return { genesis: true, kind: "wasm", layer: lay as Key, cels: {
    [`${lay}.in`]:     { celType: "ValueCel", v: null, metadata: { name: "in", segment: lay } },   // graph → engine (+ keystrokes)
    [`${lay}.out`]:    { celType: "ValueCel", v: null, metadata: { name: "out", segment: lay } },   // engine → graph
    [`${lay}.active`]: { celType: "ValueCel", v: 0, metadata: { name: "active", segment: lay } },    // focused?
    [cref]:  { celType: "FormulaCel", f: `(wasmcanvas "${i}")`, metadata: { name: "content", parser: "f", segment: lay } },
    [sref]:  { celType: "ValueCel", v: { ref: sref, x: o.x ?? 90, y: o.y ?? 70, w: o.w ?? 640, h: o.h ?? 420, z: 1, min: 0, max: 0, closed: 0, title: t, tabs: [{ ref: cref, title: t, ...(o.icon ? { icon: o.icon } : {}) }], active: 0 }, metadata: { name: "state" } },
    [`${lay}.frame`]: { celType: "FormulaCel", f: `(mount ".origin" (wframe ${sref} win.active ${cref}))`, metadata: { name: "frame", parser: "f", segment: lay } },
  } };
}) as Fn;

export const name = "winapps-wasm" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["wasmapp", wasmapp],
]));
