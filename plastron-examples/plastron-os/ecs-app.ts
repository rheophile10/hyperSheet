// ============================================================================
// ECS app — a school of fish (boids) + a B/S cellular automaton, built ON
// the generic ecs vocabulary (ecs-segment.ts). The point of the experiment:
// how much of an ECS can be pure graph?
//
//   component tables   ValueCels: sim.positions / sim.velocities (pairs),
//                      life.grid (flat 0/1) — one cel per TABLE, entity=index
//   parameters         ValueCels the sliders write: cohesion / alignment /
//                      separation / speed / radius / life.rules — every
//                      system formula references them, so edits take effect
//                      mid-flight through plain inputMap edges
//   systems            FormulaCels composing the generic vocabulary; the one
//                      app-specific lambda is boidRule (the per-entity rule
//                      sysmap runs). Render systems are FormulaCels too:
//                      sim.fishNode / life.node emit <canvas> vnodes via
//                      opmap/gridops + the plastron-canvas ops.
//   time               the pump: a rAF loop (Doom's auto-boot pattern) that
//                      COMMITS the already-computed *.next values back into
//                      the component tables. Imperative on purpose — a
//                      formula can't write its own input (CycleError); the
//                      graph derives, the pump advances.
//
// Life freeze: the pump skips the grid write when next === current
// (still-life), so life.node never refires and its canvas subtree diff-skips
// by reference. (A SchemaCel isChanged could do this at the graph level —
// deliberately not used here; see the ecs design notes.)
// ============================================================================

import { resolveFn } from "../../plastron/dist/index.js";
import { installEcsVocabulary } from "./ecs-segment.js";

type Pair = [number, number];
type NeighborRow = [Pair, Pair]; // [position, velocity] per neighbor

// ── the one app-specific lambda: per-entity steering ────────────────────────
// sysmap slices the tables; nbrs comes from (neighbors positions radius
// velocities), so each row is [pos_j, vel_j]. Returns the entity's new
// velocity. Classic boids: cohesion + alignment + separation, speed-clamped.
const boidRule = (
  pos: Pair, vel: Pair, nbrs: NeighborRow[],
  cohesion: number, alignment: number, separation: number, maxSpeed: number,
): Pair => {
  let [vx, vy] = vel;
  if (nbrs.length > 0) {
    let cx = 0, cy = 0, avx = 0, avy = 0, sx = 0, sy = 0;
    for (const [[nx, ny], [nvx, nvy]] of nbrs) {
      cx += nx; cy += ny;
      avx += nvx; avy += nvy;
      const dx = pos[0] - nx, dy = pos[1] - ny;
      const d2 = Math.max(1, dx * dx + dy * dy);
      sx += dx / d2; sy += dy / d2;
    }
    const n = nbrs.length;
    vx += (cx / n - pos[0]) * cohesion + (avx / n - vx) * alignment + sx * separation * 40;
    vy += (cy / n - pos[1]) * cohesion + (avy / n - vy) * alignment + sy * separation * 40;
  }
  const speed = Math.hypot(vx, vy) || 1;
  const clamped = Math.min(Math.max(speed, 0.6), Math.max(0.6, maxSpeed));
  return [(vx / speed) * clamped, (vy / speed) * clamped];
};

// ── seeds ────────────────────────────────────────────────────────────────────

const FISH = 60, W = 640, H = 400;
const LIFE_W = 48, LIFE_H = 30, LIFE_CELL = 8;

const seedFish = (): { positions: Pair[]; velocities: Pair[] } => {
  const positions: Pair[] = [], velocities: Pair[] = [];
  for (let i = 0; i < FISH; i++) {
    positions.push([Math.random() * W, Math.random() * H]);
    const a = Math.random() * Math.PI * 2;
    velocities.push([Math.cos(a) * 2, Math.sin(a) * 2]);
  }
  return { positions, velocities };
};

const seedLife = (): number[] =>
  Array.from({ length: LIFE_W * LIFE_H }, () => (Math.random() < 0.28 ? 1 : 0));

