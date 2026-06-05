---
name: csp
description: Runtime CSP capability probes (eval, wasm) surfaced as locked cels.
---

## Cels provided

- `csp.eval-available` — true when `new Function`/`eval` is permitted by the page's CSP.
- `csp.wasm-available` — true when `WebAssembly.instantiate` is permitted.

## Usage

Compiler segments gate on these (js-compiler on eval, wat/wasm/py/quickjs on wasm). Read with
`getCel(state, "csp.eval-available")`. Keys exported as `CSP_EVAL_AVAILABLE_KEY` /
`CSP_WASM_AVAILABLE_KEY` from this segment's `index.ts`.
