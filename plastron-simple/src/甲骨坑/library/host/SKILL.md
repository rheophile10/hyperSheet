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
