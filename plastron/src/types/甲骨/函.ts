import type { Key } from "../index.js";
import type { 甲骨, 冊 } from "./冊.js";

// ============================================================================
// 函 — the application artifact: ONE JSON record describing an
// application's initial state (design phase 4, roadmap 06).
//
// Lore: 冊 (cè) is a single bound volume — a segment's manifest, reified
// as a SegmentCel. 函 (hán) is the traditional book-CASE that holds bound
// volumes; here it holds the application's segment entries (each a 冊
// payload-source pair) plus a boot record. "Boot as data": createInitialState
// (kernel closure) → hydrate函 the entries (payloads dormant) → wake the
// boot roots → apply the boot set pairs. Warm boot is the inverse:
// dehydrate函 emits the single 函 artifact (awake segments deflated inline;
// dormant payloads pass through; native segments as codeSeed) with the
// CURRENTLY-AWAKE root cover as boot.wake.
//
// Naming choice (documented in roadmap 06 Notes): 函 over "Application冊"
// because the application is NOT itself a 冊 (a single segment manifest) —
// it is the case that BINDS many 冊s. Keeps the per-segment manifest type
// (冊) and the application type (函) lore-distinct.
// ============================================================================

/** Where a segment's cels come from. A discriminated union, one variant
 *  per de-facto source the design unifies:
 *
 *  - `inline`   — a 甲骨 payload carried in the 函 itself (installed DORMANT
 *                 at 函-hydrate; first wake inflates it from in-state data).
 *  - `url`      — a `.甲` archive fetched on FIRST WAKE (plain await; the
 *                 dormant segment carries the pending source until then).
 *  - `store`    — a segment-store name@version resolved on first wake via
 *                 the resolveFn'd `store.get` fn cel (graceful error if the
 *                 store library isn't installed).
 *  - `codeSeed` — a native-bodied segment that ships in the host bundle;
 *                 its loader MUST exist in the bundled-loader table at
 *                 函-hydrate (a missing seed throws BEFORE anything runs). */
export type 函PayloadSource =
  | { inline: 甲骨 }
  | { url: string }
  | { store: { name: Key; version?: string } }
  | { codeSeed: true };

/** One segment entry in a 函: its name, where its cels come from, and an
 *  optional partial 冊 manifest (version/dependencies/role/applications/
 *  sink). The manifest fields are validated through validateManifests /
 *  applyManifestDefaults at 函-hydrate. */
export interface 函SegmentEntry {
  name: Key;
  payload: 函PayloadSource;
  /** Optional 冊 fields for this segment. `name` is taken from the entry's
   *  top-level `name`; everything else (version, dependencies, role,
   *  applications, sink) may be declared here. Absent fields take
   *  applyManifestDefaults (role → "library", version → "0.0.0"). */
  manifest?: Partial<Omit<冊, "name">>;
}

/** The boot record: which roots to wake, and which value writes to apply
 *  after waking. */
export interface 函Boot {
  /** Segment ROOTS to wake — their dormant dependency closures are
   *  derived (per the segment adjacency). A bare value write cannot wake a
   *  segment (no wake-on-cascade), so activation is always explicit here. */
  wake: Key[];
  /** Value writes applied via setValueBatch (`{ flush: "all" }`) AFTER the
   *  roots wake. Each pair is `[key, value]` (the batch shape). A write to
   *  a cel in a segment `wake` did NOT wake throws (dormant write) — a 函
   *  author must wake what they set, or the set targets must live in an
   *  always-awake kernel segment. */
  set?: Array<[Key, unknown]>;
}

/** The application artifact. ONE JSON record: version + segment entries +
 *  boot record. */
export interface 函 {
  version: string;
  boot: 函Boot;
  segments: 函SegmentEntry[];
}
