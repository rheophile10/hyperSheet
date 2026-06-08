---
name: file-store
description: Pathlib-shaped fs.* fns over OPFS (browser) and node:fs/promises (CLI). One backend chosen sync at module load; module-singleton dispatch.
---

## Cels provided

- `file-store.opfs-available` / `file-store.node-fs-available` / `file-store.backend` / `file-store.root` — backend descriptor cels (read-only in Phase A).
- `fs.exists` / `fs.read` / `fs.readText` / `fs.write` / `fs.writeText` / `fs.delete` / `fs.mkdir` / `fs.rmdir` / `fs.list` / `fs.stat` / `fs.rename` — the fs ops.
- `file-binary` / `file-binary_size` / `file-binary_isChanged` / `file-binary_mime` — the file-binary SchemaCel + protocols.

## Usage

`resolveFn(state, "fs.read")(path)`. `fsOps`, `backend`, `root` are exported from `index.ts` for
segments built over it (segment-store, wasm-bytes). See docs/4-current/09-storage/01-file-store.md.
