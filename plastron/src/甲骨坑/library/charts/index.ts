import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// charts — charting vocabulary over the plastron-canvas draw-spec.
//
// barchart / linechart / piechart are PURE fns: (labels, values [, x y w h])
// → an OP LIST built from the existing rect/text/line/circle ops (plus the
// wedge op for pie slices). canvas() concats op lists, so a chart renders as
//
//   =canvas(420, 260, barchart(turtles!A2:A8, turtles!B2:B8))
//
// and composes — two charts can share one canvas by giving each its own box.
// Ranges reach the fns as FLAT member-value arrays (the infix parser's range
// shape) or nested rows (the f parser's); both flatten here. The range edges
// in inputMap make the chart re-render when the sheet changes — the chart IS
// a formula over the data.
// ============================================================================

type Op = Record<string, unknown>;

const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };

const PALETTE = ["#7fd0ff", "#e6677a", "#9fe89f", "#ffd34e", "#c39bd3", "#f5b041", "#76d7c4", "#f1948a", "#85c1e9", "#d7bde2"];
const BG = "#16161f", INK = "#c9c9d4", MUT = "#8a8a99", GRID = "#2e2e3e";

const flat = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]).flat(8) : v == null ? [] : [v]);

/** Pair labels with finite numeric values; blank/non-numeric rows drop out.
 *  One-arg form (values only) labels by 1-based index. */
const series = (labelsArg: unknown, valuesArg: unknown): { labels: string[]; values: number[] } => {
  let ls = flat(labelsArg), vs = flat(valuesArg);
  if (valuesArg === undefined) { vs = ls; ls = []; }
  const labels: string[] = [], values: number[] = [];
  for (let i = 0; i < vs.length; i++) {
    const raw = vs[i];
    if (raw === "" || raw === null || raw === undefined) continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const l = ls[i];
    labels.push(l === "" || l === null || l === undefined ? String(i + 1) : String(l));
    values.push(v);
  }
  return { labels, values };
};

const box = (x: unknown, y: unknown, w: unknown, h: unknown): { x: number; y: number; w: number; h: number } =>
  ({ x: num(x, 0), y: num(y, 0), w: Math.max(80, num(w, 420)), h: Math.max(60, num(h, 260)) });

// the painter's fillText is left-anchored — approximate centering by em width
const centered = (cx: number, y: number, s: string, fill: string, px = 10): Op =>
  ({ op: "text", x: cx - (s.length * px * 0.52) / 2, y, text: s, fill, font: `${px}px system-ui` });

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s);
const fmt = (v: number): string => String(Math.round(v * 10) / 10);
const bgOp = (b: { x: number; y: number; w: number; h: number }): Op => ({ op: "rect", x: b.x, y: b.y, w: b.w, h: b.h, fill: BG });
const empty = (b: { x: number; y: number; w: number; h: number }): Op[] => [bgOp(b), centered(b.x + b.w / 2, b.y + b.h / 2, "no data", MUT, 12)];

/** barchart(labels, values [, x y w h]) — one bar per row, value above,
 *  label below; negative values clamp to the baseline. */
const barchart: Fn = ((labels: unknown, values?: unknown, x?: unknown, y?: unknown, w?: unknown, h?: unknown): Op[] => {
  const { labels: ls, values: vs } = series(labels, values);
  const b = box(x, y, w, h);
  if (!vs.length) return empty(b);
  const padL = 10, padR = 10, padT = 20, padB = 18;
  const plotW = b.w - padL - padR, plotH = b.h - padT - padB;
  const hi = Math.max(...vs, 1e-9);
  const slot = plotW / vs.length;
  const bw = Math.max(3, slot * 0.62);
  const ops: Op[] = [bgOp(b)];
  vs.forEach((v, i) => {
    const bh = Math.max(1, (Math.max(0, v) / hi) * plotH);
    const bx = b.x + padL + i * slot + (slot - bw) / 2;
    const by = b.y + padT + plotH - bh;
    ops.push({ op: "rect", x: bx, y: by, w: bw, h: bh, fill: PALETTE[i % PALETTE.length] });
    ops.push(centered(bx + bw / 2, by - 4, fmt(v), INK, 10));
    ops.push(centered(bx + bw / 2, b.y + b.h - 5, clip(ls[i]!, Math.max(3, Math.floor(slot / 5.5))), MUT, 9));
  });
  ops.push({ op: "line", points: [[b.x + padL, b.y + padT + plotH], [b.x + b.w - padR, b.y + padT + plotH]], stroke: GRID, lineWidth: 1 });
  return ops;
}) as Fn;

