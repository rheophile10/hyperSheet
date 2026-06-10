# plastron scale benches

Scale-stress suite for the reactive kernel — the **gate** benches for the
`kernel-hardening-and-scale` design (`plastron/docs/1-design/1-under-consideration/`).
These MEASURE the kernel through its public API only (`createInitialState`,
`hydrate`, `precomputeOptional`, `runCycle`, `setValue`, `setCelBatch`,
`getCel`); they do **not** patch `src/`.

## Running

The kernel must be built first (these import from `../../plastron/dist`):

```sh
cd ../../plastron && bun run build
cd ../bench/scale
bun run.mjs                       # default sizes: 10_000, 100_000
bun run.mjs 1000                  # quick smoke
bun run.mjs 10000 100000 1000000  # add the 1M attempt
```

`run.mjs` writes a JSON result array to stdout and a human line per
measurement to stderr. Pipe stdout to capture; numbers are per-machine and
not checked in (only `RESULTS.md`, the recorded run, is).

## Shapes (`shapes.mjs`)

- **wide-flat** — N value cels + one `(+ …)` SUM over all of them. Input
  fan-in: every leaf edit re-fires the single wide aggregate.
- **deep-chain** — N cels, each `(+ c_{i-1} 1)`. Topo depth: a head edit
  walks the whole chain.
- **diamond-mesh** — N×N grid (side = √N); interior cells depend on two
  neighbors (`(+ g_{r-1,c} g_{r,c-1})`). The realistic spreadsheet
  recompute wavefront.

## Measurements (`run.mjs`)

- **build** — hydrate + precompute + first `runCycle` (cold construct).
- **edit-storm** — M random single-leaf `setValue`s; **per-edit
  time-to-settle** (p50/p99/max). These are the gate numbers:
  **< 16 ms settle @ 10k, < 100 ms settle @ 100k.**
- **structural-edit** — add one formula cel (`setCelBatch` + precompute),
  then delete it + precompute. The precompute-cost bench.

`lib.mjs` holds the shared plumbing (boot, cel builders, a deterministic
PRNG so the storm picks are reproducible, and the timing/stats helpers).

## Notes / caveats

- **deep-chain caps at N=10k.** Its build and structural cost are
  super-linear in chain depth (design hazard #1: full-graph precompute +
  topoLevels per structural edit). N=100k did not settle in a reasonable
  wall/memory budget, so the runner skips it and records the reason.
- **wide-flat's single SUM does not survive 100k.** One `(+ …)` formula
  with 100k operands traps `RuntimeError: Out of memory` in the formula
  evaluator (the N-wide call's codegen blows up). The runner detects the
  CelError sink and flags it; the storm numbers at that point measure
  re-firing an errored cel, not a clean fan-in.
- diamond-mesh's sink value overflows to a large float (Pascal-triangle
  growth) — expected; this is a recompute bench, not a numeric one.