// ── the app view template ────────────────────────────────────────────────────
// {{fish}} / {{life}} embed the render-system FormulaCels' vnodes; when a
// canvas cel didn't refire its subtree keeps reference identity and the
// paint diff skips it. Sliders write params via one generic dispatch.
const ECS_TEMPLATE = `
<div class="ecs-app">
  <div class="toolbar">
    <button class="close" onClick={{(dispatch "os.exit")}}>×</button>
    <span>🐠 ECS — school of cels</span>
  </div>
  <div class="ecs-canvases">
    <div class="ecs-pane"><h4>boids — sysmap/neighbors/integrate/wrap</h4>{{fish}}</div>
    <div class="ecs-pane"><h4>automaton — {{rules}}</h4>{{life}}</div>
  </div>
  <div class="ecs-params">
    <label>cohesion <input type="range" min="0" max="0.05" step="0.002" value={{cohesion}} onInput={{(dispatch "sim.param" "sim.cohesion")}} /></label>
    <label>alignment <input type="range" min="0" max="0.2" step="0.01" value={{alignment}} onInput={{(dispatch "sim.param" "sim.alignment")}} /></label>
    <label>separation <input type="range" min="0" max="0.2" step="0.01" value={{separation}} onInput={{(dispatch "sim.param" "sim.separation")}} /></label>
    <label>speed <input type="range" min="0.5" max="6" step="0.25" value={{speed}} onInput={{(dispatch "sim.param" "sim.speed")}} /></label>
    <label>radius <input type="range" min="10" max="150" step="5" value={{radius}} onInput={{(dispatch "sim.param" "sim.radius")}} /></label>
    <label>rules <input class="ecs-rules" value={{rules}} onInput={{(dispatch "sim.param" "life.rules")}} /></label>
    <label><input type="checkbox" checked={{running}} onClick={{(dispatch "sim.toggle")}} /> running</label>
    <button onClick={{(dispatch "sim.reseed")}}>reseed</button>
  </div>
</div>`;

// ── builder ──────────────────────────────────────────────────────────────────

