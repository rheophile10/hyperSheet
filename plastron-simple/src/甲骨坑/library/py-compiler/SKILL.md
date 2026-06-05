---
name: py-compiler
description: The 'py' compiler cel — Python source → Fn via Pyodide. Plus py↔js bridges. Pyodide dynamic-imported on first compile; main-thread or worker mode.
---

## Cels provided

- `py` — the compiler cel.
- `load-deps.py` — dependency loader.
- `py.ready` / `py.alive` / `py.errors` — readiness/health cels.
- `py.worker-mode` — toggles main-thread vs worker execution.
- `py-to-js` / `js-to-py` — bridge cels (Pyodide's built-in conversion).

## Usage

Any `EditableLambdaCel` with `metadata.kind: "py"` compiles through this. Worker mode runs
`utils/py-worker.ts` inside a WHATWG Worker (URL resolved at runtime as `./utils/py-worker.js`).
