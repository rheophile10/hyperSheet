import type { State, 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// ecs — a generic entity-component-system vocabulary for the cel graph.
//
// The mapping: entity = array index; a component TABLE is one cel holding a
// length-N array (SoA — aggregate-only state stays in one cel); a SYSTEM is
// a FormulaCel composing the fns below; TIME is advanced by the sim.run
// pump, which commits derived *.next values back into the tables (a formula
// cannot write its own input — cycles are forbidden — so the graph derives
// and the pump advances). Nothing here knows about any particular app.
//
// Higher-order by construction: a lambda cel referenced in a formula
// contributes its CALLABLE (runCycle's inputValue), so `(sysmap rule …)`
// and `(opmap circle …)` receive real functions — rules and op builders
// stay cels, swappable without touching the machinery. The RULE itself is
// never native here (grid-program contract): sheets author it as a lambda
// cel and pass it in — sysmap at formula scale, swarmstep's kernel at
// dense scale.
// ============================================================================

type Pair = [number, number];

const isFn = (v: unknown): v is Fn => typeof v === "function";
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ── per-entity machinery ─────────────────────────────────────────────────────

/** sysmap(rule, …args) — broadcast convention: N from the first array arg;
 *  arrays of exactly length N slice per entity, others broadcast; the
 *  entity index arrives last. */
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

/** neighbors(positions, radius, …tables) — per-entity [pos_j, …table_j]
 *  rows for every other entity within radius. Naive O(n²). */
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

// ── rendering (composes with plastron-canvas; canvas() flattens op arrays) ──

/** opmap(op, table, …args) — each row spread into the op builder. */
const opmap: Fn = (op, table, ...args) => {
  if (!isFn(op) || !Array.isArray(table)) return [];
  return table.map((row) => (Array.isArray(row) ? op(...row, ...args) : op(row, ...args)));
};

/** gridops(op, grid, w, h, cell, …args) — one op per truthy grid cell. */
const gridops: Fn = (op, grid, w, _h, cell, ...args) => {
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

// ── cellular automata ────────────────────────────────────────────────────────

/** automaton(grid, w, h, rule) — one CA generation, toroidal 8-neighbour.
 *  The RULE decides each cell and lives in a cell (grid-program contract):
 *  a KERNEL callable (alive, count) → 0|1 (=LAMBDA or a wat lambda — same
 *  ABI), or a B/S rulestring ('B3/S23') as policy-as-data. The mechanism
 *  here is only the toroidal neighbour count. Returns a NEW array so a
 *  skipEqual commit freezes cleanly on still lifes. */
const automaton: Fn = (grid, w, h, rule) => {
  const g = (Array.isArray(grid) ? grid : []) as number[];
  const W = Math.max(1, num(w, 1)), H = Math.max(1, num(h, 1));
  const kern = isFn(rule) ? rule as (alive: number, count: number) => unknown : undefined;
  const m = kern ? null : /b([0-8]*)\s*\/\s*s([0-8]*)/i.exec(String(rule ?? "B3/S23"));
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
      next[i] = kern
        ? (num(kern(g[i] ? 1 : 0, count), 0) ? 1 : 0)
        : ((g[i] ? survive.has(count) : born.has(count)) ? 1 : 0);
    }
  }
  return next;
};

// ── the dense interior (doctrine #2: one cel, many entities) ────────────────
// At 10k+ entities the component tables live INSIDE one buffer cel as SoA
// typed arrays; the graph sees only the sparse boundary (params, generation).
// The RULE is not down here — that's the grid-program contract (docs/1-design/
// 1-under-consideration/grid-program-contract.md): swarmstep is pure mechanism
// (spatial hash, neighbor aggregates, integrate + wrap) and receives the
// steering rule as a KERNEL authored in a cell — an infix =LAMBDA for the
// legible tier, a wat lambda cel for the compiled tier; identical ABI, so a
// sheet swaps tiers by referencing a different cell. At a perf cliff, compile
// the kernel — don't fuse the rule into the mechanism. No RNG — deterministic
// (snapshot/replay-friendly, buffer-schema for persistence).
//
// Kernel ABI (all scalars in, one triple out):
//   kernel(px,py,pz, vx,vy,vz, n, cx,cy,cz, ax,ay,az, sx,sy,sz,
//          cohesion, alignment, separation, maxSpeed) → [vx', vy', vz']
// where n = neighbors found (0 → the aggregate args are zeros), c* = neighbor
// centroid (mean position), a* = mean neighbor velocity, s* = inverse-square
// separation sum.

