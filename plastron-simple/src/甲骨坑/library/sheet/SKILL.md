---
name: sheet
description: Spreadsheet machinery. The infix FormulaCel parser (Excel-style =A1*2; SUM/MIN/MAX/AVG/IF, ranges; user-symbol calls; compiler binders) plus commit/cancel/move/start-edit action cels.
---

## Cels provided

- `infix` — the Excel-style formula parser (A1 refs resolve to sibling `sheet.<addr>` keys, auto-wired into inputMap).
- `sheet.commit-cell` / `sheet.cancel-edit` / `sheet.move-selection` / `sheet.start-edit` — the action cels.

## Formula language

- Builtins (case-insensitive): `SUM MIN MAX AVG AVERAGE IF`, ranges, `&` concat.
- **User symbols** (case-sensitive, = cel keys): `=times100(41)` dispatches the
  cel named `times100` — a lambda cel contributes its callable, a FormulaCel its
  computed value (so an unnamed compiler cell is callable through a ref). An
  unbound name traps with `"<name>" is not a function (undefined symbol)`.
- **Binder form** — `=JS(A1, "times100")` (head = a CompilerCel key: js,
  quickjs, wat, py; optional trailing `TRUE` = overwrite a name owned by
  another binder). The cell's value is a definition request; the `defn`
  segment's drain commits it as a named EditableLambdaCel. `sheet.commit-cell`
  drains `defn.commit` itself, so the function exists before the next commit.
  Lifetime is binder-bound: rename or remove the binder and the old name is
  retired in the same drain (see the defn segment's SKILL).

## Usage

The per-sheet data layer (N×M grid + selection/editing/formula-bar/dims control cels) is generated
by `buildSheet` (re-exported from the package root) and hydrated by the host; grids declare
`defn` as a manifest dependency (the binder gesture is structural). See
docs/3-test-design/05-runCycle/spreadsheet-segment.md and
docs/1-design/3-accepted/00-ontology/named-function-cels.md.
