---
name: segment-store
description: Persistent storage for dehydrated segments under plastron/segments/<name>/<version>/ with a plastron/index.json lookup. Composed over file-store's fs.*.
---

## Cels provided

- `store.put` / `store.get` / `store.list` / `store.delete` / `store.has` — the async store ops.

## Usage

`resolveFn(state, "store.put")(...)`. `putRaw`, `readIndex`, `STORE_ROOT` are exported from
`index.ts` for opfs-seeding / cli-segment-export. Index-last + tmp-rename atomicity; uncompressed
JSON v1. See docs/4-current/09-storage/02-segment-store.md.
