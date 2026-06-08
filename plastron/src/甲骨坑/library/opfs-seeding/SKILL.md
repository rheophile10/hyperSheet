---
name: opfs-seeding
description: seedStore(state) populates the segment-store under plastron/ from the in-memory boot segments (kernel closure), idempotently.
---

## Cels provided

- `seedStore` — host-called op that seeds the store from boot segments.

## Usage

`resolveFn(state, "seedStore")(state)` after `createInitialState` (NOT auto-fired at boot, to keep
transient/test States off disk). Writes via `store.putRaw` so it can seed role:kernel segments.
