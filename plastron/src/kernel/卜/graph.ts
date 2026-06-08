import type { Cel, Key, PrecomputedIndexes, State } from "../../types/index.js";
import { isDefinitionCel } from "../cels.js";

/** Reserved cel key: locked ValueCel whose v is the live
 *  PrecomputedIndexes (seeded by 甲骨坑/kernel-internal.ts). */
export const PRECOMPUTED_STATES_KEY = "precomputedStates" as const;

/** Typed accessor for the reserved indexes cel — undefined before the
 *  first precompute pass populates it. */
export const getPrecomputedIndexes = (state: State): PrecomputedIndexes | undefined =>
  state.cels.get(PRECOMPUTED_STATES_KEY)?.v as PrecomputedIndexes | undefined;

// ============================================================================
// Graph queries — the reusable view of the cel dependency graph.
// precompute builds its indexes THROUGH these (buildChildren walks
// celDependencies), and hosts/kernel code query the same shapes here
// instead of re-deriving them. One definition of "what does this cel
// depend on" keeps the topology complete: inputMap refs AND
// metadata.schema are edges — there is no side-band dependency kind.
// ============================================================================

/** Every key this cel depends on: inputMap refs (values and definition
 *  refs alike — formula heads, named ranges, lambdas) plus the
 *  metadata.schema reference. THE single source of truth for edges;
 *  buildChildren, topo ordering, and staleness checks all walk this. */
export const celDependencies = (cel: Cel): Key[] => {
  const out: Key[] = [];
  const inputMap = (cel.metadata as { inputMap?: Record<string, Key | Key[]> }).inputMap;
  if (inputMap) {
    for (const ref of Object.values(inputMap)) {
      if (Array.isArray(ref)) out.push(...ref);
      else out.push(ref);
    }
  }
  if (cel.metadata.schema) out.push(cel.metadata.schema);
  return out;
};

/** Direct dependents (one hop) — readers of the precomputed children
 *  index. Empty set when nothing depends on the key. */
export const dependentsOf = (state: State, key: Key): Set<Key> =>
  getPrecomputedIndexes(state)?.children.get(key) ?? new Set();

/** Transitive dependents, memoized into the precomputed indexes (the
 *  cache resets on every precompute). */
export const downstreamOf = (state: State, key: Key): Set<Key> => {
  const indexes = getPrecomputedIndexes(state);
  if (!indexes) return new Set();
  let ds = indexes.downstream.get(key);
  if (!ds) {
    ds = bfsDownstream(key, indexes.children);
    indexes.downstream.set(key, ds);
  }
  return ds;
};

/** Direct dependencies resolved to live cels (missing keys skipped). */
export const dependencyCelsOf = (state: State, cel: Cel): Cel[] => {
  const out: Cel[] = [];
  for (const k of celDependencies(cel)) {
    const c = state.cels.get(k);
    if (c) out.push(c);
  }
  return out;
};

/** Transitive upstream closure of a key (the cels its value is built
 *  from), walked over live celDependencies. */
export const upstreamOf = (state: State, key: Key): Set<Key> => {
  const acc = new Set<Key>();
  const queue: Key[] = [key];
  while (queue.length > 0) {
    const k = queue.pop()!;
    const cel = state.cels.get(k);
    if (!cel) continue;
    for (const dep of celDependencies(cel)) {
      if (!acc.has(dep)) { acc.add(dep); queue.push(dep); }
    }
  }
  return acc;
};

/** BFS over a children index from one key. Exposed for callers that
 *  hold their own children map; prefer downstreamOf for state-level
 *  queries (it memoizes). */
export const bfsDownstream = (
  start: Key,
  children: Map<Key, Set<Key>>,
): Set<Key> => {
  const acc = new Set<Key>();
  const queue: Key[] = [];
  const seed = children.get(start);
  if (!seed) return acc;
  for (const c of seed) { acc.add(c); queue.push(c); }
  while (queue.length > 0) {
    const k = queue.pop()!;
    const kids = children.get(k);
    if (!kids) continue;
    for (const c of kids) {
      if (!acc.has(c)) { acc.add(c); queue.push(c); }
    }
  }
  return acc;
};

/** Bump the state's definition counter and stamp the cel. Call after
 *  any DEFINITION mutation — lambda fn/source, schema/compiler/range/
 *  channel v, or wholesale cel replacement. Consumers compiled before
 *  this stamp recompile on their next fire. */
export const bumpDefGeneration = (state: State, cel: Cel): void => {
  state.defGeneration = (state.defGeneration ?? 0) + 1;
  cel._defGen = state.defGeneration;
};

/** True when any definition-class dependency of the cel changed after
 *  the cel last compiled — the fire-time recompile trigger. */
export const isDefinitionStale = (state: State, cel: Cel): boolean => {
  const compiledGen = (cel as { _compiledGen?: number })._compiledGen ?? 0;
  for (const k of celDependencies(cel)) {
    const dep = state.cels.get(k);
    if (!dep || !isDefinitionCel(dep)) continue;
    if ((dep._defGen ?? 0) > compiledGen) return true;
  }
  return false;
};
