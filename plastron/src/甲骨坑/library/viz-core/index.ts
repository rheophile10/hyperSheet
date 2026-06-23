import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// viz-core — the medium-agnostic ENCODING layer shared by charts, maps, and the
// 3d/gpu renderer. A SCALE is a pure DATA SPEC (like a canvas op is), NOT a
// closure: linscale/bandscale/colorscale return {t, …} objects; scaleapply/
// bandwidth/ticks/scaleinvert/colorapply CONSUME them. Everything here is a pure
// fn over plain values — no DOM, no 2d context, no module state — so it is unit-
// testable off-browser and serialises into a data-ops / scene spec unchanged.
//
//   linear:  scaleapply(linscale(0, hi, plotH, 0), v)        → a pixel y
//   band:    scaleapply(bandscale(labels, 0, plotW), label)  → a bar's left x
//   color:   colorapply(colorscale(0, hi), v)                → "#rrggbb"
//
// A chart axis, a map projection, and a sim unit-map are all the same scale.
// ============================================================================

type Spec = Record<string, unknown>;

const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const flat = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]).flat(8) : v == null ? [] : [v]);
const nums = (v: unknown): number[] => { const o: number[] = []; for (const x of flat(v)) { if (x === "" || x === null || x === undefined) continue; const n = Number(x); if (Number.isFinite(n)) o.push(n); } return o; };
const fmt = (v: number): string => String(Math.round(v * 100) / 100);

const PALETTE = ["#7fd0ff", "#e6677a", "#9fe89f", "#ffd34e", "#c39bd3", "#f5b041", "#76d7c4", "#f1948a", "#85c1e9", "#d7bde2"];

// ── internal pure helpers (shared by the verb wrappers; avoid Fn self-calls) ──
const bandStep = (s: Spec): number => { const k = (s.labels as string[]).length || 1; return (num(s.r1) - num(s.r0)) / k; };
const bw = (s: Spec): number => (s.t === "band" ? bandStep(s) * (1 - num(s.pad)) : 0);

const apply = (s: Spec, v: unknown): number => {
  if (s.t === "band") {
    const labels = (s.labels as string[]) ?? [];
    let i = labels.indexOf(String(v));
    if (i < 0) i = Number.isFinite(Number(v)) ? Math.trunc(num(v)) : 0;
    const step = bandStep(s);
    return num(s.r0) + i * step + (step * num(s.pad)) / 2;
  }
  const d0 = num(s.d0), d1 = num(s.d1, 1), r0 = num(s.r0), r1 = num(s.r1, 1), span = d1 - d0;
  return span === 0 ? r0 : r0 + ((num(v) - d0) / span) * (r1 - r0);
};

// classic 1/2/5 ×10^k tick step over [lo,hi] aiming for ~count ticks
const niceStep = (lo: number, hi: number, count: number): number => {
  const step0 = Math.abs(hi - lo || 1) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(step0 || 1)));
  const norm = step0 / mag; // 1..10
  const f = norm >= 7.5 ? 10 : norm >= 3 ? 5 : norm >= 1.5 ? 2 : 1;
  return f * mag;
};

