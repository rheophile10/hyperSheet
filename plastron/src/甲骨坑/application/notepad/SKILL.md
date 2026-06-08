---
name: notepad
description: The simplest non-spreadsheet application — a <textarea> bound to a text cel, rendered through html-template + plastron-dom. "An application is just cels + a view."
---

## Cels provided

No 冊 manifest and no eager loader — the application segment (text / mount / path / binding
ValueCels + the view FormulaCel) is generated at runtime by the `buildNotepad` factory.

## Usage

`buildNotepad(...)` and `installNotepadActions(state, ...)` are re-exported from the package root.
The host hydrates the generated segment. Editing needs zero custom code (the textarea's onInput
routes through the shipped `{ set, extract }` event binding); only persistence needs host-injected
native fns.
