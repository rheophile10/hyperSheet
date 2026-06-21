// ============================================================================
// sheets bench runner — kernel-side phases (sheets-bench-harness.md).
//
//   bun bench/sheets/run.mjs <size> <phase>     (fresh process per cell!)
//   bun bench/sheets/run.mjs all                (spawns fresh children)
//
// sizes:  S (8×5/13 used)  M (40×26/~500)  L (200×26/~2600)  XL (synthetic 10k)
// phases: boot | edit | noop | commit | range-edit | save-open | xl-precompute
//
// This runner measures the GRAPH: fires, suppression, precompute count/ms
// (view-side phases — select / diff / paint — are out of scope here).
// Wall-clock is reported but counters are the trustworthy signal.
// ============================================================================
import { createInitialState, precomputeOptional, resolveFn, buildSheet } from "../../dist/index.js";

const SIZES = {
  S: { rows: 8, cols: 5 },
  M: { rows: 40, cols: 26 },
  L: { rows: 200, cols: 26 },
};

const colName = (i) => { let n = i + 1, s = ""; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };

// Populate ~25% of cells: literals in col A/B, a formula chain in C, SUMs in row 1 of D+.
const cellsFor = ({ rows, cols }) => {
  const cells = {};
  for (let r = 1; r <= rows; r++) {
    cells[`A${r}`] = String(r);
    cells[`B${r}`] = String(r * 2);
    cells[`C${r}`] = r === 1 ? "=A1+B1" : `=C${r - 1}+A${r}`;
  }
  for (let c = 3; c < Math.min(cols, 10); c++) {
    cells[`${colName(c)}1`] = `=SUM(A1:A${rows})`;
  }
  return cells;
};

const boot = async (size) => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const seg = buildSheet({ ...SIZES[size], cells: cellsFor(SIZES[size]) });
  await hydrate(state, [seg], [seg]);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  return state;
};

const resetCounters = () => { globalThis.__plastronCounters = {}; return globalThis.__plastronCounters; };

const report = (label, wallMs, c) => {
  const out = { label, wallMs: +wallMs.toFixed(2), ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(2) : v])) };
  console.log(JSON.stringify(out));
};

const PHASES = {
  async boot(size) {
    resetCounters();
    const t0 = performance.now();
    const state = await boot(size);
    report(`boot/${size}`, performance.now() - t0, { ...globalThis.__plastronCounters, cels: state.cels.size });
  },
  async edit(size) {
    const state = await boot(size);
    const set = resolveFn(state, "setValue");
    // warmup
    for (let i = 0; i < 10; i++) await set(state, "sheet.A1", i);
    const c = resetCounters();
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) await set(state, "sheet.A1", 100 + i);
    report(`edit/${size}`, performance.now() - t0, c);
  },
  async noop(size) {
    const state = await boot(size);
    const set = resolveFn(state, "setValue");
    await set(state, "sheet.A1", 42);
    const c = resetCounters();
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) await set(state, "sheet.A1", 42);
    report(`noop/${size}`, performance.now() - t0, c);
  },
  async commit(size) {
    const state = await boot(size);
    const commit = resolveFn(state, "sheet.commit-cell");
    await commit(state, { addr: "B2", input: "=A1*1" }); // warmup the path
    const c = resetCounters();
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) await commit(state, { addr: "B2", input: `=A1*${i + 2}` });
    report(`commit/${size}`, performance.now() - t0, c);
  },
  async "range-edit"(size) {
    const state = await boot(size);
    const set = resolveFn(state, "setValue");
    const c = resetCounters();
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) await set(state, "sheet.A5", i);
    report(`range-edit/${size}`, performance.now() - t0, c);
  },
  async "save-open"(size) {
    const state = await boot(size);
    const dehydrate = resolveFn(state, "dehydrate");
    const c = resetCounters();
    const t0 = performance.now();
    const json = JSON.parse(JSON.stringify(await dehydrate(state)));
    const bytes = JSON.stringify(json).length;
    const next = createInitialState();
    await resolveFn(next, "hydrate")(next, json.segments, json.manifests);
    await precomputeOptional(next);
    await resolveFn(next, "runCycle")(next);
    report(`save-open/${size}`, performance.now() - t0, { ...c, payloadBytes: bytes });
  },
  // XL: synthetic registry growth — the O2 gate. Measures precompute cost
  // at 1k/5k/10k cels via setCel-triggered full precomputes.
  async "xl-precompute"() {
    for (const n of [1000, 5000, 10000]) {
      const state = createInitialState();
      const setCel = resolveFn(state, "setCel");
      // bulk-load n value cels via one batch (one precompute)
      const batch = {};
      for (let i = 0; i < n; i++) batch[`x${i}`] = { celType: "ValueCel", v: i, metadata: { segment: "xl" } };
      await resolveFn(state, "setCelBatch")(state, batch);
      const c = resetCounters();
      const t0 = performance.now();
      for (let i = 0; i < 10; i++) {
        await setCel(state, `y${i}`, { celType: "FormulaCel", f: `(+ x1 x2)`, metadata: { segment: "xl" } });
      }
      report(`xl-precompute/${n}`, performance.now() - t0, { ...c, perCommitMs: +((c.precomputeMs ?? 0) / (c.precomputeCount || 1)).toFixed(2) });
    }
  },
};

const [, , a, b] = process.argv;
if (a === "all") {
  const { spawnSync } = await import("node:child_process");
  for (const size of ["S", "M", "L"]) {
    for (const phase of ["boot", "edit", "noop", "commit", "range-edit", "save-open"]) {
      const r = spawnSync("bun", [import.meta.url.replace("file://", ""), size, phase], { encoding: "utf8" });
      process.stdout.write(r.stdout);
      if (r.status !== 0) process.stderr.write(r.stderr);
    }
  }
  const r = spawnSync("bun", [import.meta.url.replace("file://", ""), "XL", "xl-precompute"], { encoding: "utf8" });
  process.stdout.write(r.stdout);
} else if (a && b && PHASES[b]) {
  await PHASES[b](a);
} else {
  console.error("usage: bun bench/sheets/run.mjs <S|M|L|XL> <phase> | all");
  process.exit(1);
}
