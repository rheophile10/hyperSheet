// ============================================================================
// scale/run.mjs — the scale bench driver.
//
// Usage:
//   bun run.mjs                 # default sizes (10k, 100k)
//   bun run.mjs 10000 100000 1000000
//
// For each shape (wide-flat, deep-chain, diamond-mesh) at each N it
// measures:
//   build       — hydrate + precompute + first runCycle (the cold construct)
//   edit-storm  — M random single-leaf edits; PER-EDIT time-to-settle
//                 (p50/p99/max). These are the gate numbers:
//                 <16ms settle @10k, <100ms settle @100k.
//   structural  — add one cel + precompute, then remove it + precompute
//                 (the precompute-cost bench).
//
// Emits a JSON blob on stdout (consumed to write RESULTS.md) and a
// human line on stderr per measurement.
// ============================================================================

import { SHAPES } from "./shapes.mjs";
import { bootSegment, stats, ms, timed, mulberry32, rssMB } from "./lib.mjs";

const argv = process.argv.slice(2);
const SIZES = argv.length ? argv.map(Number) : [10_000, 100_000];

// Per-shape size cap. deep-chain's build/structural cost is super-linear in
// chain DEPTH (buildDownstream recursion + topoLevels over a 100k-deep chain
// re-runs the full fireable set per structural edit — design hazard #1). At
// N=10k it already takes ~11s to build and ~11s per structural add; N=100k
// did not complete in a reasonable wall budget. We SKIP it past its cap and
// record why, rather than hang the suite. wide-flat / diamond-mesh run at
// every requested size.
const MAX_N = {
  "deep-chain": 10_000,
};

// edit-storm sample count: enough samples for a stable p99 without making
// the 100k/1M runs take forever. Each sample is one full settle.
const STORM = (count) => (count >= 500_000 ? 80 : count >= 50_000 ? 200 : 500);

const log = (s) => process.stderr.write(s + "\n");

const settleEdit = async (h, key, value) =>
  timed(() => h.setValue(h.state, key, value));

// One structural add/remove round. We add a brand-new value cel that an
// existing sink reads is not required — the cost we care about is the
// precompute re-run over the fireable set, which setCelBatch + precompute
// triggers regardless. We add, precompute, read it, then remove (replace
// the graph by re-precomputing after delete) and precompute again.
const structuralRound = async (h, seg, sinkKey) => {
  const newKey = `__struct_probe__`;
  // ADD: a formula cel referencing the sink (so it actually wires into the
  // graph and forces a topo recompute), via setCelBatch (structure tier).
  const add = await timed(async () => {
    await h.setCelBatch(h.state, {
      [newKey]: {
        celType: "FormulaCel",
        metadata: { key: newKey, segment: seg, parser: "f" },
        f: `(+ ${sinkKey} 1)`,
      },
    });
    await h.precomputeOptional();
  });
  // REMOVE: delete the cel from the registry and re-precompute. There is no
  // public "deleteCel" fn; removal in plastron is registry mutation +
  // precompute (the same path a host takes when a cel is dropped). We mutate
  // state.cels directly — this is the bench measuring the precompute cost of
  // a shrunk fireable set, not exercising a kernel write fn.
  const remove = await timed(async () => {
    h.state.cels.delete(newKey);
    await h.precomputeOptional();
  });
  return { add, remove };
};

const runShape = async (name, N) => {
  const built = SHAPES[name](N);
  const { seg, cels, sinkKey, editTargets, count } = built;

  // ── build ──────────────────────────────────────────────────────────────
  let h;
  const buildMs = await timed(async () => {
    h = await bootSegment(seg, cels);
  });
  const rss = rssMB();

  // sanity: did the sink resolve to a real number, or to a CelError? A
  // 100k-wide single (+ …) formula trips "Out of memory" in the formula
  // evaluator — the codegen for one N-wide call blows up. When that happens
  // the storm below is re-firing an ERRORED cel, so flag it: the settle
  // numbers are not a clean fan-in measurement.
  const sinkCel = h.getCel(h.state, sinkKey);
  const sinkV = sinkCel?.v;
  const sinkError =
    sinkV && typeof sinkV === "object" && sinkV.kind === "error"
      ? { trap: sinkV.trap, message: sinkV.message }
      : null;

  // ── edit-storm ───────────────────────────────────────────────────────────
  const rand = mulberry32(0x5ca1e + N);
  const samples = [];
  const m = STORM(count);
  for (let i = 0; i < m; i++) {
    const key = editTargets[Math.floor(rand() * editTargets.length)];
    // a changing value so the write is never a suppressed no-op
    const value = 1 + (i % 997) + rand();
    samples.push(await settleEdit(h, key, value));
  }
  const storm = stats(samples);

  // ── structural-edit ────────────────────────────────────────────────────
  // a few rounds; report the median add + median remove
  const adds = [];
  const removes = [];
  for (let i = 0; i < 5; i++) {
    const { add, remove } = await structuralRound(h, seg, sinkKey);
    adds.push(add);
    removes.push(remove);
  }
  const structAdd = stats(adds);
  const structRemove = stats(removes);

  log(
    `  ${name} N=${N} (cels=${count}): build=${ms(buildMs)}ms ` +
      `storm p50=${ms(storm.p50)} p99=${ms(storm.p99)} max=${ms(storm.max)} ` +
      `struct+ p50=${ms(structAdd.p50)} struct- p50=${ms(structRemove.p50)} ` +
      `rss=${rss.toFixed(0)}MB sink=${sinkError ? `ERROR(${sinkError.trap}: ${sinkError.message})` : sinkV}`,
  );

  return {
    shape: name,
    N,
    cels: count,
    buildMs,
    rssMB: rss,
    sinkKey,
    sinkV: sinkError ? null : sinkV,
    sinkError,
    stormSamples: storm.n,
    storm,
    structAdd,
    structRemove,
  };
};

const main = async () => {
  const results = [];
  for (const N of SIZES) {
    log(`=== N=${N} ===`);
    for (const name of Object.keys(SHAPES)) {
      const cap = MAX_N[name];
      if (cap !== undefined && N > cap) {
        const reason = `skipped: ${name} caps at N=${cap} — build/structural cost is super-linear in chain depth (design hazard #1); N=${N} did not settle in a reasonable wall/memory budget`;
        log(`  ${name} N=${N} ${reason}`);
        results.push({ shape: name, N, skipped: true, reason });
        continue;
      }
      try {
        results.push(await runShape(name, N));
      } catch (err) {
        log(`  ${name} N=${N} FAILED: ${err?.message ?? err}`);
        results.push({ shape: name, N, error: String(err?.message ?? err) });
      }
      // let GC breathe between big graphs
      if (globalThis.gc) globalThis.gc();
    }
  }
  process.stdout.write(JSON.stringify(results, null, 2) + "\n");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
