---
name: builtins
description: Arithmetic operators (+ - * /) and range helpers as LockedLambdaCels. Flushable; formulas referencing them error cleanly when removed.
---

## Cels provided

- `+` / `-` / `*` / `/` — variadic arithmetic operators.
- `parseRange` — range notation string → Range struct.
- `rangeToKeys` — Range (struct or notation) → row-major member cel keys.

## Usage

Reached from S-expression formulas: `(* price qty)`, `(rangeToKeys "grid!A1:B3")`. Lives at the
bottom of the DAG — read by everything.
