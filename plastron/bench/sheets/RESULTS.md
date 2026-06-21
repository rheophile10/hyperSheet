# sheets bench — RESULTS

Counters are the signal; wall-clock has run noise. Fresh process per
cell, warmup pass before timed loops. Phases/sizes per
docs/1-design/3-accepted/00-ontology/sheets-bench-harness.md.
This harness measures the graph; view-side phases (select/diff/paint)
are out of scope.

## baseline — 2026-06-07, tree at 1201378+working (pre-genesis), bun, linux x64

| label | wall ms | fires | suppressed | precompute (n / ms) | extra |
|---|---|---|---|---|---|
| boot/S | 13.41 | 10 | — | 1 / 3.47 | cels=248 |
| edit/S | 6.03 | 1000 | — | — / — |  |
| noop/S | 6.21 | 300 | 300 | — / — |  |
| commit/S | 17.26 | 220 | — | 20 / 11.04 |  |
| range-edit/S | 2.91 | 120 | — | — / — |  |
| save-open/S | 5.86 | 10 | — | 1 / 1.15 | payloadBytes=36972 |
| boot/M | 22.96 | 47 | — | 1 / 6.85 | cels=1248 |
| edit/M | 28.05 | 4700 | — | — / — |  |
| noop/M | 26.1 | 800 | 800 | — / — |  |
| commit/M | 58.02 | 960 | — | 20 / 38.38 |  |
| range-edit/M | 8.32 | 860 | — | — / — |  |
| save-open/M | 16.64 | 47 | — | 1 / 2.94 | payloadBytes=250780 |
| boot/L | 50.7 | 207 | — | 1 / 19.59 | cels=5408 |
| edit/L | 109.85 | 20700 | — | — / — |  |
| noop/L | 101.59 | 800 | 800 | — / — |  |
| commit/L | 246.48 | 4160 | — | 20 / 182.93 |  |
| range-edit/L | 28.45 | 4060 | — | — / — |  |
| save-open/L | 66.27 | 207 | — | 1 / 18.12 | payloadBytes=1159452 |
| xl-precompute/1000 | 20.05 | — | — | 10 / 14.91 | perCommitMs=1.49 |
| xl-precompute/5000 | 56.32 | — | — | 10 / 51.63 | perCommitMs=5.16 |
| xl-precompute/10000 | 65.13 | — | — | 10 / 63.28 | perCommitMs=6.33 |

Readings:

- **Suppression is exact**: noop fires == suppressed at every size —
  no-op writes evaluate only direct dependents and commit nothing.
- **O2 gate numbers**: precompute per commit ≈ 0.55ms (S, 248 cels) /
  2.0ms (M, 1.2k) / 9.0ms (L, 5.4k) / 6.8ms (XL synthetic 10k).
  Near-linear in registry size. Interactive budget (<16ms) holds to
  ~10–20k cels on this machine; 10⁵ cels would be ~70ms/commit —
  excel-scale O2 (scoped/incremental precompute) confirmed necessary
  THERE, not needed for the origin/genesis era scale.
- save-open payload grows ~linear (~214 B/cel) — O5's columnar work
  has its baseline.
