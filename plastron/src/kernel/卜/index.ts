// 卜 — recalculation. Everything that turns staged inputs into
// recalculated values: the precomputed topology, the cascade runner,
// invalidation, memo/hook execution, and the default formula language.
// (The PrecomputedIndexes type + reserved keys live in types/state.ts.)

// Topology — built at the end of hydrate, rebuilt after structural
// edits; runCycle and 契 traverse it rather than re-deriving the graph.
export { precompute, buildPrecomputedIndexes } from "./precompute.js";
export { precomputeOptional } from "./precomputeOptional.js";
export { topoLevels, transitiveClosure, dependentOrderFrom } from "./topo.js";

// Recalculation — fire dirty cels wave by wave, level by level.
export { runCycle, interlinked, ilk, 連鎖, runCascade, getCurrentCel, affectedFor } from "./runCycle.js";
export {
  celDependencies, dependentsOf, downstreamOf, upstreamOf, dependencyCelsOf,
  bfsDownstream, bumpDefGeneration, isDefinitionStale,
} from "./graph.js";

// Execution machinery — memoized/hooked cel firing.
export {
  hasHooksOrCache, makeLambdaTrampoline, memoEligibility,
  deriveCacheKeysFromInputMap, runHookedExecution,
} from "./hooks.js";
export { makeMemoCache } from "./memo-cache.js";

// Coordinate space — positioned reads over data cels: values at
// addresses, range extraction, n-dimensional neighborhoods.
export { celAt, valueAt, valuesInRange, neighborsOf } from "./space.js";
export type { NeighborSample, NeighborOptions } from "../../types/index.js";

// Default formula language — S-expression source → CompiledLambda,
// registered at cel key "f" by 甲骨坑/kernel-io.
export { compileFormula, extractDeps } from "./formula.js";
