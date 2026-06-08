# defn — named function definitions

Binder formulas define functions by name from the formula surface:

```
A1:  (x) => x * 100
B1:  =QUICKJS(A1, "times100")        infix (sheets)
     (quickjs src "times100")         S-expression
C1:  =times100(41)                    → 4100
```

The binder's VALUE is the request `{defn, name, source, kind,
overwrite, origin}`; its envelope declares `channel: ["defn.commit"]`,
and this segment's drain commits the definition:
`EditableLambdaCel` named `name`, in the binder's segment, with
`metadata.definedBy` (the binder cel) and `metadata.origin` (the source
cel) stamped.

## Lifecycle rules (ownership = definedBy)

- Redefining your own name: silent replace; consumers recompile via
  defGeneration staleness.
- Rename (binder's name argument changes): the old name is retired in
  the same drain.
- Foreign name: refused with a CelError on the binder cell; pass a
  trailing `TRUE` to take ownership.
- **Binders are authoritative**: any definedBy-stamped lambda whose
  name has no live binder is retired by the post-commit sweep — no
  orphans from renames or deleted binder cells. Callers of a retired
  name get `"<name>" is not a function (undefined symbol)` on next
  fire.

Drain explicitly: `resolveFn(state, "drain")(state, "defn.commit")`
(sheet.commit-cell does this automatically) or write with
`{ flush: "all" }`.
