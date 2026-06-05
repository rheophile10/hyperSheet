---
name: html-template-parser
description: View layer. html-template (inline) and html-template-ref (live-editable) FormulaCel parsers → render-spec ({vnode, mount, listeners}). Owns the vnode types.
---

## Cels provided

- `html-template` / `html-template-ref` — the template-parser FormulaCels.
- `vnode` / `render-spec` / `string-list` — memoSafe SchemaCels.
- `vnode_isChanged` / `render-spec_isChanged` / `string-list_isChanged` — protocol fns.

## Usage

Interpolation bodies (`{{…}}`) are the kernel's S-expression formula language. `index.ts` owns and
re-exports the vnode/render-spec types (`VNode`, `RenderSpec`, `text`, `vnodeEquals`, …) — sibling
segments (plastron-dom) reach them through this barrel, not into `utils/vnode.ts`.
