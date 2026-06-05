import type { Cel, Key, SegmentCel, State, 冊 } from "../../types/index.js";

// ============================================================================
// SegmentCel accessors — the manifest source after `state.segments` retired.
//
// A segment named X lives as a SegmentCel at cel key `冊.X` (namespaced
// so it can't collide with user cel keys), with `metadata.segment = X`
// (so flush/forget of X removes its SegmentCel naturally) and `v` = its
// 冊 manifest. These helpers are the one read/write surface; every place
// that used to touch the side Map goes through them.
//
// listSegments / segmentEntries scan state.cels — always correct, even
// before the first precompute (lazy boot seeds SegmentCels but doesn't
// precompute). Hot callers that run AFTER a precompute read the
// `segments` Set maintained in PrecomputedIndexes instead (built by
// precompute, same as `channels`) — see getPrecomputedIndexes(state).segments.
// ============================================================================

const PREFIX = "冊." as const;

/** Cel key for a segment's SegmentCel. */
export const segmentCelKeyOf = (name: Key): Key => `${PREFIX}${name}`;

const isSegmentCel = (c: Cel): c is SegmentCel => c.celType === "SegmentCel";

/** The 冊 manifest for a loaded segment, or undefined. */
export const getSegmentManifest = (state: State, name: Key): 冊 | undefined => {
  const cel = state.cels.get(segmentCelKeyOf(name));
  return cel && isSegmentCel(cel) ? cel.v : undefined;
};

/** True when a segment manifest is loaded (the side-Map `.has` twin). */
export const hasSegment = (state: State, name: Key): boolean =>
  state.cels.has(segmentCelKeyOf(name));

/** Every loaded segment's manifest, in cel-insertion order. */
export const listSegments = (state: State): 冊[] => {
  const out: 冊[] = [];
  for (const cel of state.cels.values()) if (isSegmentCel(cel)) out.push(cel.v);
  return out;
};

/** Every loaded segment NAME. */
export const listSegmentNames = (state: State): Key[] => {
  const out: Key[] = [];
  for (const cel of state.cels.values()) if (isSegmentCel(cel)) out.push(cel.v.name);
  return out;
};

/** [name, 冊] pairs for every loaded segment — the iteration shape the
 *  old `for (const [k, m] of state.segments)` loops expect. */
export const segmentEntries = (state: State): Array<[Key, 冊]> => {
  const out: Array<[Key, 冊]> = [];
  for (const cel of state.cels.values()) {
    if (isSegmentCel(cel)) out.push([cel.v.name, cel.v]);
  }
  return out;
};

/** Create or replace the SegmentCel carrying `manifest`. The cel is
 *  unlocked (manifests are editable definition content) and definition-
 *  plane; precompute rebuilds the `segments` index afterwards. */
export const setSegmentManifest = (state: State, manifest: 冊): void => {
  const key = segmentCelKeyOf(manifest.name);
  const cel: SegmentCel = {
    celType: "SegmentCel",
    metadata: { key, segment: manifest.name },
    v: manifest,
    locked: false,
  };
  state.cels.set(key, cel);
};

/** Remove a segment's SegmentCel (the side-Map `.delete` twin). */
export const deleteSegmentManifest = (state: State, name: Key): void => {
  state.cels.delete(segmentCelKeyOf(name));
};
