// amortization on the NEW kernel — resolveFn / setCelBatch / setValue.
import { bench } from "../harness.js";
import { profile } from "../profile.js";
import { params } from "./params.js";
import type { Fn, State } from "../../../plastron/src/index.js";
import { createInitialState, precomputeOptional, resolveFn } from "../../../plastron/src/index.js";

const P = params.amortization;

const buildCels = (n: number, principal: number): Record<string, unknown> => {
  const cels: Record<string, unknown> = {
    monthlyRate: { celType: "ValueCel", v: P.shared.monthlyRateInit, metadata: { segment: "amort" } },
    payment: { celType: "ValueCel", v: P.shared.payment, metadata: { segment: "amort" } },
    balance_0: { celType: "ValueCel", v: principal, metadata: { segment: "amort" } },
  };
  for (let i = 1; i <= n; i++) {
    cels[`balance_${i}`] = { celType: "FormulaCel", f: `(- (* balance_${i - 1} (+ 1 monthlyRate)) payment)`, metadata: { segment: "amort", parser: "f" } };
  }
  const refs = Array.from({ length: n }, (_, i) => `balance_${i + 1}`).join(" ");
  cels["total_paid"] = { celType: "FormulaCel", f: `(+ ${refs})`, metadata: { segment: "amort", parser: "f" } };
  return cels;
};

interface Setup { state: State; setValue: Fn; runCycle: Fn; rateCounter: { v: number }; }

const setup = async (n: number): Promise<Setup> => {
  const state = createInitialState();
  await (resolveFn(state, "ensureSegments") as Fn)(state, ["builtins"]);
  await (resolveFn(state, "hydrate") as Fn)(state, [], []);
  await (resolveFn(state, "setCelBatch") as Fn)(state, buildCels(n, P.shared.principal));
  const runCycle = resolveFn(state, "runCycle") as Fn;
  await runCycle(state);
  await precomputeOptional(state);
  return { state, setValue: resolveFn(state, "setValue") as Fn, runCycle, rateCounter: { v: P.shared.monthlyRateInit } };
};

const tick = async (s: Setup): Promise<void> => {
  s.rateCounter.v += 1e-9;
  await s.setValue(s.state, "monthlyRate", s.rateCounter.v); // cascades on its own
};

const main = async (): Promise<void> => {
  const allTimings: Record<string, unknown> = {};
  const p = profile.start({ label: "amortization-plastron-new" });
  let totalOps = 0;
  const sizes = P.plastron.sizes;
  // sanity: cascade actually propagates
  const s0 = await setup(10); const b0 = (s0.state.cels.get("balance_10") as { v?: number }).v;
  await tick(s0); const b1 = (s0.state.cels.get("balance_10") as { v?: number }).v;
  process.stderr.write(`  [sanity] balance_10 changed on tick: ${b0 !== b1} (diff ${(b1!-b0!).toExponential(2)})\n`);
  for (const n of sizes) {
    process.stderr.write(`  amort-new n=${n}... `);
    const stats = await bench(() => setup(n), tick, { warmup: P.plastron.warmup(n), iterations: P.plastron.iterations(n) });
    allTimings[`n=${n}`] = stats; totalOps += stats.n;
    process.stderr.write(`p50=${(stats.p50 / 1000).toFixed(1)}μs p99=${(stats.p99 / 1000).toFixed(1)}μs\n`);
  }
  const headline = allTimings[`n=${sizes[sizes.length - 1]}`] as never;
  profile.emit(p.stop({ timings: headline, opCount: totalOps, meta: { sizes: [...sizes], perSizeTimings: allTimings } }));
};
main().catch((e) => { console.error(e); process.exit(1); });
