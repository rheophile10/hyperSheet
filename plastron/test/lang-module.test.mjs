import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";
import { moduleNames, moduleGenesis } from "../dist/甲骨坑/library/lang-module/index.js";

// lang-module — Model B: a source file → one function-cel per public def.
// (polyglot-language-segments.md). Parsing is language-aware; the emitted JS cels
// are verified to actually compile + run through quickjs (offline; py/php same
// convention but their runtimes aren't bundled here).

test("moduleNames parses public top-level defs per language, skipping _private", () => {
  const js = "function _hav(t){return t}\nfunction haversine(a,b){return a+b}\nconst bearing = (a,b) => a-b\n";
  assert.deepEqual(moduleNames(js, "js"), ["haversine", "bearing"], "js: fns + consts, no _hav");

  const py = "def _mean(xs): pass\ndef summary(xs):\n    return _mean(xs)\ndef variance(xs): pass\n";
  assert.deepEqual(moduleNames(py, "py"), ["summary", "variance"], "py: top-level defs, no _mean/nested");

  const php = "function _util($x){}\nfunction area($r){ return 3.14*$r*$r; }\n";
  assert.deepEqual(moduleNames(php, "php"), ["area"], "php: user fns, no _util");
});

test("moduleGenesis emits one owned cel per public def (f = source + name)", () => {
  const src = "function haversine(a,b){return a+b}\nfunction bearing(a,b){return a-b}";
  const g = moduleGenesis("geo", src, "js");
  assert.equal(g.genesis, true);
  assert.equal(g.layer, "geo");
  assert.deepEqual(Object.keys(g.cels).sort(), ["geo.bearing", "geo.haversine"]);
  assert.equal(g.cels["geo.haversine"].metadata.kind, "js");
  assert.equal(g.cels["geo.haversine"].metadata.generatedBy, "geo.__module", "owned by the generator (regeneration sweeps)");
  assert.match(g.cels["geo.haversine"].f, /haversine$/, "trailing callable = the function name");
});

test("the emitted JS function cels actually compile and run (quickjs)", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["js-compiler"]);
  await resolveFn(state, "hydrate")(state, [], []);
  await precomputeOptional(state);

  const src = "function _k(){return 100}\nfunction add(a,b){return a+b}\nfunction scaled(x){return x*_k()}";
  const g = moduleGenesis("m", src, "js");
  const setCel = resolveFn(state, "setCel");
  for (const [k, spec] of Object.entries(g.cels)) await setCel(state, k, spec);
  await resolveFn(state, "runCycle")(state);

  const add = resolveFn(state, "m.add");
  const scaled = resolveFn(state, "m.scaled");
  assert.equal(typeof add, "function", "m.add is callable");
  assert.equal(await add(2, 3), 5, "m.add runs");
  assert.equal(await scaled(2), 200, "m.scaled calls the PRIVATE _k inside the runtime (off-graph)");
  assert.equal(resolveFn(state, "m._k"), undefined, "_k was NOT promoted to a cel (private)");
});
