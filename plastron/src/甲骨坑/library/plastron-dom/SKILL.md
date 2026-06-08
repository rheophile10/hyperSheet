---
name: plastron-dom
description: Painter. RAF-batched paint ChannelCel, pure diffVNodes (vnode → JSON Patch, keyed reconciliation), applyPatch (browser-gated DOM mutation), listener reconciliation.
---

## Cels provided

- `plastron-dom.paint` / `plastron-dom.paint.drain` — the RAF-batched painter ChannelCel + drain.
- `plastron-dom.diffVNodes` — vnode → JSON Patch.
- `plastron-dom.applyPatch` — DOM mutation (browser-gated, document-injectable).
- `plastron-dom.applyListenerDelta` — global-listener reconciliation.
- `patch` — the patch SchemaCel.

## Usage

`createPainter` / `getPainter` / `setPainter` (re-exported from the package root) wire a per-state
painter. Consumes vnode/render-spec types from `../html-template-parser/index.js`. Off-browser the
patch is produced and observable but DOM mutation is skipped.

## Comparators are injected, not imported (segment-isolation class D)

`diffVNodes(prev, next, eq)` takes a `DiffEq` — the painter resolves
`vnode.equals` / `vnode.bindings-equal` once per drain and threads them
in. VNode types come from `src/types/vnode.ts`. This segment has zero
sibling imports.
