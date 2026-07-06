import type { State, 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// scheduler — the learn / lock / lose adaptive frame governor (onecell §6),
// as a reusable cel group. It decouples THREE rates — desired (clock.target_fps),
// device-sustainable (the learned clock.cost_ewma), and the scheduled wait
// (clock.interval) — via a tiny feedback controller instead of a fixed clock.
//
// The host frame loop:
//   let interval = 16;
//   const frame = async () => {
//     const t0 = performance.now();
//     await step(state); await runCycle(state); await drain(state, "scene.paint");
//     interval = await clock.tick(state, performance.now() - t0);  // governor
//     setTimeout(frame, interval);
//   };
//
// governStep is PURE (no cels, no clock) so the controller is unit-testable
// off-browser: feed a cost sequence, assert the model + interval converge.
// ============================================================================

const ALPHA = 0.15;            // EWMA weight for a new cost sample (~learns over ~7 frames)
const FLOOR_FPS = 4, CEIL_FPS = 240;
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export interface Govern { cost_ewma: number; samples: number; interval: number; fps: number }

/** governStep(cost_ewma, samples, cost, target_fps, mode) — the pure governor.
 *  Folds the measured frame `cost` into the EWMA cost model per `mode`, then
 *  derives the next `interval` (ms to wait) and the achievable `fps`:
 *   - the sustainable PERIOD is never shorter than the work actually takes —
 *     `max(budget, cost_ewma)` — so a slow device degrades to its real rate
 *     instead of busy-waiting toward an impossible target;
 *   - `interval = max(0, period - cost)` fills the remainder of that period. */
export const governStep = (
  cost_ewma: unknown, samples: unknown, cost: unknown, target_fps: unknown, mode: unknown,
): Govern => {
  const c = Math.max(0, num(cost, 0));
  const tf = clamp(num(target_fps, 60), FLOOR_FPS, CEIL_FPS);
  const budget = 1000 / tf;
  let ewma = Math.max(0, num(cost_ewma, 0));
  let n = Math.max(0, Math.trunc(num(samples, 0)));
  const m = String(mode ?? "learn");

  if (m === "lose") { ewma = c; n = 1; }            // reset: forget the model, reseed from this sample
  else if (m === "lock") { /* frozen — use the learned model as-is */ }
  else if (n === 0) { ewma = c; n = 1; }            // learn, first sample
  else { ewma = ewma + ALPHA * (c - ewma); n += 1; } // learn, EWMA fold

  const period = Math.max(budget, ewma);
  const interval = Math.max(0, period - c);
  const fps = 1000 / period;
  return { cost_ewma: ewma, samples: n, interval, fps };
};

/** clock.tick(state, cost) — the cel-bound governor step. Reads the clock.*
 *  knobs/model, runs governStep, writes the model + outputs back as cels (so
 *  clock.fps/interval are observable + snapshot), returns the next interval. */
const tick: Fn = (async (state: State, cost: unknown): Promise<number> => {
  const g = (k: string): unknown => state.cels.get(k)?.v;
  const setV = resolveFn(state, "setValue") as Fn;
  const r = governStep(g("clock.cost_ewma"), g("clock.samples"), cost, g("clock.target_fps"), g("clock.mode"));
  await setV(state, "clock.cost_ewma", r.cost_ewma);
  await setV(state, "clock.samples", r.samples);
  await setV(state, "clock.interval", r.interval);
  await setV(state, "clock.fps", r.fps);
  return r.interval;
}) as Fn;

export const name = "scheduler" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["clock.tick", tick],
]));
