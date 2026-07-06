// ============================================================================
// ecs — a GENERIC entity-component-system vocabulary for the cel graph.
//
// The mapping: entity = array index; a component TABLE is one cel holding a
// length-N array (SoA — per the bench doctrine, aggregate-only state stays in
// one cel); a SYSTEM is a FormulaCel composing the fns below. Nothing here
// knows about fish, grids-of-life, or any particular app.
//
// Higher-order by construction: a lambda cel referenced in a formula
// contributes its CALLABLE (runCycle's inputValue), so `(sysmap boidRule …)`
// and `(opmap circle …)` receive real functions — per-entity rules and op
// builders stay cels, swappable without touching the machinery.
//
// Broadcasting convention (sysmap/opmap): N comes from the first array
// argument; any array of exactly length N is sliced per entity, everything
// else (params, dt, colors) broadcasts unchanged. The entity index is
// appended as the rule's last argument.
// ============================================================================

import { resolveFn } from "../../plastron/dist/index.js";

type Fn = (...args: unknown[]) => unknown;
type Pair = [number, number];

const isFn = (v: unknown): v is Fn => typeof v === "function";
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/** sysmap(rule, …args) — run a per-entity rule over parallel component
 *  tables. Length-N args are sliced per entity, others broadcast; the
 *  entity index arrives last. Returns the length-N result table. */
const sysmap: Fn = (rule, ...args) => {
  if (!isFn(rule)) return [];
  const first = args.find(Array.isArray) as unknown[] | undefined;
  const n = first ? first.length : 0;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = rule(...args.map((a) => (Array.isArray(a) && a.length === n ? a[i] : a)), i);
  }
  return out;
};

/** neighbors(positions, radius, …tables) — per-entity spatial query. For
 *  entity i: an array of [pos_j, …table_j] rows for every OTHER entity j
 *  within radius. Extra tables let a rule see neighbors' velocities etc.
 *  Naive O(n²) — fine at experiment scale. */
const neighbors: Fn = (positions, radius, ...tables) => {
  const ps = (Array.isArray(positions) ? positions : []) as Pair[];
  const r2 = num(radius) * num(radius);
  const ts = tables.filter(Array.isArray) as unknown[][];
  return ps.map((p, i) => {
    const found: unknown[][] = [];
    for (let j = 0; j < ps.length; j++) {
      if (j === i) continue;
      const q = ps[j]!;
      const dx = q[0] - p[0], dy = q[1] - p[1];
      if (dx * dx + dy * dy <= r2) found.push([q, ...ts.map((t) => t[j])]);
    }
    return found;
  });
};

/** integrate(positions, velocities, dt) — Euler step, pairs in/pairs out. */
const integrate: Fn = (positions, velocities, dt) => {
  const ps = (Array.isArray(positions) ? positions : []) as Pair[];
  const vs = (Array.isArray(velocities) ? velocities : []) as Pair[];
  const h = num(dt, 1);
  return ps.map((p, i) => [p[0] + (vs[i]?.[0] ?? 0) * h, p[1] + (vs[i]?.[1] ?? 0) * h]);
};

/** wrap(positions, w, h) — toroidal wrap of a position table. */
const wrap: Fn = (positions, w, h) => {
  const ps = (Array.isArray(positions) ? positions : []) as Pair[];
  const W = num(w, 1), H = num(h, 1);
  return ps.map(([x, y]) => [((x % W) + W) % W, ((y % H) + H) % H]);
};

/** opmap(op, table, …args) — render a component table with an existing
 *  canvas-op builder: each row is spread into op, trailing args appended.
 *  `(opmap circle positions 3 "#4fc3f7")` → one circle op per entity.
 *  Composes with `canvas`, which flattens op arrays. */
const opmap: Fn = (op, table, ...args) => {
  if (!isFn(op) || !Array.isArray(table)) return [];
  return table.map((row) => (Array.isArray(row) ? op(...row, ...args) : op(row, ...args)));
};

/** gridops(op, grid, w, h, cell, …args) — render the truthy cells of a flat
 *  w×h grid: op(px, py, cell-1, cell-1, …args) per live cell. With `rect`
 *  that's a filled square per cell; the -1 leaves a hairline grid gap. */
const gridops: Fn = (op, grid, w, h, cell, ...args) => {
  if (!isFn(op) || !Array.isArray(grid)) return [];
  const W = Math.max(1, num(w, 1)), C = num(cell, 8);
  const out: unknown[] = [];
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i]) continue;
    const x = i % W, y = (i / W) | 0;
    out.push(op(x * C, y * C, C - 1, C - 1, ...args));
  }
  return out;
};

/** automaton(grid, w, h, rules) — one generation of a B/S-rulestring
 *  cellular automaton ("B3/S23" = Life, "B36/S23" = HighLife, …) on a flat
 *  w×h toroidal grid of 0/1. Returns a NEW grid array. */
const automaton: Fn = (grid, w, h, rules) => {
  const g = (Array.isArray(grid) ? grid : []) as number[];
  const W = Math.max(1, num(w, 1)), H = Math.max(1, num(h, 1));
  const m = /b([0-8]*)\s*\/\s*s([0-8]*)/i.exec(String(rules ?? "B3/S23"));
  const born = new Set((m?.[1] ?? "3").split("").map(Number));
  const survive = new Set((m?.[2] ?? "23").split("").map(Number));
  const next = new Array(W * H).fill(0);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          count += g[((y + dy + H) % H) * W + ((x + dx + W) % W)] ? 1 : 0;
        }
      }
      const i = y * W + x;
      next[i] = (g[i] ? survive.has(count) : born.has(count)) ? 1 : 0;
    }
  }
  return next;
};

/** Register the vocabulary as LockedLambdaCels. Idempotent enough for the
 *  experiment host (setCel replaces in place). */
export const installEcsVocabulary = async (state: unknown): Promise<void> => {
  const setCel = resolveFn(state as never, "setCel") as (s: unknown, k: string, spec: unknown) => Promise<unknown>;
  const reg = (key: string, fn: Fn) =>
    setCel(state, key, { celType: "LockedLambdaCel", locked: true, fn, metadata: { kind: "native" } });
  await reg("sysmap", sysmap);
  await reg("neighbors", neighbors);
  await reg("integrate", integrate);
  await reg("wrap", wrap);
  await reg("opmap", opmap);
  await reg("gridops", gridops);
  await reg("automaton", automaton);
};
