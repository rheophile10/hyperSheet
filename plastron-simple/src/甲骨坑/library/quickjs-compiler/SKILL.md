---
name: quickjs-compiler
description: The 'quickjs' compiler cel — JS source → Fn via QuickJS-emscripten (JS-in-wasm sandbox). Lazy-loaded on first compile; main-thread in v1.
---

## Cels provided

- `quickjs` — the compiler cel.
- `load-deps.quickjs` — dependency loader.
- `quickjs.ready` / `quickjs.alive` / `quickjs.errors` — readiness/health cels.
- `quickjs-to-js` / `js-to-quickjs` — bridge cels.

## Usage

Any `EditableLambdaCel` with `metadata.kind: "quickjs"` compiles through this. Sandboxed
substitute for Javy with the same QuickJS interpreter.
