---
name: sheet
description: Spreadsheet machinery. The infix FormulaCel parser (Excel-style =A1*2; SUM/MIN/MAX/AVG/IF, ranges) plus commit/cancel/move/start-edit action cels.
---

## Cels provided

- `infix` — the Excel-style formula parser (A1 refs resolve to sibling `sheet.<addr>` keys, auto-wired into inputMap).
- `sheet.commit-cell` / `sheet.cancel-edit` / `sheet.move-selection` / `sheet.start-edit` — the action cels.

## Usage

The per-sheet data layer (N×M grid + selection/editing/formula-bar/dims control cels) is generated
by `buildSheet` (re-exported from the package root) and hydrated by the host. See
docs/3-test-design/05-runCycle/spreadsheet-segment.md.