const hexToRgb = (h: string): [number, number, number] => {
  let s = String(h).replace("#", "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  const n = parseInt(s.slice(0, 6).padEnd(6, "0"), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

// ── scale constructors (pure data specs) ────────────────────────────────────
const linscale: Fn = ((d0: unknown, d1: unknown, r0: unknown, r1: unknown): Spec =>
  ({ t: "lin", d0: num(d0), d1: num(d1, 1), r0: num(r0, 0), r1: num(r1, 1) })) as Fn;

const bandscale: Fn = ((labels: unknown, r0: unknown, r1: unknown, pad?: unknown): Spec =>
  ({ t: "band", labels: flat(labels).map((l) => String(l)), r0: num(r0, 0), r1: num(r1, 1),
     pad: Math.min(0.95, Math.max(0, pad === undefined ? 0.2 : num(pad))) })) as Fn;

const colorscale: Fn = ((d0: unknown, d1: unknown, c0?: unknown, c1?: unknown): Spec =>
  ({ t: "color", d0: num(d0), d1: num(d1, 1), c0: c0 === undefined ? "#16213e" : String(c0), c1: c1 === undefined ? "#7fd0ff" : String(c1) })) as Fn;

// ── consumers ───────────────────────────────────────────────────────────────
const scaleapply: Fn = ((scale: unknown, v: unknown): number => apply((scale ?? {}) as Spec, v)) as Fn;

const bandwidth: Fn = ((scale: unknown): number => bw((scale ?? {}) as Spec)) as Fn;

const scaleinvert: Fn = ((scale: unknown, pos: unknown): unknown => {
  const s = (scale ?? {}) as Spec;
  if (s.t === "band") {
    const labels = (s.labels as string[]) ?? [];
    const step = bandStep(s) || 1;
    const i = Math.min(labels.length - 1, Math.max(0, Math.floor((num(pos) - num(s.r0)) / step)));
    return labels[i] ?? i;
  }
  const r0 = num(s.r0), r1 = num(s.r1, 1), d0 = num(s.d0), d1 = num(s.d1, 1), rspan = r1 - r0;
  return rspan === 0 ? d0 : d0 + ((num(pos) - r0) / rspan) * (d1 - d0);
}) as Fn;

const ticks: Fn = ((scale: unknown, count?: unknown): Spec[] => {
  const s = (scale ?? {}) as Spec;
  if (s.t === "band") {
    const labels = (s.labels as string[]) ?? [];
    const half = bw(s) / 2;
    return labels.map((l) => ({ v: l, pos: apply(s, l) + half, label: l }));
  }
  const d0 = num(s.d0), d1 = num(s.d1, 1), lo = Math.min(d0, d1), hi = Math.max(d0, d1);
  const step = niceStep(lo, hi, Math.max(1, Math.trunc(num(count, 5))));
  const out: Spec[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    const rv = Math.round(v / step) * step; // de-fuzz float accumulation
    out.push({ v: rv, pos: apply(s, rv), label: fmt(rv) });
  }
  return out;
}) as Fn;

const nice: Fn = ((lo: unknown, hi: unknown, count?: unknown): number[] => {
  let a = num(lo), b = num(hi, a + 1);
  if (b < a) { const t = a; a = b; b = t; }
  const step = niceStep(a, b, Math.max(1, Math.trunc(num(count, 5))));
  return [Math.floor(a / step) * step, Math.ceil(b / step) * step, step];
}) as Fn;

const colorapply: Fn = ((scale: unknown, v: unknown): string => {
  const s = (scale ?? {}) as Spec;
  const d0 = num(s.d0), d1 = num(s.d1, 1), span = d1 - d0;
  const t = Math.max(0, Math.min(1, span === 0 ? 0 : (num(v) - d0) / span));
  const a = hexToRgb(String(s.c0 ?? "#000")), b = hexToRgb(String(s.c1 ?? "#fff"));
  return "#" + toHex(a[0] + (b[0] - a[0]) * t) + toHex(a[1] + (b[1] - a[1]) * t) + toHex(a[2] + (b[2] - a[2]) * t);
}) as Fn;

const ordinalcolor: Fn = ((key: unknown, keys?: unknown): string => {
  let i: number;
  if (keys !== undefined) { i = flat(keys).map(String).indexOf(String(key)); if (i < 0) i = 0; }
  else i = Number.isFinite(Number(key)) ? Math.trunc(num(key)) : 0;
  return PALETTE[(((i % PALETTE.length) + PALETTE.length) % PALETTE.length)]!;
}) as Fn;

const extent: Fn = ((values: unknown): number[] => {
  const xs = nums(values);
  return xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, 1];
}) as Fn;

export const name = "viz-core" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["linscale", linscale],
  ["bandscale", bandscale],
  ["colorscale", colorscale],
  ["scaleapply", scaleapply],
  ["bandwidth", bandwidth],
  ["scaleinvert", scaleinvert],
  ["ticks", ticks],
  ["nice", nice],
  ["colorapply", colorapply],
  ["ordinalcolor", ordinalcolor],
  ["extent", extent],
]));