export const buildEcsApp = async (state: any): Promise<void> => {
  await installEcsVocabulary(state);
  const r = (k: string) => resolveFn(state, k) as (...a: unknown[]) => Promise<unknown>;
  const setCel = r("setCel");
  const reg = (key: string, fn: unknown, locked = false) =>
    setCel(state, key, { celType: locked ? "LockedLambdaCel" : "EditableLambdaCel", locked, fn, metadata: { kind: locked ? "native" : "custom" } });

  await reg("boidRule", boidRule, true);
  // Self-sufficient like sheets: the mount-gate formula needs these even if
  // the desktop helpers haven't registered them yet (tests, standalone boots).
  await reg("if", (c: unknown, a: unknown, b: unknown) => (c ? a : b));
  await reg("eq", (a: unknown, b: unknown) => a === b);

  // One generic param handler: dispatch payload is the target cel key.
  // Range inputs give a number (valueAsNumber), the rules box a string.
  await reg("sim.param", async (st: unknown, key: unknown, event: { target?: { value?: string; valueAsNumber?: number } }) => {
    const n = event?.target?.valueAsNumber;
    const v = typeof n === "number" && Number.isFinite(n) ? n : (event?.target?.value ?? "");
    await (resolveFn(st as never, "setValue") as (...a: unknown[]) => Promise<unknown>)(st, String(key), v);
  });
  await reg("sim.toggle", async (st: any) => {
    await (resolveFn(st, "setValue") as (...a: unknown[]) => Promise<unknown>)(st, "sim.running", !st.cels.get("sim.running")?.v);
  });
  await reg("sim.reseed", async (st: any) => {
    const { positions, velocities } = seedFish();
    await (resolveFn(st, "setValueBatch") as (...a: unknown[]) => Promise<unknown>)(st, [
      ["sim.positions", positions], ["sim.velocities", velocities], ["life.grid", seedLife()],
    ], { flush: "dom.paint" });
  });

  // ── the pump — the single imperative residue (Doom's auto-boot shape) ──
  // Each frame: commit the graph's already-derived *.next into the tables
  // (one suppressed cascade + inline paint drain via {flush}); the cascade
  // then derives the FOLLOWING frame. CA advances every 8th frame and
  // skips the write entirely once next === current (still-life freeze).
  let rafId: number | null = null;
  let frame = 0;
  const sameGrid = (a: unknown, b: unknown): boolean =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  const pump = async (): Promise<void> => {
    rafId = null;
    if (state.cels.get("os.active")?.v !== "ecs") return; // app left — stop dead
    if (state.cels.get("sim.running")?.v) {
      const writes: Array<[string, unknown]> = [];
      const p = state.cels.get("sim.pnext")?.v, v = state.cels.get("sim.vnext")?.v;
      if (Array.isArray(p) && Array.isArray(v)) writes.push(["sim.positions", p], ["sim.velocities", v]);
      if (++frame % 8 === 0) {
        const g = state.cels.get("life.grid")?.v, next = state.cels.get("life.next")?.v;
        if (Array.isArray(next) && !sameGrid(g, next)) writes.push(["life.grid", next]);
      }
      if (writes.length) await r("setValueBatch")(state, writes, { flush: "dom.paint" });
    }
    rafId = requestAnimationFrame(() => void pump());
  };

  // Registered BEFORE hydrate so the auto-boot FormulaCel's initial firing
  // (against os.active="home") finds it — same caveat as doom.maybe-boot.
  await reg("ecs.maybe-run", (active: unknown): null => {
    if (active === "ecs") {
      if (rafId === null && typeof requestAnimationFrame === "function") {
        rafId = requestAnimationFrame(() => void pump());
      }
    } else if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    return null;
  });

  const { positions, velocities } = seedFish();
  const value = (key: string, v: unknown) => ({ key, celType: "ValueCel", metadata: { key, segment: "ecs" }, v });
  const formula = (key: string, f: string, metadata: Record<string, unknown> = {}) =>
    ({ key, celType: "FormulaCel", metadata: { key, segment: "ecs", parser: "f", ...metadata }, f });

  const seg = {
    name: "ecs", version: "0.1.0",
    dependencies: ["app-host", "html-template-parser", "dom", "plastron-canvas"],
    role: "application",
    cels: [
      // parameters — the upstream cels every system formula hangs off
      value("sim.cohesion", 0.01),
      value("sim.alignment", 0.06),
      value("sim.separation", 0.05),
      value("sim.speed", 2.5),
      value("sim.radius", 60),
      value("sim.dt", 1),
      value("sim.width", W),
      value("sim.height", H),
      value("sim.running", true),
      value("life.rules", "B3/S23"),
      value("life.w", LIFE_W),
      value("life.h", LIFE_H),
      value("life.cell", LIFE_CELL),
      value("life.pw", LIFE_W * LIFE_CELL),
      value("life.ph", LIFE_H * LIFE_CELL),
      // component tables — entity = index
      value("sim.positions", positions),
      value("sim.velocities", velocities),
      value("life.grid", seedLife()),
      // systems — pure derivations; auto-wired by the "f" parser
      formula("sim.vnext",
        "(sysmap boidRule sim.positions sim.velocities (neighbors sim.positions sim.radius sim.velocities) sim.cohesion sim.alignment sim.separation sim.speed)"),
      formula("sim.pnext",
        "(wrap (integrate sim.positions sim.vnext sim.dt) sim.width sim.height)"),
      formula("life.next",
        "(automaton life.grid life.w life.h life.rules)"),
      // render systems — canvas vnodes from tables, zero app-specific fns
      formula("sim.fishNode",
        '(canvas sim.width sim.height (rect 0 0 sim.width sim.height "#0b1020") (opmap circle sim.positions 3 "#4fc3f7"))'),
      formula("life.node",
        '(canvas life.pw life.ph (rect 0 0 life.pw life.ph "#101418") (gridops rect life.grid life.w life.h life.cell "#7cfc00"))'),
      // app plumbing — mount gate, pump control, gated view
      formula("ecs.mount", '(if (eq active "ecs") "#app" null)', { inputMap: { active: "os.active" } }),
      formula("ecs.auto-boot", "(ecs.maybe-run active)", { inputMap: { active: "os.active" } }),
      {
        key: "ecs.view", celType: "FormulaCel",
        metadata: {
          key: "ecs.view", segment: "ecs", parser: "html-template", schema: "render-spec",
          channel: ["dom.paint"],
          inputMap: {
            mount: "ecs.mount",
            fish: "sim.fishNode", life: "life.node",
            cohesion: "sim.cohesion", alignment: "sim.alignment", separation: "sim.separation",
            speed: "sim.speed", radius: "sim.radius", rules: "life.rules", running: "sim.running",
          },
        },
        f: ECS_TEMPLATE,
      },
    ],
  };
  await r("hydrate")(state, [seg], [{ name: "ecs", version: "0.1.0", dependencies: seg.dependencies, role: "application" }]);
};
