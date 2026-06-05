import type { BaseCelMetadata, 函PayloadSource, 冊, 甲骨 } from "../甲骨/index.js";
import type { BaseCel } from "./baseCel.js";

/** DEFINITION plane. A segment manifest, reified as a cel. Its `v` is
 *  the segment's 冊 (name, version, dependencies, role, applications…),
 *  the record that used to live in the retired `state.segments` side
 *  Map. A segment named X gets cel key `冊.X` (namespaced so it can't
 *  collide with user cel keys) and `metadata.segment` = X, so a
 *  forget/flush of X removes its SegmentCel naturally.
 *
 *  SegmentCels are definition-plane: replacing one bumps defGeneration
 *  like other definition cels. They are observable like any cel — a
 *  FormulaCel may name `冊.X` in its inputMap and read the manifest. */
export interface SegmentCel extends BaseCel {
  celType: "SegmentCel";
  metadata: BaseCelMetadata;
  v: 冊;
  /** DORMANT payload (design phase 2). When present, the segment is
   *  dormant: its cels live ONLY as dehydrated data here, not as live
   *  cels in `state.cels`. Topology reads their edges from this 甲骨
   *  (precompute's dormant-key index + segmentAdjacency), `getCel`
   *  returns a read-only view of a dormant cel's DehydratedCel, and
   *  writes throw. A RUNTIME field — it never dehydrates (dehydrate
   *  passes the payload through from here directly; it is not part of
   *  the 冊 JSON), so it is named with a leading underscore like the
   *  other runtime-only cel fields (`_fn`, `_defGen`, `_channel`). */
  _dormant?: 甲骨;
  /** PENDING payload source (design phase 4 / roadmap 06). A dormant
   *  segment whose cels come from an EXTERNAL source (a `url` archive or a
   *  segment-`store` ref) carries the unresolved source here. The segment
   *  is dormant with NO `_dormant` payload yet — topology sees only the
   *  manifest until first wake. `wake` resolves this (fetch / store.get),
   *  installs the resulting 甲骨 as `_dormant`, clears this field, then
   *  inflates as usual. An `inline` source resolves to `_dormant` directly
   *  at 函-hydrate and never sets this; `codeSeed` segments never go dormant
   *  (they park a bundled loader). A RUNTIME field — never dehydrated. */
  _pendingSource?: 函PayloadSource;
}
