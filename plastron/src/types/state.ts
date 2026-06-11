import type { Cel, ChannelCel, Fn } from "./cels/index.js";
import type { CelType, CelMetadata, SegmentRole, 甲骨, 冊 } from "./甲骨/index.js";
import type { Key } from "./index.js";

export interface State {
  cels: Map<Key, Cel>;
  precomputeGeneration: number;
  /** Monotonic definition counter. Every definition mutation (a
   *  Lambda/Schema/Compiler/Range/Channel cel replaced or its
   *  definition content changed) bumps this and stamps the cel's
   *  _defGen. Compiled consumers stamp _compiledGen at compile; the
   *  cascade compares the two at fire time and recompiles stale
   *  consumers — pull-based, so segments that become active later
   *  self-heal. Runtime-only (never dehydrated). */
  defGeneration: number;
  /** Layer-2 at-rest SEAL hooks (LIBRARY-provided; the kernel stays
   *  stateless + zero-dep). When `sealCipher` is set, dehydrate replaces a
   *  SEALED segment cel's dehydrated value `v` with a `{ __sealed:
   *  "<ivB64.cipherB64>" }` marker so the secret never enters the archive
   *  in plaintext; absent (the default), dehydrate is unchanged.
   *  `sealDecipher`, when set, is the inverse — hydrate decrypts a
   *  `{ __sealed }` marker back to its value. With NO decipher (locked),
   *  the marker is left intact and the value stays unreadable until a
   *  `seal.lock(password)` installs the hooks. The seal LIBRARY
   *  (甲骨坑/library/seal) installs/clears these; the kernel only calls
   *  them — it never imports any cipher. Runtime-only (never dehydrated). */
  sealCipher?: (segment: Key, v: unknown) => unknown;
  sealDecipher?: (v: unknown) => unknown;
  // Segment manifests no longer live in a side Map. A segment named X
  // is a SegmentCel in `cels` at key `冊.X` (metadata.segment = X, v =
  // its 冊). Read/write via kernel/segments/cels.ts (getSegmentManifest
  // / listSegments / setSegmentManifest); the segment dependency graph
  // is DERIVED from live cel edges in precompute
  // (PrecomputedIndexes.segmentAdjacency), not from a declared record.
}

// ============================================================================
// Reserved cel keys — locked kernel-internal cels every State carries.
// Seeded at createInitialState (甲骨坑/kernel-internal.ts); hosts must
// not collide with these. A third reserved key, the append-only errors
// log, is owned by the cel-error segment (甲骨坑/cel-error.ts).
// ============================================================================

// Reserved cel keys + typed accessors live with their kernel owners:
//   PRECOMPUTED_STATES_KEY / getPrecomputedIndexes → kernel/卜/graph.ts
//   COMPILE_CACHE_KEY                              → kernel/hydrate/formula.ts
//   SEGMENT_LOADERS_KEY / getSegmentLoaders        → kernel/segments/load.ts

/** Produces the live cels of a not-yet-installed segment. Bundled
 *  (code-seed) loaders are sync; runtime-registered loaders may be
 *  async (fetch a .甲 over HTTP, read OPFS, dynamic import). Cels must
 *  arrive live — Lambda/Compiler cels with _fn/v bound — exactly as a
 *  createInitialState code seed would ship them. Dehydrated archives
 *  go through `hydrate` instead, which compiles. */
export type SegmentLoader = () => Cel[] | Promise<Cel[]>;

/** The cascade indexes 卜/precompute builds at the end of hydrate (and
 *  rebuilds after structural edits — setCel, registerLambda, flush) and
 *  that runCycle, invalidate, and 契's channel paths traverse. Stored as
 *  the v of the locked cel at PRECOMPUTED_STATES_KEY because the shapes
 *  (Maps, Sets, live Channels) can't ride on the JSON-shaped State. */
