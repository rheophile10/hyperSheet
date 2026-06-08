import type { Cel, DehydratedCel, Key, SegmentCel, State, 甲骨 } from "../../types/index.js";
import { getPrecomputedIndexes } from "../卜/graph.js";
import { precompute } from "../卜/precompute.js";
import { segmentCelKeyOf, setSegmentManifest } from "./cels.js";

// ============================================================================
// Dormant segments (design phase 2) — the representation + read/write
// discrimination, WITHOUT the public wake/sleep/forget verbs (roadmap 05).
//
// A dormant segment's cels live ONLY as dehydrated data (a 甲骨 payload)
// hung on its SegmentCel's `_dormant` runtime field. The live state.cels
// map holds no entry for them. Topology still sees their edges (precompute
// reads _dormant into segmentAdjacency + the dormantKeys index); getCel
// returns a read-only view of a dormant cel; writes throw.
//
//   • installDormant — the phase-2 test/host hook that constructs a
//     dormant segment (the wake/sleep verbs in 05 use the same _dormant
//     field; this is the minimal internal machinery to MAKE one).
//   • dormantSegmentOf — read path: is this key dormant, and which
//     segment owns it? Reads the precomputed dormantKeys index, falling
//     back to a payload scan before the first precompute.
//   • dormantView — getCel's read-only reconstruction of a dormant cel.
//   • assertNotDormant — the write-path guard (throws naming cel +
//     segment, "wake first").
// ============================================================================

/** Install a segment as DORMANT: hang its 甲骨 payload on its SegmentCel's
 *  `_dormant` field, ensuring a manifest cel exists, and leave state.cels
 *  with NO live entry for any of the payload's cels. Re-runs precompute so
 *  the dormant-key index + adjacency pick the payload up immediately.
 *
 *  This is phase-2 internal machinery (not a public verb): it constructs
 *  the dormant representation that wake/sleep (roadmap 05) will toggle.
 *  The caller owns the manifest's role/deps; if no SegmentCel exists yet a
 *  stub library manifest is seeded so topology has something to hang the
 *  payload on. */
export const installDormant = (
  state: State,
  payload: 甲骨,
  manifest?: { version?: string; dependencies?: Key[]; role?: SegmentCel["v"]["role"] },
): void => {
  const name = payload.name;
  const celKey = segmentCelKeyOf(name);
  let segCel = state.cels.get(celKey) as SegmentCel | undefined;
  if (!segCel || segCel.celType !== "SegmentCel") {
    setSegmentManifest(state, {
      name,
      version: manifest?.version ?? "0.0.0",
      dependencies: manifest?.dependencies ?? [],
      role: manifest?.role ?? "library",
    });
    segCel = state.cels.get(celKey) as SegmentCel;
  }
  // The payload's cels must NOT be live — strip any that slipped into
  // state.cels (defensive; sleep in 05 deflates-then-drops, but a test
  // may hand a payload whose keys were never installed).
  for (const dc of payload.cels) state.cels.delete(dc.key);
  segCel._dormant = payload;
  precompute(state);
};

/** The dormant cel keys → owning segment map. Reads the precomputed index
 *  when present; before the first precompute, scans the SegmentCels'
 *  payloads (mirrors listSegments' pre-precompute fallback). */
const dormantKeyMap = (state: State): Map<Key, Key> => {
  const idx = getPrecomputedIndexes(state)?.dormantKeys;
  if (idx) return idx;
  const out = new Map<Key, Key>();
  for (const cel of state.cels.values()) {
    if (cel.celType !== "SegmentCel") continue;
    const payload = (cel as SegmentCel)._dormant;
    if (!payload) continue;
    for (const dc of payload.cels) out.set(dc.key, payload.name);
  }
  return out;
};

/** The owning segment name when `key` is a dormant cel, else undefined.
 *  The read/write paths call this to discriminate dormant keys. */
export const dormantSegmentOf = (state: State, key: Key): Key | undefined =>
  dormantKeyMap(state).get(key);

/** Find a dormant cel's DehydratedCel record by key. */
const findDormantCel = (
  state: State, key: Key, segment: Key,
): DehydratedCel | undefined => {
  const segCel = state.cels.get(segmentCelKeyOf(segment)) as SegmentCel | undefined;
  return segCel?._dormant?.cels.find((dc) => dc.key === key);
};

/** A read-only VIEW of a dormant cel for getCel — `{ celType, metadata, v
 *  }` reconstructed from the DehydratedCel. We do NOT inflate a live cel
 *  and do NOT cache one in state.cels (the whole point of dormancy is the
 *  cels are absent). Compiled artifacts (`_fn`, `_evaluate`, live Channel)
 *  are therefore absent. The dehydrated value lives at metadata.v on a
 *  round-tripped record, or at the top-level v on an authored seed —
 *  accept either (mirrors inflateCel's baseV resolution). */
export const dormantView = (state: State, key: Key, segment: Key): Cel | undefined => {
  const dc = findDormantCel(state, key, segment);
  if (!dc) return undefined;
  const loose = dc as DehydratedCel & { v?: unknown };
  const v = loose.v ?? dc.metadata.v ?? null;
  return { celType: dc.celType, metadata: { ...dc.metadata, key }, v } as Cel;
};

/** Write-path guard: throw if `key` names a dormant cel. The error names
 *  the cel AND its owning segment and tells the caller to wake first — never
 *  a silent no-op (house rule: imperative writes throw). `label` is the
 *  calling write fn (setValue / setCel / …) for a precise message. */
export const assertNotDormant = (state: State, key: Key, label: string): void => {
  const segment = dormantSegmentOf(state, key);
  if (segment === undefined) return;
  throw new Error(
    `${label}: cel "${key}" is in DORMANT segment "${segment}" — wake "${segment}" ` +
    `before writing (dormant cels are read-only; getCel returns the dehydrated value).`,
  );
};