/** linechart(labels, values [, x y w h]) — one series as a polyline with
 *  point dots, three gridlines with value ticks, labels along the x axis. */
const linechart: Fn = ((labels: unknown, values?: unknown, x?: unknown, y?: unknown, w?: unknown, h?: unknown): Op[] => {
  const { labels: ls, values: vs } = series(labels, values);
  const b = box(x, y, w, h);
  if (!vs.length) return empty(b);
  const padL = 38, padR = 14, padT = 14, padB = 18;
  const plotW = b.w - padL - padR, plotH = b.h - padT - padB;
  const lo = Math.min(0, ...vs);
  const hi = Math.max(...vs, lo + 1e-9);
  const ny = (v: number): number => b.y + padT + ((hi - v) / (hi - lo)) * plotH;
  const px = (i: number): number => b.x + padL + (vs.length > 1 ? (i * plotW) / (vs.length - 1) : plotW / 2);
  const ops: Op[] = [bgOp(b)];
  for (const gv of [hi, (hi + lo) / 2, lo]) {
    const gy = ny(gv);
    ops.push({ op: "line", points: [[b.x + padL, gy], [b.x + b.w - padR, gy]], stroke: GRID, lineWidth: 1 });
    ops.push({ op: "text", x: b.x + 4, y: gy + 3, text: fmt(gv), fill: MUT, font: "9px system-ui" });
  }
  ops.push({ op: "line", points: vs.map((v, i) => [px(i), ny(v)]), stroke: PALETTE[0], lineWidth: 2 });
  vs.forEach((v, i) => {
    ops.push({ op: "circle", x: px(i), y: ny(v), r: 3, fill: PALETTE[0] });
    ops.push(centered(px(i), b.y + b.h - 5, clip(ls[i]!, Math.max(3, Math.floor(plotW / Math.max(1, vs.length) / 5.5))), MUT, 9));
  });
  return ops;
}) as Fn;

/** piechart(labels, values [, x y w h]) — wedges from 12 o'clock plus a
 *  legend (swatch, label, value, share). Non-positive values drop out. */
const piechart: Fn = ((labels: unknown, values?: unknown, x?: unknown, y?: unknown, w?: unknown, h?: unknown): Op[] => {
  const s = series(labels, values);
  const b = box(x, y, w, h);
  const rows = s.values.map((v, i) => ({ v, l: s.labels[i]! })).filter((r) => r.v > 0);
  if (!rows.length) return empty(b);
  const total = rows.reduce((a, r) => a + r.v, 0);
  const side = Math.min(b.h, b.w * 0.55);
  const cx = b.x + side / 2 + 8, cy = b.y + b.h / 2, r = side / 2 - 12;
  const ops: Op[] = [bgOp(b)];
  let a0 = -Math.PI / 2;
  rows.forEach((row, i) => {
    const a1 = a0 + (row.v / total) * Math.PI * 2;
    ops.push({ op: "wedge", cx, cy, r, a0, a1, fill: PALETTE[i % PALETTE.length], stroke: BG, lineWidth: 1 });
    a0 = a1;
  });
  const lx = b.x + side + 16, rowH = 15;
  const maxRows = Math.max(1, Math.floor((b.h - 16) / rowH));
  rows.slice(0, maxRows).forEach((row, i) => {
    const ly = b.y + 14 + i * rowH;
    ops.push({ op: "rect", x: lx, y: ly - 8, w: 9, h: 9, fill: PALETTE[i % PALETTE.length] });
    ops.push({ op: "text", x: lx + 14, y: ly, text: `${clip(row.l, 16)} ${fmt(row.v)} (${Math.round((row.v / total) * 100)}%)`, fill: INK, font: "10px system-ui" });
  });
  if (rows.length > maxRows) ops.push({ op: "text", x: lx + 14, y: b.y + 14 + maxRows * rowH, text: `+${rows.length - maxRows} more`, fill: MUT, font: "10px system-ui" });
  return ops;
}) as Fn;

export const name = "charts" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["barchart",  barchart],
  ["linechart", linechart],
  ["piechart",  piechart],
]));