interface FlockBuffers {
  n: number;
  positions: Float32Array;     // 3N
  velocities: Float32Array;    // 3N
  _scratch?: { vnext: Float32Array; head: Int32Array; next: Int32Array; gx: number; gy: number; gz: number; cell: number };
}
interface FlockParams {
  cohesion?: unknown; alignment?: unknown; separation?: unknown;
  maxSpeed?: unknown; radius?: unknown; dt?: unknown;
  w?: unknown; h?: unknown; d?: unknown;
}

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** flockSeed(n, seed, w, h, d) — a deterministic seeded flock: SoA buffers
 *  struct for n entities uniformly placed in the box, unit-ish velocities.
 *  Keeps the floats OUT of doc archives — the pump's init calls this. */
const flockSeed: Fn = (n, seedArg, w, h, d) => {
  const N = Math.max(1, Math.trunc(num(n, 1000)));
  const rnd = mulberry32(Math.trunc(num(seedArg, 1)));
  const W = num(w, 20), H = num(h, 12), D = num(d, 20);
  const positions = new Float32Array(3 * N);
  const velocities = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    positions[i * 3] = (rnd() - 0.5) * W;
    positions[i * 3 + 1] = (rnd() - 0.5) * H;
    positions[i * 3 + 2] = (rnd() - 0.5) * D;
    const theta = rnd() * Math.PI * 2, phi = Math.acos(2 * rnd() - 1);
    velocities[i * 3] = Math.sin(phi) * Math.cos(theta);
    velocities[i * 3 + 1] = Math.cos(phi) * 0.3;
    velocities[i * 3 + 2] = Math.sin(phi) * Math.sin(theta);
  }
  return { n: N, positions, velocities };
};

/** swarmstep(buffers, params, kernel) — one simulation step over the SoA
 *  struct, in place: spatial-hash neighbor aggregates per entity (cell =
 *  radius, preallocated scratch on the struct, params.maxNeighbors cap), the
 *  KERNEL decides each entity's new velocity (Jacobi: reads only last
 *  frame's state), then commit + integrate + toroidal wrap in the centered
 *  box {w,h,d}. Pure mechanism — the rule lives in the kernel cell. */
