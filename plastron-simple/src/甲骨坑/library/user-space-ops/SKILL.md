---
name: user-space-ops
description: User-space lifecycle ops as locked native cels — new / save / load / close, plus the shared hydrate-closure helper.
---

## Cels provided

- `newUserSpace` / `saveUserSpace` / `loadUserSpace` / `closeUserSpace` — lifecycle ops.
- `hydrate-closure` — BFS the segment-store from a root, topo-order the not-yet-loaded transitive closure, hydrate in one call (idempotent).

## Usage

`resolveFn(state, "loadUserSpace")(...)`. save persists only the user-space's PRIVATE closure;
load auto-starts the parent application; close flushes root-first without evicting shared
libraries. See docs/1-design/3-accepted/02-hydration/session-segments.md.
