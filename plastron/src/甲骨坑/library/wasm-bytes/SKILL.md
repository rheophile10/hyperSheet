---
name: wasm-bytes
description: The 'wasm' loader cel — precompiled .wasm bytes + WIT descriptor → Fn. Imports any language compiled to wasm (Rust/C/Zig). Gated on csp.wasm-available.
---

## Cels provided

- `wasm` — the loader cel (bytes base64-inline or `file-store:<path>` reference).
- `load-deps.wasm` — dependency loader.
- `wasm.ready` / `wasm.alive` / `wasm.errors` — readiness/health cels.
- `wasm-to-js` / `js-to-wasm` — bridge cels.

## Usage

`metadata.wasmExport` chooses the export; `metadata.imports` names a provider cel for WASI/env
shims. See docs/4-current/07-wasm/11-wasm-bytes-kind.md.
