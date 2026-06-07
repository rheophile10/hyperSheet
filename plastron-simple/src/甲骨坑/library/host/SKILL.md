---
name: host
description: Host-capability cells — console.log/warn/error, now, random. Apps replace _fn entries to gate or sandbox capabilities at install time.
---

## Cels provided

- `host.log` / `host.warn` / `host.error` — console sinks.
- `host.now` — current time.
- `host.random` — RNG.

## Usage

Read by each kind segment's compiler layer (wat as wasm imports; py via Pyodide globals).
`readHostImports` is exported from `index.ts` for compilers that wire these as wasm imports.
Apps swap implementations via `setCel` to sandbox capabilities.

## host.imports (segment-isolation class B)

`resolveFn(state, "host.imports")(state)` returns the capability
namespace `{ log, warn, error, now, random }` as one record — what the
wasm/py/quickjs compilers hand to foreign runtimes. Missing capability
cels fall back to safe defaults. Never import `readHostImports`; the
cel IS the API, and the dependency stays visible to segmentAdjacency.
