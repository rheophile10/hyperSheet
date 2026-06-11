---
title: Async runCycle re-entrancy race — reproduction + cycle-queue fix
status: under-consideration
area: runCycle
---

# Async runCycle re-entrancy race (kernel task #16)

## Outcome: REPRODUCED, then FIXED

The race is real and deterministically reproducible. A minimal cycle queue
(one cascade at a time; re-entrant triggers enqueue) eliminates it with no
measurable cost to the value-update path.

- Failing test: `test/cycle-reentrancy.test.mjs`
- Fix: `src/kernel/卜/runCycle.ts` (the `runCascade` wrapper + `runCascadeInner`)

## The hazard

`runCascadeInner` does `await Promise.all(promises)` for ASYNC cels. That await
is the *only* place the single-threaded event loop can yield to a re-entrant
trigger — a timer or event (a `setTimeout`, a Pyodide/Javy round-trip
completing, a DOM event handler) firing mid-cascade and calling
`setValue`/`setCel` on the SAME state. Before this fix the kernel offered no
ordering guarantee between the in-flight cascade and the re-entrant one, so two
concrete corruptions were possible:

1. **Lost update (stale overwrite).** An async cel snapshots its inputs BEFORE
   awaiting (exactly what a real async lambda does: read inputs, hand them to a
   runtime, await the result). If a re-entrant write changes those inputs and
   its cascade commits the *fresh* value first, the original cascade's await
   then resolves with the *stale* snapshot and `finishFireSync` writes it on
   top — the cel is left holding an outdated value while its siblings reflect
   the new one.
2. **Index swap mid-walk.** The re-entrant write calls `precompute(state)`,
   which replaces the `PrecomputedIndexes` object the outer `runCascadeInner`
   is still iterating (`sortedWaves` / `waveCascade`). The outer walk can then
   traverse a half-rebuilt order.

## Reproduction (deterministic, no real timers)

Topology: `a` (ValueCel) → `slowB` (async lambda; snapshots `a`, then awaits) and
`fastC` (`(+ a 0)`, sync).

1. `setValue(a, 1)` — outer cascade fires `slowB` (snapshots `a=1`, parks on an
   await) and commits `fastC = 1`.
2. While `slowB` is parked, a re-entrant `setValue(a, 2)` fires (a timer firing
   mid-cascade).
3. Async resolution is ordered so the STALE snapshot (`a=1`) resolves LAST. The
   gate is a microtask-count delay (`snapshot === 1 ? 8 : 0` turns), so the
   interleave is fully deterministic — no wall-clock timers.

Without the fix the final state is `a=2`, `fastC=2`, **`slowB=1`** — an
internally inconsistent graph (the consistency invariant `slowB.v === fastC.v
=== a.v` is violated). This is the worst-case interleave a real timer can
produce; the test asserts the invariant and fails on the stale value.

## The fix — a cycle queue

`runCascade` is split:

- `runCascadeInner` — the original cascade body (unchanged logic, including the
  recompiled-stale follow-up, which recurses into `runCascadeInner` because it
  is a continuation of the *current* cascade and must run inline, never enqueue
  behind itself).
- `runCascade` — a thin serializing wrapper. A per-`State` guard
  (`WeakMap<State, { running, queue }>`, mirroring the `_settling`
  structural-settle guard's shape) ensures **one cascade at a time**. A
  re-entrant call ENQUEUES its `(affected, changed)` request and returns a
  promise that settles once a follow-up pass drains it. The running cascade,
  after `runCascadeInner` returns, drains the queue one pass at a time. Each
  drained pass re-reads current cel values, so an enqueued request re-fires
  from the LATEST state — `slowB` recomputes from `a=2` and commits 2 last.

The guard lives entirely in `runCycle.ts` (the WeakMap keeps it off the `State`
type). Termination: the drain loop only processes already-enqueued requests;
the recompiled follow-up restamps `_compiledGen` so it cannot re-enter.

## Cost — value-update path is unchanged

For the synchronous (no async cel) edit storm — the hot path — the guard adds
only a WeakMap lookup and one closure allocation per top-level cascade; the
inner cascade work is byte-identical. Interleaved before/after p50 on an
edit-storm micro-bench (`setValue(root)` × 400, N=1000 cels, after warmup):

| shape   | baseline p50 | guarded p50 |
|---------|-------------:|------------:|
| wide    | ~0.47 ms     | ~0.47 ms    |
| deep    | ~0.49 ms     | ~0.48 ms    |
| diamond | ~0.59 ms     | ~0.58 ms    |

Differences are within run-to-run noise (guarded is sometimes faster). The
sheets edit bench reports identical fire counts (M: 4700, L: 20700),
confirming the cascade does exactly the same work. Full `bun test` stays green
(552 pass, 0 fail — 551 baseline + the new repro test).

> Note on the prompt's quoted bench: `bench/scale/` does not exist on this
> branch, and `bench/src/cascade-shape.ts` is stale (imports a `core/`
> precompute path that no longer exists, `tsx` not installed). The numbers
> above come from a self-contained edit-storm micro-bench measuring the exact
> value-update path the guard wraps; the load-bearing claim — *guard vs no
> guard on the same harness is flat* — holds.