const swarmstep: Fn = (buffers, params, kernel) => {
  const b = buffers as FlockBuffers | undefined;
  if (!b || !(b.positions instanceof Float32Array) || !(b.velocities instanceof Float32Array)) return buffers;
  if (!isFn(kernel)) throw new Error("swarmstep: no kernel — pass a lambda cel (=LAMBDA or wat) with the steering rule; the mechanism has no rule of its own.");
  const p = (params ?? {}) as FlockParams & { maxNeighbors?: unknown };
  const N = Math.min(Math.trunc(num(b.n, b.positions.length / 3)), Math.floor(b.positions.length / 3));
  const coh = num(p.cohesion, 0.015), ali = num(p.alignment, 0.05), sep = num(p.separation, 0.06);
  const maxV = Math.max(0.1, num(p.maxSpeed, 2));
  const radius = Math.max(0.1, num(p.radius, 1.2)), r2 = radius * radius;
  const cap = Math.max(1, Math.trunc(num(p.maxNeighbors, 24)));
  const dt = num(p.dt, 0.016);
  const W = num(p.w, 20), H = num(p.h, 12), D = num(p.d, 20);
  const pos = b.positions, vel = b.velocities;

  // spatial hash — clamp the grid so a huge radius degenerates gracefully
  const cell = radius;
  const gx = Math.max(1, Math.min(64, Math.ceil(W / cell)));
  const gy = Math.max(1, Math.min(64, Math.ceil(H / cell)));
  const gz = Math.max(1, Math.min(64, Math.ceil(D / cell)));
  let s = b._scratch;
  if (!s || s.gx !== gx || s.gy !== gy || s.gz !== gz || s.vnext.length !== 3 * N) {
    s = { vnext: new Float32Array(3 * N), head: new Int32Array(gx * gy * gz), next: new Int32Array(N), gx, gy, gz, cell };
    b._scratch = s;
  }
  const { vnext, head, next } = s;
  head.fill(-1);
  const cellOf = (i: number): number => {
    const cx = Math.min(gx - 1, Math.max(0, Math.floor((pos[i * 3]! + W / 2) / (W / gx))));
    const cy = Math.min(gy - 1, Math.max(0, Math.floor((pos[i * 3 + 1]! + H / 2) / (H / gy))));
    const cz = Math.min(gz - 1, Math.max(0, Math.floor((pos[i * 3 + 2]! + D / 2) / (D / gz))));
    return (cz * gy + cy) * gx + cx;
  };
  for (let i = 0; i < N; i++) { const c = cellOf(i); next[i] = head[c]!; head[c] = i; }

  // pass 1 — aggregate neighbors, then the kernel steers (Jacobi: reads
  // only last frame's pos/vel). Means for centroid/velocity, sum for the
  // inverse-square separation — the kernel ABI documented above.
  const kern = kernel as (...a: number[]) => ArrayLike<number>;
  for (let i = 0; i < N; i++) {
    const px = pos[i * 3]!, py = pos[i * 3 + 1]!, pz = pos[i * 3 + 2]!;
    const vx = vel[i * 3]!, vy = vel[i * 3 + 1]!, vz = vel[i * 3 + 2]!;
    let cx = 0, cy = 0, cz = 0, avx = 0, avy = 0, avz = 0, sx = 0, sy = 0, sz = 0, found = 0;
    const ci = cellOf(i);
    const bx = ci % gx, by = ((ci / gx) | 0) % gy, bz = (ci / (gx * gy)) | 0;
    outer:
    for (let dz = -1; dz <= 1; dz++) {
      const zz = bz + dz; if (zz < 0 || zz >= gz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = by + dy; if (yy < 0 || yy >= gy) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = bx + dx; if (xx < 0 || xx >= gx) continue;
          for (let j = head[(zz * gy + yy) * gx + xx]!; j !== -1; j = next[j]!) {
            if (j === i) continue;
            const ox = pos[j * 3]! - px, oy = pos[j * 3 + 1]! - py, oz = pos[j * 3 + 2]! - pz;
            const d2 = ox * ox + oy * oy + oz * oz;
            if (d2 > r2) continue;
            cx += pos[j * 3]!; cy += pos[j * 3 + 1]!; cz += pos[j * 3 + 2]!;
            avx += vel[j * 3]!; avy += vel[j * 3 + 1]!; avz += vel[j * 3 + 2]!;
            const inv = 1 / Math.max(0.01, d2);
            sx -= ox * inv; sy -= oy * inv; sz -= oz * inv;
            if (++found >= cap) break outer;
          }
        }
      }
    }
    const m = found > 0 ? 1 / found : 0;
    const w = kern(px, py, pz, vx, vy, vz, found,
      cx * m, cy * m, cz * m, avx * m, avy * m, avz * m, sx, sy, sz,
      coh, ali, sep, maxV);
    vnext[i * 3] = num(w?.[0], vx); vnext[i * 3 + 1] = num(w?.[1], vy); vnext[i * 3 + 2] = num(w?.[2], vz);
  }

  // pass 2 — commit + integrate + toroidal wrap (centered box)
  const wrap1 = (v: number, span: number): number => {
    const half = span / 2;
    let x = (v + half) % span;
    if (x < 0) x += span;
    return x - half;
  };
  for (let i = 0; i < N; i++) {
    vel[i * 3] = vnext[i * 3]!; vel[i * 3 + 1] = vnext[i * 3 + 1]!; vel[i * 3 + 2] = vnext[i * 3 + 2]!;
    pos[i * 3] = wrap1(pos[i * 3]! + vel[i * 3]! * dt, W);
    pos[i * 3 + 1] = wrap1(pos[i * 3 + 1]! + vel[i * 3 + 1]! * dt, H);
    pos[i * 3 + 2] = wrap1(pos[i * 3 + 2]! + vel[i * 3 + 2]! * dt, D);
  }
  return b;
};

