import type { Key, State, 冊 } from "../../types/index.js";
import { dependentOrderFrom, transitiveClosure } from "../卜/topo.js";
import { segmentEntries } from "./cels.js";

// ============================================================================
// Segment graph queries — now reimplemented over SegmentCels (the side
// Map state.segments retired). getSegmentManifest / listSegments /
// setSegmentManifest live in ./cels.ts; the closure + dependent walks
// stay here. Exported signatures are preserved where callers pass an
// explicit Map<Key, 冊> (cli-segment-export builds its own from store
// records); state-level callers go through the segmentMap helper.
// ============================================================================

/** Materialize the {name → 冊} map from the live SegmentCels. The
 *  closure/dependent walks below operate over a plain Map so the
 *  cli-segment-export path (which builds a map from store records, not
 *  from state) can reuse the same algorithms. */
export const segmentMap = (state: State): Map<Key, 冊> => {
  const m = new Map<Key, 冊>();
  for (const [name, manifest] of segmentEntries(state)) m.set(name, manifest);
  return m;
};

/** Compute the boot kernel-set: the transitive closure of all
 *  segments with `role: "kernel"` plus everything they depend on.
 *  Members of this set are flush-protected and excluded from
 *  dehydrate output.
 *
 *  See docs/1-design/3-accepted/00-ontology/segment-classification.md
 *  "Multi-segment kernel". */
export const computeKernelClosure = (segments: Map<Key, 冊>): Set<Key> => {
  const roots: Key[] = [];
  for (const [name, m] of segments) {
    if (m.role === "kernel") roots.push(name);
  }
  return transitiveClosure(roots, (name) => segments.get(name)?.dependencies ?? []);
};

/** State-level convenience: the kernel closure derived from the live
 *  SegmentCels. */
export const kernelClosureOf = (state: State): Set<Key> =>
  computeKernelClosure(segmentMap(state));

// ============================================================================
// Segment introspection helpers registered as locked core fns so lambdas
// / host tooling can react to what's loaded. getSegmentManifest /
// listSegments are re-exported from ./cels.ts; findDependents lives here.
// ============================================================================

/** Return the segments that declare segmentKey as a dependency. */
export const findDependents = (state: State, segmentKey: Key): Key[] => {
  const out: Key[] = [];
  for (const [k, m] of segmentEntries(state)) {
    if (m.dependencies.includes(segmentKey)) out.push(k);
  }
  return out;
};

/** Topological order of the transitive dependents of `segmentKey`,
 *  leaves first. Used by flush(..., { cascade: true }) to know which
 *  dependents to flush before the target. */
export const topologicalDependentOrder = (
  segments: Map<Key, 冊>,
  segmentKey: Key,
): Key[] => {
  // Reverse adjacency: dep → list of dependents.
  const dependentsOf = new Map<Key, Key[]>();
  for (const [k, m] of segments) {
    for (const d of m.dependencies) {
      let bucket = dependentsOf.get(d);
      if (!bucket) { bucket = []; dependentsOf.set(d, bucket); }
      bucket.push(k);
    }
  }
  return dependentOrderFrom<Key>(segmentKey, dependentsOf);
};

// Re-export the SegmentCel manifest accessors so the segments barrel and
// kernel barrel keep their existing export surface.
export { getSegmentManifest, listSegments, setSegmentManifest } from "./cels.js";
