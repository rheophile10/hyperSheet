import type { Key, SegmentRole, State } from "../../types/index.js";
import { getPrecomputedIndexes } from "../卜/graph.js";

// ============================================================================
// One-direction cross-segment edge rule.
//
// Between any ordered pair of CODE-role segments (kernel | library |
// application), cross-segment cel edges may flow in ONE direction only.
// A two-way pair (edges both A→B and B→A) is a hard error: the remedy is
// the classic one — move the shared cels into a segment both depend on.
//
// User-space endpoints are EXEMPT: user content is data, and cross-
// document references (sheet A reads sheet B while B reads A) are
// legitimate user acts. The rule applies only when BOTH endpoints (by
// live segment) carry a code role.
//
// Evaluated against the DERIVED segment adjacency precompute builds
// (PrecomputedIndexes.segmentAdjacency / segmentRoles), so it reads each
// cel's CURRENT metadata.segment — doc-binding retargeting is already
// reflected. Enforced at hydrate (after the fresh precompute) and at
// setCel (when a spec carries inputMap / imports / channel).
//
// See docs/1-design/3-accepted/00-ontology/derived-activity-working-set.md
// "The segment DAG" + 2-roadmap/completed/one-direction-audit.md.
// ============================================================================

const CODE_ROLES = new Set<SegmentRole>(["kernel", "library", "application"]);

const isCodeRole = (role: SegmentRole | undefined): boolean =>
  role !== undefined && CODE_ROLES.has(role);

/** Scan the derived adjacency for a two-way pair (A→B and B→A) where
 *  BOTH A and B are code-role segments. Returns the offending pair (and
 *  the segments' roles) for a precise error, or undefined when clean. */
const findTwoWayCodePair = (
  state: State,
): { a: Key; b: Key; aRole: SegmentRole; bRole: SegmentRole } | undefined => {
  const indexes = getPrecomputedIndexes(state);
  if (!indexes) return undefined;
  const { segmentAdjacency, segmentRoles } = indexes;
  for (const [a, deps] of segmentAdjacency) {
    const aRole = segmentRoles.get(a);
    if (!isCodeRole(aRole)) continue;
    for (const b of deps) {
      if (b === a) continue;
      const bRole = segmentRoles.get(b);
      if (!isCodeRole(bRole)) continue;
      // Both code roles; is there a back-edge b→a?
      if (segmentAdjacency.get(b)?.has(a)) {
        return { a, b, aRole: aRole!, bRole: bRole! };
      }
    }
  }
  return undefined;
};

/** Throw if the derived segment graph contains a two-way edge between
 *  two code-role segments. No-op when clean or before the first
 *  precompute (no adjacency to check). */
export const assertOneDirection = (state: State): void => {
  const pair = findTwoWayCodePair(state);
  if (!pair) return;
  throw new Error(
    `one-direction rule: cross-segment cel edges flow BOTH ways between ` +
    `code-role segments "${pair.a}" (${pair.aRole}) and "${pair.b}" ` +
    `(${pair.bRole}) — "${pair.a}" → "${pair.b}" AND "${pair.b}" → "${pair.a}". ` +
    `Edges between code segments must flow one way only; move the shared ` +
    `cels into a segment both depend on.`,
  );
};

/** True when a CelSpec introduces or moves a cross-segment edge — carries
 *  an inputMap, a wasm imports provider, a channel, or changes segment.
 *  setCel runs the edge check only for these (a plain value/metadata
 *  edit can't create a cross-segment edge). */
export const specTouchesEdges = (spec: {
  metadata?: Record<string, unknown> & {
    inputMap?: unknown;
    imports?: unknown;
    channel?: unknown;
    segment?: unknown;
  };
}): boolean => {
  const md = spec.metadata;
  if (!md) return false;
  return (
    md.inputMap !== undefined ||
    md.imports !== undefined ||
    md.channel !== undefined ||
    md.segment !== undefined
  );
};