/** bufstats(buffers, gen) — probe the dense interior: a {gen, n, meanSpeed,
 *  maxSpeed} summary of the SoA struct. Reference the generation cel as
 *  `gen` so the probe re-derives on every committed frame (it is part of
 *  the output — the stats are "as of generation gen"). */
const bufstats: Fn = (buffers, gen) => {
  const b = buffers as FlockBuffers | undefined;
  const g = num(gen, 0);
  if (!b || !(b.positions instanceof Float32Array) || !(b.velocities instanceof Float32Array)) return { gen: g, n: 0, meanSpeed: 0, maxSpeed: 0 };
  const N = Math.min(Math.trunc(num(b.n, b.positions.length / 3)), Math.floor(b.velocities.length / 3));
  let sum = 0, max = 0;
  for (let i = 0; i < N; i++) {
    const s = Math.hypot(b.velocities[i * 3]!, b.velocities[i * 3 + 1]!, b.velocities[i * 3 + 2]!);
    sum += s; if (s > max) max = s;
  }
  return { gen: g, n: N, meanSpeed: N ? sum / N : 0, maxSpeed: max };
};

// ── input binding ────────────────────────────────────────────────────────────

/** param.set(state, celKey, event) — generic on() handler: event value → cel. */
const paramSet: Fn = async (state, celKey, event) => {
  const t = (event as { target?: { value?: string; valueAsNumber?: number; checked?: boolean; type?: string } } | undefined)?.target;
  const n = t?.valueAsNumber;
  const v = typeof n === "number" && Number.isFinite(n) ? n
    : t?.type === "checkbox" ? t.checked === true
    : (t?.value ?? "");
  const set = resolveFn(state as State, "setValue") as Fn | undefined;
  if (!set) return null;
  const key = String(celKey);
  // sparse-grid commit: writing an EMPTY grid ADDRESS births the cel (the
  // origin.key contract — a shared recipe doesn't carry empty draft cells, so
  // a form's first write must mint them). Named cels must exist — typos throw.
  const dot = key.lastIndexOf(".");
  const addr = dot > 0 ? key.slice(dot + 1) : "";
  if (!(state as State).cels.get(key) && /^[A-Z]+\d+$/.test(addr)) {
    await (resolveFn(state as State, "setCel") as Fn)(state, key, {
      celType: "ValueCel", v, metadata: { key, segment: key.slice(0, dot), name: addr },
    });
  } else {
    await set(state, key, v);                          // the cascade fires dependents (incl. =view re-contributions)
  }
  const dr = resolveFn(state as State, "drain") as Fn | undefined;
  // land the re-fired =view requests (request → ⧉ token + fresh pane slot),
  // then paint. The landing cascade itself recomposes the mount-composing
  // root view (元.view's vals carry each frame's content cels — origin's
  // rewireView), so no runCycle belongs after the drain: an unsuppressed
  // cycle would re-evaluate the =view formulas back to pending requests.
  if (dr && (state as State).cels.get("origin.effects")) await dr(state, "origin.effects");
  if (dr && (state as State).cels.get("dom.paint")) await dr(state, "dom.paint");
  return null;
};

// ── windowing sugar ──────────────────────────────────────────────────────────

/** workbook(id, title, geom?, …'kind:title:ref') — a formula-friendly wbopen:
 *  genesis a self-mounting gen-2 WORKBOOK window over EXISTING content cels.
 *  Tab specs are flat strings ('sheet:params:ecsv.params', 'view:fish:ecsv.fish')
 *  because infix can't author the {ref,title}[] arrays wbopen takes. Sheets
 *  fill the left celBook, views the right cardBook. */
