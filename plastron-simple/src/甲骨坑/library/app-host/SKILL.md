---
name: app-host
description: plastron-OS launcher mechanism (rendering-agnostic). Composed over user-space-ops; the desktop application renders this state.
---

## Cels provided

- `os.active` / `os.apps` / `os.doc` — launcher state cels.
- `os.launch` / `os.switch` / `os.exit` / `os.register-app` — native ops.

## Usage

`os.launch` with a docName ensures the document's user-space is loaded; without one it just
activates. The kernel stays the headless substrate. See
docs/1-design/1-under-consideration/plastron-os.md.
