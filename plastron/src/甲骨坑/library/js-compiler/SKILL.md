---
name: js-compiler
description: The 'js' compiler cel — `new Function`-backed JS source → Fn. Gated on csp.eval-available.
---

## Cels provided

- `js` — the compiler cel (kind dispatch surface).
- `load-deps.js` — dependency loader.
- `js.ready` / `js.alive` / `js.errors` — readiness/health cels.

## Usage

Any `EditableLambdaCel` with `metadata.kind: "js"` compiles through this. Errors clean if
`csp.eval-available` is false.

Seeded as a `CompilerCel` (the compiler fn lives on `v`), which also makes it a
**binder head**: `=JS(A1, "name")` in a sheet / `(js src "name")` in S-expr
defines a named function from the referenced source (see the `defn` segment).