const workbook: Fn = (id, title, ...rest) => {
  const lay = `win.${String(id ?? "wb")}`;
  const sref = `${lay}.state`;
  let geom: { x?: number; y?: number; w?: number; h?: number } = {};
  const sheets: Array<{ ref: string; title: string }> = [];
  const views: Array<{ ref: string; title: string }> = [];
  for (const a of rest) {
    if (a && typeof a === "object" && "__geom" in a) { geom = (a as { __geom: typeof geom }).__geom; continue; }
    const m = /^(sheet|view):([^:]*):(.+)$/.exec(String(a ?? ""));
    if (!m) continue;
    (m[1] === "sheet" ? sheets : views).push({ ref: m[3]!, title: m[2] || m[3]! });
  }
  const refs = [...sheets, ...views].map((t) => t.ref);
  return { genesis: true, kind: "window", layer: lay, cels: {
    [sref]: { celType: "ValueCel", metadata: { name: "state", segment: lay }, v: {
      ref: sref, x: geom.x ?? 120, y: geom.y ?? 70, w: geom.w ?? 900, h: geom.h ?? 560,
      z: 1, min: 0, max: 0, closed: 0, title: String(title ?? id),
      sheets, asheet: 0, views, aview: 0, split: 0.42, full: "",
    } },
    [`${lay}.frame`]: { celType: "FormulaCel", metadata: { name: "frame", segment: lay, parser: "f" },
      f: `(mount ".origin" (wbframe ${sref} win.active ${refs.join(" ")}))` },
  }, ...(geom.w || geom.x ? { geoms: { [String(id ?? "wb")]: geom } } : {}) };
};

// ── the tick pump ────────────────────────────────────────────────────────────
// Per-state registry of running pumps, keyed by config cel key. The WeakMap
// keeps test states from leaking pumps into each other (segment modules are
// imported once per process).

// Effect fns arrive as CALLABLES — the config formula references the verb /
// lambda cels (`fn: swarmstep, kernel: E1, init: flockSeed`), so the
// reference IS the dependency edge and an edited kernel cell reaches the
// pump on its next frame (it re-reads the config cel every tick). Never
// name a function by string here — a string has no inputMap edge (the
// grid-program contract, rule R4). `buffers`/`gen` stay string cel KEYS:
// they are write TARGETS the pump owns, not values. `params` may be either
// — an embedded object (the config formula referenced the params cel, so
// edits re-derive the config) or a cel-key string the pump reads live.
interface PumpCommit { to?: unknown; from?: unknown; every?: unknown; skipEqual?: unknown }
interface PumpEffect { fn?: unknown; kernel?: unknown; buffers?: unknown; params?: unknown; gen?: unknown; init?: unknown; initArgs?: unknown[] }
interface PumpConfig { commits?: PumpCommit[]; effects?: PumpEffect[]; while?: unknown; fps?: unknown }

const pumps = new WeakMap<object, Map<string, { stop: boolean }>>();

const contentEqual = (a: unknown, b: unknown): boolean =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]));

