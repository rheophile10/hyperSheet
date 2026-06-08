// ============================================================================
// kernel — the public surface, in the order a State lives its life.
//
//   resolveFn → hydrate → 契 (inputs) → 卜 (recalc) → dehydrate
//
// Every fn here also lives as a cel in state.cels (bound by the
// 甲骨坑/kernel segment's index.ts), so hosts normally reach them via
// resolveFn(state, key) rather than importing — these exports exist
// for the binders, for tests, and for hosts that want direct calls.
// Reserved cel keys + the PrecomputedIndexes shape live in types/state.ts.
// ============================================================================

// ── 0. dispatch ── every kernel fn is a cel; resolveFn(state, key)
// returns its _fn. This is how a host reaches everything below once
// the State exists.
export { resolveFn } from "./resolve-fn.js";

// ── runtime companions to types/ ── the guards and key parsing the
// pure-type folder can't carry.
export {
  isFireable, kindOf, isDataCel, isDefinitionCel, coordinatesFromKey,
} from "./cels.js";
export { isWitPrimitive, isWasmHandle } from "./wit.js";

// ── trap-as-value error machinery ── when a fireable cel's evaluator
// throws, the kernel stores a tagged CelError on the cel rather than
// propagating the exception. These are kernel-resident: runCycle,
// precompute, and hydrate import them directly. The cel-error SchemaCel
// + protocol fns are seeded by the kernel SEGMENT (甲骨坑/kernel).
export {
  ERRORS_LOG_KEY, isCelError, makeCelError, appendError, clearErrors,
  cel_error_isChanged, cel_error_hydrate, cel_error_dehydrate,
} from "./cel-error.js";
export type { CelError } from "./cel-error.js";

// ── native-fn binding ── bind native `_fn` implementations onto a
// segment's cel seed by key. Every 甲骨坑 segment's index.ts reaches it
// through this barrel.
export { bindNativeFns } from "./native-fn.js";

// ── 1. hydrate ── 甲骨 archive → live State. Installs cels, compiles
// fireables (async, in topo layers), resolves schemas, installs
// memo/trampolines, then ends with 卜's precompute.
export {
  hydrate, hydrate函,
  inflateCel, disposeCel, retireCel, compileCelBody, resolveSchemas,
  installCels, inflateAllCels, compileFireable, validateManifests,
  applyManifestDefaults,
  validateInputKinds, hydrateValue, applySchemaHydrate,
} from "./hydrate/index.js";
export { hydrateClosure } from "./hydrate/closure.js";

// ── 2. 契 ── two mutually exclusive write tiers + one read.
export {
  getCel,                       // the one read — live Cel, take .v
  setValue, setValueBatch,      // data plane: ValueCel.v / FormulaCel.f (recalc tier)
  setCel, setCelBatch,          // cel plane: whole-cel create/replace or metadata edit (recompile tier)
  touch, consume, drain, flushChannels,  // channels
} from "./契/index.js";

// ── 3. 卜 ── recalculation: propagate staged changes through the
// precomputed topology. precompute builds the indexes hydrate/setCel
// hand it; runCycle fires dirty cels wave by wave.
export {
  runCycle, interlinked, ilk, 連鎖, runCascade, affectedFor,
  precompute, precomputeOptional, buildPrecomputedIndexes,
  celDependencies, dependentsOf, downstreamOf, upstreamOf, dependencyCelsOf,
  bfsDownstream, bumpDefGeneration, isDefinitionStale,
  topoLevels, transitiveClosure, dependentOrderFrom,
  celAt, valueAt, valuesInRange, neighborsOf,
  compileFormula, extractDeps,
} from "./卜/index.js";

// ── 4. dehydrate ── live State → 甲骨 archive, ready for storage.
export {
  dehydrate, dehydrate函, deflateCel, dehydrateValue, collectManifests, groupCelsBySegment,
} from "./dehydrate/index.js";
export type { Dehydrate函Options } from "./dehydrate/index.js";

// ── segments ── manifest queries, lazy/dynamic loading, teardown
// (flush removes a segment's cels, drains channels, re-precomputes).
export {
  getSegmentManifest, listSegments, listSegmentNames, segmentEntries,
  setSegmentManifest, deleteSegmentManifest, hasSegment, segmentCelKeyOf,
  findDependents,
  computeKernelClosure, kernelClosureOf, segmentMap, topologicalDependentOrder,
  registerSegmentLoader, loadSegment, ensureSegments, isSegmentPending,
  assertOneDirection, specTouchesEdges,
  installDormant, dormantSegmentOf, dormantView, assertNotDormant,
  flush, wake, sleep, forget,
} from "./segments/index.js";
export type { SegmentSink, SleepOptions, ForgetOptions } from "./segments/index.js";

// ── reserved cel keys + range notation ── kernel-owned constants,
// accessors, and parsers re-exported so segment code (甲骨坑) reaches
// them through this barrel instead of deep module paths.
export { PRECOMPUTED_STATES_KEY, getPrecomputedIndexes } from "./卜/graph.js";
export { COMPILE_CACHE_KEY } from "./hydrate/formula.js";
export {
  SEGMENT_LOADERS_KEY, getSegmentLoaders,
  BUNDLED_LOADERS_KEY, getBundledLoaders, reparkBundledLoader,
} from "./segments/load.js";
export { CSP_EVAL_AVAILABLE_KEY, CSP_WASM_AVAILABLE_KEY } from "./卜/precomputeOptional.js";
export {
  parseA1, parseCoordinates, parseAddress, parseRange,
  isRangeNotation, addressToKey, toRange, rangeToKeys,
} from "./卜/space.js";

// ── supporting ── schema bridging for SchemaCels.
export { zodToJsonSchema, jsonSchemaToZod } from "./zod-schema-utils.js";
export { counters, bump } from "./counters.js";
export type { PlastronCounters } from "./counters.js";
