---
name: wat-compiler
description: The 'wat' compiler cel — WebAssembly text source → Fn via wabt.js. Gated on csp.wasm-available; wabt.js dynamic-imported on first compile.
---

## Cels provided

- `wat` — the compiler cel.
- `load-deps.wat` — dependency loader.
- `wat.ready` / `wat.alive` / `wat.errors` — readiness/health cels.
- `wat-to-js` / `js-to-wat` / `wasm-to-wat` — bridge cels.

## Usage

Any `EditableLambdaCel` with `metadata.kind: "wat"` compiles through this. Host imports default
to `{ host }`.

Seeded as a `CompilerCel` (the compiler fn lives on `v`), which also makes it a
**binder head**: `=WAT(A1, "name")` in a sheet / `(wat src "name")` in S-expr
defines a named function from the referenced source (see the `defn` segment).
