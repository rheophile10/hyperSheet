# plastron scale benches — results

Gate benches for `kernel-hardening-and-scale` (design §1). They MEASURE the
kernel through its public API only — they do not patch `src/`. Numbers are
per-machine; re-run `bun run.mjs` for your own.

**Run:** 2026-06-10 · Bun 1.3.13 · Linux x64, 28 cores / 141 GB · in-process,
single run · kernel built from `plastron/dist` (this worktree).

The **edit-storm settle** is the gate number — per-edit time-to-settle on a
random single-leaf `setValue`. Gate targets (design §1): **< 16 ms @ 10k,
< 100 ms @ 100k.**

## Headline — edit-storm settle (ms/edit)

| shape | N | cels | settle p50 | settle p99 | settle max | gate | verdict |
|---|---:|---:|---:|---:|---:|---|---|
| wide-flat    | 10 000  | 10 001 | **1.74**   | 2.86   | 22.56  | <16ms  | ✅ pass |
| deep-chain   | 10 000  | 10 000 | **8.57**   | 26.06  | 47.84  | <16ms  | ✅ pass (p50); p99 over |
| diamond-mesh | 10 000  | 10 000 | **14.03**  | 30.66  | 57.51  | <16ms  | ⚠️ p50 just under; p99 ~2× over |
| wide-flat    | 100 000 | 100 001 | 284.18¹   | 326.28 | 333.55 | <100ms | ❌ fail (errored cel — see ¹) |
| deep-chain   | 100 000 | —       | —          | —      | —      | <100ms | ⏭️ skipped² |
| diamond-mesh | 100 000 | 99 856  | **206.72** | 351.14 | 638.13 | <100ms | ❌ fail (~2× over) |

¹ The wide-flat sink at 100k is NOT a real value — the single `(+ …)`
formula over 100 000 operands traps `RuntimeError: Out of memory` in the
formula evaluator. The settle numbers there measure re-firing an ERRORED
cel, not a clean fan-in. See "Hazards surfaced" below.

² deep-chain is capped at N=10k by the runner: its build and structural
cost are super-linear in chain depth (design hazard #1). N=100k did not
settle in a reasonable wall/memory budget.

## Full table

| shape | N | cels | build (ms) | storm p50 | storm p99 | storm max | struct+ p50 (ms) | struct− p50 (ms) | peak RSS (MB) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| wide-flat    | 10 000  | 10 001  | 215.5    | 1.74   | 2.86   | 22.56  | 52.03     | 21.04   | 153  |
| deep-chain   | 10 000  | 10 000  | 11 235.0 | 8.57   | 26.06  | 47.84  | 11 333.4  | 83.39   | 301  |
| diamond-mesh | 10 000  | 10 000  | 695.3    | 14.03  | 30.66  | 57.51  | 499.45    | 97.37   | 516  |
| wide-flat    | 100 000 | 100 001 | 1 582.2  | 284.18¹ | 326.28 | 333.55 | 584.32    | 213.58  | 935  |
| deep-chain   | 100 000 | —       | skipped² | —      | —      | —      | —         | —       | —    |
| diamond-mesh | 100 000 | 99 856  | 20 257.2 | 206.72 | 351.14 | 638.13 | 18 705.0  | 960.41  | 2 105 |

- **build** — hydrate + precompute + first `runCycle` (cold construct).
- **storm** — per-edit time-to-settle over a random single-leaf `setValue`
  storm (500 samples ≤10k cels, 200 samples ≥50k). p50/p99/max in ms.
- **struct±** — add one formula cel (`setCelBatch` + precompute) / delete one
  + precompute. The precompute-cost bench. Median of 5 rounds.

## What the gate says

- **10k passes on p50 for all three shapes** (1.7 / 8.6 / 14.0 ms). The
  16 ms budget holds at the median. But **p99 already breaches 16 ms** on
  deep-chain (26 ms) and diamond-mesh (31 ms) — the tail is over budget even
  at 10k. diamond-mesh p50 (14 ms) is close enough to the gate that the
  wavefront shape is the one to watch.
- **100k fails the 100 ms gate everywhere it runs.** diamond-mesh settles at
  207 ms p50 (≈2× over). wide-flat "settles" at 284 ms but on an errored
  cel, so it is a fail twice over.

These are exactly the failing-first numbers the design wants: the kernel does
NOT currently meet the 100k interactive budget, and the 10k tail is already
soft. The hardening work (sparse representation O1/O2, the cycle queue, memo
eviction) has its gate.

## Hazards surfaced (beyond the settle gate)

1. **A single wide formula does not scale.** One `(+ …)` over 100k operands
   traps `RuntimeError: Out of memory` in the formula evaluator — the N-wide
   call's codegen blows up. The fan-in pattern needs either a chunked
   partial-sum tree or a range/aggregate builtin to survive 100k. (The
   wide-flat shape as written — one literal SUM — is therefore a hazard
   probe at 100k, not a clean fan-in measurement.)

2. **Structural edits on a deep/large graph are catastrophic** (design
   hazard #1: full-graph precompute + topoLevels per structural edit). Adding
   ONE cel costs:
   - deep-chain 10k: **11.3 s** (≈ the full cold build — the structural edit
     re-runs the entire precompute).
   - diamond-mesh 100k: **18.7 s**.
   This is the precompute-cost bench doing its job: it pins the O1/O2 sparse-
   representation work. Until that lands, a structural edit on a large sheet
   is not interactive.

3. **deep-chain build is super-linear in depth.** 11.2 s to build a 10k-deep
   chain; 100k did not finish in a reasonable budget (skipped). Cascade
   `buildDownstream` recursion + per-edit topo over the full chain.

## 1M — not attempted

1M was not run:

- **wide-flat** already OOMs the single formula at 100k; 1M is strictly worse.
- **diamond-mesh** at 100k peaks at ~2.1 GB RSS with a 20 s build and ~19 s
  structural edits; a 1000×1000 (1M-cel) grid extrapolates to tens of GB and
  many-minute builds — well past "reasonable time/memory."
- **deep-chain** is already capped at 10k.

Re-attempt 1M (at least for diamond-mesh) once the O1/O2 sparse precompute
lands and the build/structural cost drops.

## Reproduce

```sh
cd ../../plastron && bun run build
cd ../bench/scale
bun run.mjs                 # 10k + 100k (this run)
bun run.mjs 1000            # quick smoke
```

## After topoLevels O(V+E) fix (2026-06-10, commit 837530d)

The per-wave topo leveling was O(V·depth) (O(V²) for a chain) — the structural-
edit / build killer. Replaced with O(V+E) Kahn's. Same machine, N=10k:

| shape | build before→after | struct-edit before→after |
|---|---|---|
| wide-flat   | 218ms → 219ms (depth=1, already linear) | 51ms → 50ms |
| deep-chain  | 11537ms → **364ms** (32×) | 11377ms → **204ms** (56×) |
| diamond-mesh| 648ms → 409ms | 485ms → 251ms |

The edit-storm (cascade) numbers are unchanged — that path doesn't touch
precompute. The remaining per-edit cost is the O(N) full precompute rebuild
(~2.5s @100k diamond struct-edit) — the O2 incremental-precompute target.
deep-chain's static N=10k cap can be lifted now that it's no longer super-linear.
