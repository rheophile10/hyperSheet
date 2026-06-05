---
name: segment-archive
description: Tiered + whole-workspace segment export/import as a role-foldered .zip (the .甲 archive). Built over dehydrate/hydrate + a zero-dependency zip core.
---

## Cels provided

- `segment-archive.export-all` / `.export-application` / `.export-library` / `.export-user` — export to Uint8Array.
- `segment-archive.import` — import a Uint8Array (opts.onlyRoles?).

## Usage

The kernel closure is always excluded (ships in the bundle, resolves on import). Layout:
applications/ libraries/ user/ folders of `<name>@<version>/{manifest,segment}.json` plus
plastron.index.json. `buildArchive` / `loadArchive` / `zipBytes` / `unzipBytes` exported from
`index.ts`. Host wires the sink/source. See docs/1-design/2-in-evaluation/segment-archive.md.
