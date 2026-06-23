import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// plastron-canvas — formula-authored 2d graphics (plastron-canvas.md, accepted).
//
// VNode : DOM :: draw-spec : canvas. The vocabulary here are PURE fns that
// return op objects (rect/text/line/circle); `canvas(w, h, …ops)` returns a
// <canvas> VNODE that carries the op list as a `data-ops` JSON attribute.
// The painter (dom) replays those ops onto the element's 2d context
// after each paint — see dom/utils/canvas.ts. No closures; the spec
// is pure JSON, so it dehydrates and composes by array concat.
// ============================================================================

const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v: unknown): string | undefined => (v === undefined || v === null || v === "" ? undefined : String(v));
const isOp = (o: unknown): boolean => !!o && typeof o === "object" && typeof (o as { op?: unknown }).op === "string";
const isStyle = (c: unknown): c is { __style: Record<string, unknown> } =>
  !!c && typeof c === "object" && typeof (c as { __style?: unknown }).__style === "object";

/** rect(x, y, w, h [, fill] [, stroke] [, lineWidth]) — a filled/stroked box. */
const rect: Fn = (x, y, w, h, fill, stroke, lineWidth) =>
  ({ op: "rect", x: num(x), y: num(y), w: num(w), h: num(h), fill: str(fill), stroke: str(stroke), lineWidth: str(lineWidth) ? num(lineWidth) : undefined });

/** text(x, y, text [, fill] [, font]) — fillText at a baseline point. */
const text: Fn = (x, y, t, fill, font) =>
  ({ op: "text", x: num(x), y: num(y), text: String(t ?? ""), fill: str(fill), font: str(font) });

/** line(x1, y1, x2, y2 [, stroke] [, lineWidth]) — a single segment. */
const line: Fn = (x1, y1, x2, y2, stroke, lineWidth) =>
  ({ op: "line", points: [[num(x1), num(y1)], [num(x2), num(y2)]], stroke: str(stroke), lineWidth: str(lineWidth) ? num(lineWidth) : undefined });

/** circle(x, y, r [, fill] [, stroke] [, lineWidth]) — an arc. */
const circle: Fn = (x, y, r, fill, stroke, lineWidth) =>
  ({ op: "circle", x: num(x), y: num(y), r: num(r), fill: str(fill), stroke: str(stroke), lineWidth: str(lineWidth) ? num(lineWidth) : undefined });

/** wedge(cx, cy, r, a0, a1 [, fill] [, stroke] [, lineWidth]) — a pie slice
 *  from angle a0 to a1 (radians, clockwise from 3 o'clock). */
const wedge: Fn = (cx, cy, r, a0, a1, fill, stroke, lineWidth) =>
  ({ op: "wedge", cx: num(cx), cy: num(cy), r: num(r), a0: num(a0), a1: num(a1), fill: str(fill), stroke: str(stroke), lineWidth: str(lineWidth) ? num(lineWidth) : undefined });

/** frames(points, r?, period?, fill?, box?) — an ANIMATED op: a dot of radius
 *  r stepping through a trajectory `points` ([[x,y],…]) once per `period` sec;
 *  `box` strokes a frame border. dom's replay loop drives it via rAF. The
 *  `simulate` verb (origin) computes a def'd trajectory then emits through this
 *  rather than hand-rolling the op literal — so the shape lives in one place. */
export const frames: Fn = ((points, r, period, fill, box) =>
  ({ op: "frames",
     frames: Array.isArray(points) ? (points as unknown[]) : [],
     r: num(r, 10),
     fill: fill === undefined ? "#e91e63" : String(fill),
     period: num(period, 4),
     box: box === undefined ? "rgba(255,255,255,.25)" : String(box) })) as Fn;

/** canvas(width, height, …ops) — a <canvas> VNODE that draws `ops`. Use it
 *  as a cell value or inside mount/dom: `=canvas(600, 140, rect(…), text(…))`.
 *  Composes by concat — vocabulary fns that return op LISTS (the charts
 *  segment) flatten in: `=canvas(420, 260, barchart(t!A2:A8, t!B2:B8))`. */
const canvas: Fn = (width, height, ...rest) => {
  // ops plus an optional (style …) child for inline styling of the <canvas>
  let style: Record<string, unknown> | undefined;
  const opList: unknown[] = [];
  for (const c of rest) {
    if (isStyle(c)) { style = { ...style, ...c.__style }; continue; }
    if (Array.isArray(c)) { for (const o of (c as unknown[]).flat(8)) if (isOp(o)) opList.push(o); continue; }
    if (isOp(c)) opList.push(c);
  }
  return {
    type: "el", tag: "canvas",
    attrs: { width: Math.max(1, num(width, 300)), height: Math.max(1, num(height, 150)), "data-ops": JSON.stringify(opList) },
    ...(style ? { style: style as Record<string, string | number | boolean | null> } : {}),
    children: [],
  };
};

/** dragdrop(w?, h?) — two drop zones (A, B) + a draggable rect that snaps to
 *  the nearest zone on release. A VALUE vnode (like canvas); the interactivity
 *  lives in dom's canvas renderer (the `draggable`/`zone` ops). */
const dragdrop: Fn = (w, h) => {
  const W = Math.max(220, Math.floor(Number(w)) || 420), H = Math.max(120, Math.floor(Number(h)) || 200);
  const zw = W * 0.4, zh = H * 0.66, zy = (H - zh) / 2, ax = W * 0.04, bx = W - W * 0.04 - zw, rw = 64, rh = 40;
  const ops = [
    { op: "zone", x: ax, y: zy, w: zw, h: zh, label: "A" },
    { op: "zone", x: bx, y: zy, w: zw, h: zh, label: "B" },
    { op: "draggable", x: ax + zw / 2 - rw / 2, y: zy + zh / 2 - rh / 2, w: rw, h: rh, fill: "#e91e63" },
  ];
  return { type: "el", tag: "canvas", attrs: { width: W, height: H, "data-ops": JSON.stringify(ops) }, children: [] };
};

export const name = "plastron-canvas" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["rect",   rect],
  ["text",   text],
  ["line",   line],
  ["circle", circle],
  ["wedge",  wedge],
  ["frames", frames],
  ["canvas", canvas],
  ["dragdrop", dragdrop],
]));
