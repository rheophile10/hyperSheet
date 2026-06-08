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

## Fragment slots + comparator cels (vnode-valuecel-collapse)

- `{{(cel "some.view")}}` in a template is a FRAGMENT SLOT: it wires an
  inputMap dep on that view cel and splices its RenderSpec's `.vnode`
  by reference — zero work and an O(1) diff skip when the fragment
  didn't fire.
- `vnode.equals` / `vnode.bindings-equal` cels expose the node-level
  comparators; painters resolve them once per drain (plastron-dom does).
- The render-spec schema's `isChanged` (`render-spec_isChanged`) is a
  BUDGETED deep changed-predicate (64 nodes): fragment-sized trees get
  full suppression with old-reference preservation (memoSafe); larger
  trees bail as "changed" and rely on the paint diff.
- The VNode/RenderSpec TYPES are platform (`src/types/vnode.ts`).
