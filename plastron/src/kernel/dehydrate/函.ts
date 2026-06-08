import type {
  Key, SegmentCel, State, 函, 函SegmentEntry, 甲骨, 冊,
} from "../../types/index.js";
import { getPrecomputedIndexes } from "../卜/graph.js";
import { kernelClosureOf } from "../segments/graph.js";
import { getBundledLoaders } from "../segments/load.js";
import { segmentEntries, segmentCelKeyOf } from "../segments/cels.js";
import { groupCelsBySegment } from "./segment.js";

// ============================================================================
// dehydrate函 — warm boot: emit the application as ONE 函 artifact (the
// inverse of hydrate函, design phase 4).
//
//   • version    — carried through (caller-supplied; default "0.1.0").
//   • segments   — one entry per non-kernel segment:
//       - bundled/native (in the bundled-loader table)  → codeSeed entry.
//       - dormant (SegmentCel._dormant)                 → inline (the
//         already-deflated payload passes through verbatim — cost
//         proportional to what's awake).
//       - awake non-bundled (user/document/source segs) → inline (deflate
//         the live cels now).
//       - pending external source (url/store, never woken) → its source.
//     The kernel closure is excluded — it re-seeds at createInitialState.
//   • boot.wake  — the CURRENTLY-AWAKE root cover: awake segments minus
//                  those reachable as a dependency of another awake segment
//                  (the minimal roots of the awake down-set). NO set pairs —
//                  the values ride inside the payloads.
//
// Round-trip: createInitialState → hydrate函(dehydrate函(state)) reproduces
// the same awake/dormant split and the same values.
// ============================================================================

export interface Dehydrate函Options {
  /** Artifact version string. Default "0.1.0". */
  version?: string;
}

/** The set of segments that are AWAKE (≥1 live non-SegmentCel member). */
const awakeSegments = (state: State): Set<Key> => {
  const out = new Set<Key>();
  for (const cel of state.cels.values()) {
    if (cel.celType === "SegmentCel") continue;
    const seg = cel.metadata.segment;
    if (seg !== undefined) out.add(seg);
  }
  return out;
};

/** The minimal root cover of the awake down-set: awake segments that are NOT
 *  a dependency of any OTHER awake segment (per the derived adjacency). These
 *  are exactly the roots boot.wake must name — waking them pulls the rest of
 *  the awake closure. Excludes kernel-closure members (always awake, never in
 *  the artifact). User-space SCCs: a member depended-on from within its own
 *  cycle stays covered, but if the whole SCC has no external awake dependent,
 *  every member is a root (set-insertion wake absorbs the cycle). */
const awakeRootCover = (state: State, kernelSet: ReadonlySet<Key>): Key[] => {
  const awake = awakeSegments(state);
  const adj = getPrecomputedIndexes(state)?.segmentAdjacency;
  // depended = union of deps of every awake segment (excluding self-edges,
  // which the adjacency already omits).
  const depended = new Set<Key>();
  if (adj) {
    for (const source of awake) {
      for (const dep of adj.get(source) ?? []) {
        if (dep !== source) depended.add(dep);
      }
    }
  }
  const roots: Key[] = [];
  for (const seg of awake) {
    if (kernelSet.has(seg)) continue;     // kernel re-seeds; not a 函 root.
    if (depended.has(seg)) continue;      // reachable as another's dependency.
    roots.push(seg);
  }
  return roots;
};

export const dehydrate函 = (state: State, opts?: Dehydrate函Options): 函 => {
  const kernelSet = kernelClosureOf(state);
  const bundled = getBundledLoaders(state);

  // Deflate awake non-bundled segments once (groupCelsBySegment skips
  // native-bodied husks AND passes dormant payloads through — so its output
  // already covers both awake-data segments and dormant segments). Index by
  // name for the entry build below.
  const grouped = new Map<Key, 甲骨>();
  for (const g of groupCelsBySegment(state)) grouped.set(g.name, g);

  const segments: 函SegmentEntry[] = [];
  for (const [name, manifest] of segmentEntries(state)) {
    if (kernelSet.has(name)) continue;    // kernel re-seeds at createInitialState.

    const partial = manifestEntryFields(manifest);
    const segCel = state.cels.get(segmentCelKeyOf(name)) as SegmentCel | undefined;

    // 1. bundled/native → codeSeed (cels re-seed from the host bundle).
    if (bundled?.has(name)) {
      segments.push({ name, payload: { codeSeed: true }, manifest: partial });
      continue;
    }
    // 2. pending external source never woken → carry the source forward.
    if (segCel?._pendingSource) {
      segments.push({ name, payload: segCel._pendingSource, manifest: partial });
      continue;
    }
    // 3. dormant OR awake-data → inline. groupCelsBySegment produced the
    //    payload (dormant: pass-through; awake: freshly deflated). A segment
    //    with no grouped payload (no data cels — e.g. only native husks that
    //    aren't bundled, which shouldn't happen) emits an empty inline.
    const payload = grouped.get(name) ?? { name, cels: [] };
    segments.push({ name, payload: { inline: payload }, manifest: partial });
  }

  return {
    version: opts?.version ?? "0.1.0",
    boot: { wake: awakeRootCover(state, kernelSet) },
    segments,
  };
};

/** The 冊 fields a 函 entry carries (everything except the entry name). */
const manifestEntryFields = (m: 冊): Partial<Omit<冊, "name">> => {
  const { name: _name, ...rest } = m;
  void _name;
  return rest;
};
