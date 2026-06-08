---
name: wasm-types
description: SchemaCels for the WIT primitive types (wasm:bool, wasm:i32 … wasm:string) marking cels as living in a wasm domain.
---

## Cels provided

- `wasm:bool` / `wasm:i32` / `wasm:u32` / `wasm:i64` / `wasm:u64` / `wasm:f32` / `wasm:f64` / `wasm:char` / `wasm:string` / `wasm:opaque` — the WIT primitive SchemaCels.
- `wasm-scalar_*` / `wasm-bigint_*` — isChanged / hydrate / dehydrate protocol fns.

## Usage

The discriminator `kind:'wasm'` marks cels as living in a wasm domain; bridge cels and per-kind
precompute layers dispatch on it. `isWitPrimitive` is the runtime predicate (re-exported from the
package root).
