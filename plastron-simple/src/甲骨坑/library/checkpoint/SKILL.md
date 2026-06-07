# checkpoint — snapshots you can restore

structure edits (genesis, binders) are powerful and mistakes are by
design recoverable:

- `=checkpoint("before-mess")` — a formula whose drain snapshots the
  whole user-space into a ring (20 deep). cheap: snapshots ride
  dehydrate, and generated bulk regenerates on restore.
- restore is DISPATCHED, never a formula:
  `resolveFn(state, "checkpoint.restore")(state, "before-mess")` —
  wipes non-kernel cels, rehydrates the snapshot, recomputes.
- `checkpoint.delta(state, "a", "b"?)` — {added, removed, changed}
  keys; the review-gate's diff food (agent-bridge).
- `checkpoint.list(state)` — names in ring order.