/** sim.run(state, configKey) — start the pump described by the config cel. */
const simRun: Fn = (state, configKey) => {
  const st = state as State;
  const key = String(configKey ?? "");
  let mine = pumps.get(st as unknown as object);
  if (!mine) { mine = new Map(); pumps.set(st as unknown as object, mine); }
  if (mine.has(key)) return "already running";
  const handle = { stop: false };
  mine.set(key, handle);

  const g = globalThis as { requestAnimationFrame?: (cb: () => void) => number; performance?: { now?: () => number } };
  const raf: (cb: () => void) => void = g.requestAnimationFrame
    ? (cb) => g.requestAnimationFrame!(cb)
    : (cb) => { setTimeout(cb, 16); };
  const clock = (): number => (typeof g.performance?.now === "function" ? g.performance.now() : 0);
  const setValueBatch = resolveFn(st, "setValueBatch") as ((s: State, w: Array<[string, unknown]>, o?: unknown) => Promise<unknown>) | undefined;

  let frame = 0;
  const done = (): void => { mine!.delete(key); };
  const loop = async (): Promise<void> => {
    if (handle.stop) return done();
    const cfg = st.cels.get(key)?.v as PumpConfig | undefined;
    if (!cfg || (!Array.isArray(cfg.commits) && !Array.isArray(cfg.effects)) || !setValueBatch) return done();
    if (cfg.while) {
      const w = st.cels.get(String(cfg.while))?.v as { closed?: unknown } | undefined;
      if (!w || w.closed) return done();               // window gone → pump stops
    }
    const t0 = clock();
    frame++;
    const writes: Array<[string, unknown]> = [];
    // EFFECT MODE (doctrine #5: continuous state = effect) — the dense
    // interior: mutate the buffer cel's SoA typed arrays IN PLACE and bump
    // the generation cel. The gen write is what re-fires the sceneframe
    // cel → scene.paint drains → dirty instances upload. Per-frame entity
    // state never crosses the graph; only the generation does.
    for (const eff of cfg.effects ?? []) {
      try {
        const bufKey = String(eff.buffers ?? "");
        if (!bufKey) continue;
        let buf = st.cels.get(bufKey)?.v as { positions?: unknown } | undefined;
        if ((!buf || !buf.positions) && isFn(eff.init)) {
          buf = (await eff.init(...(Array.isArray(eff.initArgs) ? eff.initArgs : []))) as { positions?: unknown };
          const setV = resolveFn(st, "setValue") as Fn | undefined;
          if (setV) await setV(st, bufKey, buf);       // seed once, no flush
        }
        const stepFn = isFn(eff.fn) ? eff.fn : undefined;
        const params = typeof eff.params === "string" ? st.cels.get(eff.params)?.v : eff.params;
        if (stepFn && buf && buf.positions) stepFn(buf, params, isFn(eff.kernel) ? eff.kernel : undefined);
        if (eff.gen) writes.push([String(eff.gen), frame]);
      } catch { /* one bad effect must not kill the pump */ }
    }
    for (const c of cfg.commits ?? []) {
      const every = Math.max(1, Math.trunc(num(c.every, 1)));
      if (frame % every !== 0) continue;
      const from = String(c.from ?? ""), to = String(c.to ?? "");
      const v = st.cels.get(from)?.v;
      if (v === undefined || !to) continue;
      if (c.skipEqual === true && contentEqual(v, st.cels.get(to)?.v)) continue;
      writes.push([to, v]);
    }
    // effects need scene.paint drained too → flush "all"; pure-commit pumps
    // keep the cheaper dom.paint-only flush.
    if (writes.length) {
      await setValueBatch(st, writes, { flush: cfg.effects?.length ? "all" : "dom.paint" });
      // A committing pump's batch cascade re-fires any =view cell to its
      // REQUEST; land those (request → ⧉ token + fresh pane slot), then
      // paint. The landing cascade recomposes the mount-composing root view
      // itself (元.view's vals carry each frame's content cels — origin's
      // rewireView), so the per-frame block is just drain + paint: an
      // unsuppressed runCycle here would re-pend the =view formulas, and a
      // per-frame view.refresh would pay a full rewire/precompute for
      // nothing. Effect-mode pumps (scene.paint + three's loop) skip this.
      if (cfg.commits?.length) {
        const dr = resolveFn(st, "drain") as Fn | undefined;
        if (dr && st.cels.get("origin.effects")) await dr(st, "origin.effects");
        if (dr && st.cels.get("dom.paint")) await dr(st, "dom.paint");
      }
    }
    // fps governor — the scheduler doc's loop shape: fill the remainder of the
    // frame budget with a wait, so a slow frame doesn't compound the backlog.
    // cfg.fps is read every frame, so it's live-editable. Unset → raw rAF.
    const fps = num(cfg.fps, 0);
    if (fps > 0) {
      const budget = 1000 / Math.min(240, Math.max(1, fps));
      setTimeout(() => void loop(), Math.max(0, budget - (clock() - t0)));
    } else {
      raf(() => void loop());
    }
  };
  raf(() => void loop());
  return "running";
};

/** sim.stop(state, configKey) — stop that pump. */
const simStop: Fn = (state, configKey) => {
  const handle = pumps.get(state as unknown as object)?.get(String(configKey ?? ""));
  if (handle) handle.stop = true;
  return handle ? "stopping" : "not running";
};

export const name = "ecs" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sysmap",    sysmap],
  ["neighbors", neighbors],
  ["integrate", integrate],
  ["wrap",      wrap],
  ["opmap",     opmap],
  ["gridops",   gridops],
  ["automaton", automaton],
  ["param.set", paramSet],
  ["sim.run",   simRun],
  ["sim.stop",  simStop],
  ["workbook",  workbook],
  ["flockSeed", flockSeed],
  ["swarmstep", swarmstep],
  ["bufstats",  bufstats],
]));
