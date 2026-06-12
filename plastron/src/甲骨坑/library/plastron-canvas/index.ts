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

/** orbit(cx, cy, orbitR, planetR, period [, color] [, phase]) — an ANIMATED
 *  op: a planet circling (cx,cy) at radius orbitR, once every `period` seconds.
 *  A canvas with any orbit op runs a rAF loop (see dom). Stack a few
 *  around a central circle() for a heliocentric system. */
const orbit: Fn = (cx, cy, orbitR, planetR, period, color, phase) =>
  ({ op: "orbit", cx: num(cx), cy: num(cy), orbitR: num(orbitR), planetR: num(planetR), period: num(period, 8), color: str(color), phase: num(phase) });

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

export const name = "plastron-canvas" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["rect",   rect],
  ["text",   text],
  ["line",   line],
  ["circle", circle],
  ["wedge",  wedge],
  ["orbit",  orbit],
  ["canvas", canvas],
]));
