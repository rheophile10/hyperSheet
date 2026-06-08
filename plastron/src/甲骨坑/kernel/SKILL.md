---
name: kernel
description: The kernel segment — IO, lifecycle, and segment-registry cels every host calls. Always present; cannot be lazy.
---

## Cels provided

- `getCel` / `setValue` / `setValueBatch` / `setCel` / `setCelBatch` — read and write cels.
- `touch` / `consume` / `drain` — channel signalling.
- `clearErrors` — clear the errors log.
- `f` — default S-expression formula compiler (unlocked; swap to change formula language).
- `runCycle` / `hydrate` / `dehydrate` / `flush` — the lifecycle ops.
- `getSegmentManifest` / `listSegments` / `findDependents` — segment registry reads.
- `registerSegmentLoader` / `loadSegment` / `ensureSegments` / `isSegmentPending` — lazy-segment dispatch.
- `cel-error` — the SchemaCel for the trap-as-value error shape.
- `cel-error_isChanged` / `cel-error_hydrate` / `cel-error_dehydrate` — its protocol fns.

## Error schema (trap-as-value)

When a fireable cel's evaluator throws (formula compile error, wasm trap, JS exception, runtime
panic, …) the kernel catches and replaces the would-be `cel.v` with a tagged error value:

```
{ kind: "error", at: Key[], trap: string, message: string, stack?: string }
```

Downstream cels see it like any other value. `isCelError(value)` / `makeCelError(...)` are
re-exported from the package root. Kernel modules (runCycle, precompute, hydrate) import
`appendError` / `makeCelError` from `src/kernel/cel-error.ts` (the machinery) to record traps;
the SchemaCel + its three protocol fns are seeded here in the kernel segment
(the cel-error cels in `甲骨.json` + their bindings in the one `bindNativeFns` call in
`index.ts`). Cels that hold CelError
values attach this schema (`cel.schema = state.cels.get("cel-error").v`) so dehydrate calls
`cel-error_dehydrate` and runCycle's diff calls `cel-error_isChanged`. The `errors` log
(segment `"kernel"`) accumulates every trap and is excluded from dehydrate — errors don't
persist across boots.

## Usage

`resolveFn(state, "<key>")` returns the fn for any of these (e.g. `runCycle`, `set`, `hydrate`).
The kernel role admits exactly one segment by rule, so `甲骨坑/kernel/` is FLAT — it IS the
kernel segment folder (`index.ts`, `甲骨.json`, `SKILL.md`). `index.ts` binds every native fn
over the one merged `甲骨.json` (IO + lifecycle + segment-registry + cel-error, in that order)
through a single `bindNativeFns` call, then leads with the internal builder cels — the mutable
per-State containers (precomputedStates / compile.cache / errors / segment.loaders /
segment.bundled-loaders), built in code rather than data. `bindNativeFns` (the helper every
segment binds its native fns through) lives at `src/kernel/native-fn.ts`, reached via the
src-kernel barrel.
