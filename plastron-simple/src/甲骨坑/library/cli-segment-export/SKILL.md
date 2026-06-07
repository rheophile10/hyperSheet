---
name: cli-segment-export
description: CLI-only. exportToDir / importFromDir copy the plastron/ store (a segment + transitive deps, kernel-closure excluded) to/from a disk directory.
---

## Cels provided

- `exportToDir` — copy store contents to a chosen directory.
- `importFromDir` — bring them back via segment-store.put.

## Usage

Cels install only when `file-store.backend === 'node-fs'` (empty in browser builds). v1: dir format
only. See docs/4-current/09-storage/03-cli-segment-export.md.

## Gate moved to call time (segment-isolation class C)

Cels now ALWAYS install (uniform dispatch surface); `exportToDir` /
`importFromDir` throw unless the live `file-store.backend` cel is
"node-fs". Layout + store access via cels: `store.root`,
`store.readIndex`, `store.putRaw`, `file-store.root`.
