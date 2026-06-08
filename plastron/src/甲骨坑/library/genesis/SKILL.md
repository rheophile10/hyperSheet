# genesis — structure-producing formulas

a formula whose value is `{ genesis: true, cels: { key: spec, ... } }`
CREATES all those cels when its channel drains. mark vocabulary heads
with `metadata.genesis: true` and both parsers attach the channel
automatically (`=grid(3,3)` / `(grid 3 3)`).

rules:
- every committed cel is stamped `generatedBy` = the generator's key.
  generators are authoritative: re-fire diffs (removed specs retire,
  unchanged specs untouched), delete the formula and the whole bloom
  is swept away.
- spec `v`/`f` are SEEDS — applied at creation; the user's edits to a
  generated cel's data plane survive regeneration (pass `reset: true`
  on a spec to force re-seeding).
- view-shaped specs (html-template parser / render-spec schema) treat
  `f` as STRUCTURE (template change = regeneration); plain formulas
  treat `f` as content. override per spec with `fStructural`.
- `layer: "name"` lands the bloom in a named segment (the share/save
  unit); default is the generator's segment.
- foreign keys are refused (one aggregated error on the generator);
  `overwrite: true` takes ownership.

drain explicitly with `resolveFn(state, "drain")(state, "genesis.commit")`
or write with `{ flush: "all" }`.
