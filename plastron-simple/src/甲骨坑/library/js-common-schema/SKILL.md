---
name: js-common-schema
description: SchemaCels for common JS runtime types (string, number, boolean, bigint, null, array, object, date, map, set, regexp, uint8array) with hydrate/dehydrate protocols.
---

## Cels provided

- `string` / `number` / `boolean` / `bigint` / `null` / `array` / `object` / `date` / `map` / `set` / `regexp` / `uint8array` — the SchemaCels.
- `<type>_isChanged` / `<type>_hydrate` / `<type>_dehydrate` — per-type protocol fns.

## Usage

Boot-installed via its loader (not named in 冊.json's dependency lists). Cels reference a schema
by key to get memo-safe equality and round-trippable dehydration.
