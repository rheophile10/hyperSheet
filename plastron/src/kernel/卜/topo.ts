// ============================================================================
// Generic topological helpers shared by the cascade builder
// (`precompute/precompute.ts`), segment-flush ordering (`segments.ts`), and
// the segment-classification machinery (boot kernel-set, hydration order,
// orphan detection).
//
// Both helpers are pure: no kernel coupling, no State knowledge. They
// operate on abstract node identifiers and adjacency functions. Consumers
// provide the closure that resolves upstreams (or reverse-adjacency) for
// their specific node kind.
//
// See docs/1-design/3-accepted/00-ontology/segment-classification.md
// "Shared topo helper" for the extraction rationale and design.
// ============================================================================

import type { TopoLevelsOptions } from "../../types/index.js";
export type { TopoLevelsOptions };

/** Kahn-style topological level grouping. Returns arrays of nodes where
 *  every node at level N has all its upstreams resolved by earlier
 *  levels. Throws on cycles with the unresolved nodes attached to the
 *  error as `.cycle: T[]`.
 *
 *  Suitable for cel-wave construction (cascade), segment-DAG walks
 *  (boot kernel-set, hydration order), and any other DAG-leveling
 *  problem. */
export const topoLevels = <T>(
  nodes: Iterable<T>,
  upstreamsOf: (node: T) => Iterable<T>,
  options?: TopoLevelsOptions<T>,
): T[][] => {
  const memberSet = options?.memberSet;
  const prefix = options?.cycleMessagePrefix ?? "Dependency cycle";

  // Kahn's algorithm, level-grouped, O(V+E). A node's in-degree is its count
  // of DISTINCT in-set upstreams (an upstream outside the node set — or
  // filtered out by memberSet — is treated as already resolved, matching the
  // old `remaining.has` semantics; duplicate upstreams collapse via the Set,
  // as the old `deps` Set did). We process all currently-ready nodes as one
  // level, decrement each dependent's in-degree, and the dependents that hit
  // zero form the next level. A node's level is thus 1 + max(level of its
  // in-set upstreams) — identical leveling to the old O(V·depth) rescan,
  // without the quadratic.
  const nodeList: T[] = [...nodes];
  const inDegree = new Map<T, number>();
  for (const k of nodeList) inDegree.set(k, 0);
  const dependents = new Map<T, T[]>(); // upstream → its in-set dependents
  for (const k of nodeList) {
    const ups = new Set<T>();
    for (const u of upstreamsOf(k)) {
      if (memberSet !== undefined && !memberSet.has(u)) continue;
      if (!inDegree.has(u)) continue; // upstream not in the node set → resolved
      ups.add(u);
    }
    inDegree.set(k, ups.size);
    for (const u of ups) {
      let dep = dependents.get(u);
      if (!dep) dependents.set(u, dep = []);
      dep.push(k);
    }
  }

  const levels: T[][] = [];
  let ready: T[] = nodeList.filter((k) => inDegree.get(k) === 0);
  let processed = 0;
  while (ready.length > 0) {
    levels.push(ready);
    processed += ready.length;
    const next: T[] = [];
    for (const k of ready) {
      const deps = dependents.get(k);
      if (!deps) continue;
      for (const d of deps) {
        const nd = inDegree.get(d)! - 1;
        inDegree.set(d, nd);
        if (nd === 0) next.push(d);
      }
    }
    ready = next;
  }

  if (processed < nodeList.length) {
    const cycle = nodeList.filter((k) => (inDegree.get(k) ?? 0) > 0);
    const err = new Error(
      `${prefix}; remaining: ${cycle.map(String).join(", ")}`,
    ) as Error & { cycle: T[] };
    err.cycle = cycle;
    throw err;
  }
  return levels;
};

/** DFS post-order traversal — dependents-first ordering reachable from
 *  `root` via the supplied reverse-adjacency map (node → set of nodes
 *  that depend on it). The root itself is excluded from the returned
 *  list. Used by flush's `cascade: true` to tear down dependents
 *  before the target. */
export const dependentOrderFrom = <T>(
  root: T,
  reverseAdjacency: ReadonlyMap<T, Iterable<T>>,
): T[] => {
  const visited = new Set<T>();
  const order: T[] = [];
  const visit = (k: T): void => {
    if (visited.has(k)) return;
    visited.add(k);
    for (const child of reverseAdjacency.get(k) ?? []) visit(child);
    if (k !== root) order.push(k);
  };
  visit(root);
  return order;
};

/** Forward-transitive closure from a set of roots. Returns every node
 *  reachable by following the `downstreamsOf` function (which yields
 *  the direct dependencies of a node — semantics flexible per caller).
 *  Used for the boot kernel-set computation: closure(role=kernel
 *  segments, m => m.dependencies). */
export const transitiveClosure = <T>(
  roots: Iterable<T>,
  downstreamsOf: (node: T) => Iterable<T>,
): Set<T> => {
  const out = new Set<T>();
  const stack: T[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (out.has(node)) continue;
    out.add(node);
    for (const d of downstreamsOf(node)) {
      if (!out.has(d)) stack.push(d);
    }
  }
  return out;
};
