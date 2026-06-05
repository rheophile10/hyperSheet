---
name: web-editor
description: A live HTML/formula editor application — edit a template + its cels and see the rendered render-spec update. Ships counter and weather examples.
---

## Cels provided

No 冊 manifest and no eager loader — the application segment is generated at runtime by the
`buildWebEditor` factory.

## Usage

`buildWebEditor(...)`, `installWebEditorActions(state, ...)`, and the `COUNTER_EXAMPLE` /
`WEATHER_EXAMPLE` seed strings are re-exported from the package root. The host hydrates the
generated segment and renders through plastron-dom.