export interface PrecomputedIndexes {
  waveCascade: Map<number, Key[][]>;
  sortedWaves: number[];
  /** Same shape as waveCascade but with each level partitioned by
   *  cel kind (see kindOf in types/cels.ts). v1 doesn't change dispatch
   *  — runCycle still walks waveCascade and fires cels inline on the
   *  main thread regardless of kind. The kind partition exists so the
   *  per-kind worker dispatch (WASM-DOMAIN.md § 5) can plug into the
   *  precompute side without moving any of it: when "py" arrives,
   *  the runCycle reads `waveCascadeByKind.get(W)[L].get("py")` and
   *  posts that batch to the py worker as a single round trip.
   *  Diagnostics already use it to count cross-kind cells per wave. */
  waveCascadeByKind: Map<number, Map<Key, Key[]>[]>;
  children: Map<Key, Set<Key>>;
  downstream: Map<Key, Set<Key>>;
  dynamicCascade: Set<Key>;
  /** Every ChannelCel in state.cels, keyed by its cel.metadata.key.
   *  Built at precompute; flushChannels and the enqueueChannels
   *  fallback path read this instead of a separate channelRegistry. */
  channels: Map<Key, ChannelCel>;
  /** Every loaded segment NAME (the SegmentCels in state.cels, by their
   *  冊.name). Maintained here the way `channels` is so hot listSegments
   *  callers skip the cel scan. Built at precompute. */
  segments: Set<Key>;
  /** DERIVED segment dependency graph: source segment → the segments it
   *  depends on (self-edges omitted). Aggregated at precompute from each
   *  cel's LIVE metadata.segment over three edge kinds — inputMap
   *  targets, metadata.imports (wasm provider cel), and metadata.channel
   *  (channel target cels). Replaces the hand-declared 冊.dependencies as
   *  the source of truth for ordering; manifests keep `dependencies` for
   *  tooling/over-declaration and are warned against this on drift. */
  segmentAdjacency: Map<Key, Set<Key>>;
  /** DERIVED role lookup: segment name → its SegmentCel's role. Cheap
   *  role check for the one-direction edge rule (avoids a manifest read
   *  per edge). Built at precompute alongside segmentAdjacency. */
  segmentRoles: Map<Key, SegmentRole>;
  /** DORMANT-key index (design phase 2): cel key → owning segment name,
   *  for every cel living in a dormant segment's SegmentCel `_dormant`
   *  payload. Built at precompute from the SegmentCels' payloads. The
   *  live `state.cels` map holds NO entry for these keys — this index is
   *  how reads/writes discover that a key is dormant (getCel returns a
   *  read-only view of the payload's DehydratedCel; writes throw naming
   *  the cel + this segment). Empty when no segment is dormant. */
  dormantKeys: Map<Key, Key>;
}

export type Hydrate = (
  state: State,
  segments: 甲骨[],
  manifests: 冊[],
) => Promise<State>;

export interface DehydrateOptions {
  /** When set, restrict output to these segment names. Cels whose
   *  `metadata.segment` is in this set are emitted; manifests are
   *  filtered to the same set (plus any stub manifests for observed
   *  segments without a registered 冊). Default = emit everything
   *  except "kernel" (the boot-seeded fns that re-seed at
   *  createInitialState). */
  onlySegments?: Key[];
}

export type Dehydrate = (
  state: State,
  opts?: DehydrateOptions,
) => { segments: 甲骨[]; manifests: 冊[] };

/** setCel's argument — a cel as STRUCTURE.
 *
 *  With celType: the complete definition of a new/replacement cel
 *  (v/f/fn are seed content, exactly as a hydrate seed would carry
 *  them; fn installs a native runtime fn on Lambda celTypes).
 *  Without celType: a metadata-only edit of an existing cel — v/f/fn
 *  are refused there, because data writes are setValue's domain and a
 *  definition's content only changes by replacing the definition. */
export interface CelSpec {
  celType?: CelType;
  metadata?: Partial<CelMetadata> & Record<string, unknown>;
  v?: unknown;
  f?: string;
  fn?: Fn;
  /** Native disposal hook stored as cel._dispose — fired before the
   *  cel is replaced or flushed. Pairs with fn. */
  dispose?: () => void;
  wave?: number;
  dynamic?: boolean;
  locked?: boolean;
}
