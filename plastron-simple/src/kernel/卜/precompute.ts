import type {
  Cel, Channel, ChannelCel, ChannelEnqueue, FireableCel, Key, SegmentCel,
  SegmentRole, State,
} from "../../types/index.js";
import type { PrecomputedIndexes } from "../../types/index.js";
import { PRECOMPUTED_STATES_KEY } from "./graph.js";
import { isFireable, kindOf } from "../cels.js";
import { resolveSchemas } from "../hydrate/schema.js";
import { resolveFn } from "../resolve-fn.js";
import { topoLevels as topoLevelsGeneric } from "./topo.js";
import { bfsDownstream, celDependencies } from "./graph.js";
import { precomputeOptional } from "./precomputeOptional.js";
import { appendError, makeCelError } from "../cel-error.js";

// PRECOMPUTED_STATES_KEY and the PrecomputedIndexes interface live in
// types/state.ts (reserved cel keys) — this module builds the indexes,
// the type rides with the State it caches on.

/** Build a fresh, empty PrecomputedIndexes. Used by the kernel-internal
 *  seed for the boot-time precomputedStates cel (JSON can't carry Maps
 *  or a Set), and available to host code that needs to rebuild after
 *  a reset. Lives here rather than index.ts to avoid a circular import
 *  from kernel-internal back through createInitialState. */
export const buildPrecomputedIndexes = (): PrecomputedIndexes => ({
  waveCascade:       new Map(),
  sortedWaves:       [],
  waveCascadeByKind: new Map(),
  children:          new Map(),
  downstream:        new Map(),
  dynamicCascade:    new Set(),
  channels:          new Map(),
  segments:          new Set(),
  segmentAdjacency:  new Map(),
  segmentRoles:      new Map(),
  dormantKeys:       new Map(),
});

// Build the live Channel for a ChannelCel from its DehydratedChannel
// descriptor. Internal queue + resolveFn lookup for drain/dispose so
// the cel registry stays the single source of truth for runtime fns.
const buildChannel = (cel: ChannelCel, state: State): Channel => {
  const queue: ChannelEnqueue[] = [];
  const drainKey = cel.v.drain;
  const disposeKey = cel.v.dispose;
  return {
    enqueue: (args) => { queue.push(args); },
    hasPending: () => queue.length > 0,
    drain: () => {
      const fn = resolveFn(state, drainKey);
      if (!fn) { queue.length = 0; return; }
      const items = queue.splice(0);
      const r = fn(items, state);
      if (r instanceof Promise) return r as Promise<void>;
      return;
    },
    dispose: () => {
      if (!disposeKey) return;
      const fn = resolveFn(state, disposeKey);
      if (fn) fn(state);
    },
  };
};

export const precompute = (state: State): void => {
  const cels = state.cels;

  const byWave = new Map<number, Key[]>();
  for (const cel of cels.values()) {
    if (!isFireable(cel)) continue;
    if (!cel._fn) continue;
    // Cascade membership requires an observable signal — either an
    // inputMap declaring upstream deps, or `dynamic` (refresh every
    // cycle). Cels with neither are dispatch surfaces (core fn cels,
    // registerLambda-created lambdas) whose _fn is called by other
    // code with its own calling convention, not by the cascade.
    if (!cel.metadata.inputMap && !cel.dynamic) continue;
    const wave = cel.wave ?? 0;
    let bucket = byWave.get(wave);
    if (!bucket) { bucket = []; byWave.set(wave, bucket); }
    bucket.push(cel.metadata.key);
  }
  const waveCascade = new Map<number, Key[][]>();
  for (const [wave, members] of byWave) {
    try {
      waveCascade.set(wave, topoLevels(members, cels));
    } catch (e) {
      // Append-before-rethrow so the host can enumerate the cycle via
      // the errors log even though precompute itself still throws (the
      // graph is malformed; the cascade can't run). topoLevels stashes
      // the participating cel keys on err.cycle for this purpose.
      const cycle = (e as { cycle?: Key[] }).cycle ?? [];
      appendError(state, makeCelError(cycle, "CycleError", e));
      throw e;
    }
  }
  const sortedWaves = [...waveCascade.keys()].sort((a, b) => a - b);

  // Partition each level by kind. Cels carrying their callable on the
  // main thread (FormulaCels, JS lambdas) land in the "js" bucket;
  // wat lambdas in "wat", etc. The map preserves insertion order so
  // dispatch iteration is stable. Empty buckets aren't created — a
  // level with no py cels simply has no "py" key. Read sites should
  // tolerate missing kinds.
  const waveCascadeByKind = new Map<number, Map<Key, Key[]>[]>();
  for (const [wave, levels] of waveCascade) {
    const byKind: Map<Key, Key[]>[] = levels.map((level) => {
      const partition = new Map<Key, Key[]>();
      for (const key of level) {
        const cel = cels.get(key);
        if (!cel || !isFireable(cel)) continue;
        const k = kindOf(cel as FireableCel);
        let bucket = partition.get(k);
        if (!bucket) { bucket = []; partition.set(k, bucket); }
        bucket.push(key);
      }
      return partition;
    });
    waveCascadeByKind.set(wave, byKind);
  }

  const children = buildChildren(cels);
  const dynamicCascade = buildDynamicCascade(cels, children);

  // Channels — gather ChannelCels and (re)build each one's live
  // Channel. cel._channel always points at a fresh handler whose
  // closure captures the current cel-registry lookups for drain/dispose.
  const channels = new Map<Key, ChannelCel>();
  for (const cel of cels.values()) {
    if (cel.celType !== "ChannelCel") continue;
    const ccel = cel as ChannelCel;
    ccel._channel = buildChannel(ccel, state);
    channels.set(ccel.metadata.key, ccel);
  }

  // Segment graph — the SegmentCels (segments index + role lookup) and
  // the DERIVED cross-segment adjacency aggregated from live cel edges
  // AND dormant cels' edges (read from each SegmentCel's _dormant payload;
  // a dormant segment is still architecture, so its edges feed adjacency
  // and the one-direction rule). dormantKeys maps every dormant cel key
  // to its owning segment for the read/write paths.
  const { segments, segmentRoles } = buildSegmentIndexes(cels);
  const dormantKeys = buildDormantKeys(cels);
  const segmentAdjacency = buildSegmentAdjacency(cels);
  warnManifestDrift(state, cels, segmentAdjacency);

  // Re-resolve cel.schema caches. SchemaCel.v swaps need every cel
  // pointing at that key to pick up the new Schema struct; cheaper to
  // just walk all cels here than to thread a targeted refresh.
  resolveSchemas(state);

  // Invalidate per-cel runtime caches on fireable cels.
  for (const cel of cels.values()) {
    if (!isFireable(cel)) continue;
    if (cel._inputEntries    !== undefined) cel._inputEntries    = undefined;
    if (cel._channelHandlers !== undefined) cel._channelHandlers = undefined;
    if (cel._evaluate        !== undefined) cel._evaluate        = undefined;
  }

  state.precomputeGeneration = (state.precomputeGeneration ?? 0) + 1;

  const target = cels.get(PRECOMPUTED_STATES_KEY);
  if (target) {
    target.v = {
      waveCascade,
      sortedWaves,
      waveCascadeByKind,
      children,
      downstream: new Map(),
      dynamicCascade,
      channels,
      segments,
      segmentAdjacency,
      segmentRoles,
      dormantKeys,
    } satisfies PrecomputedIndexes;
  }

  void precomputeOptional(state);
};

// Children walks celDependencies (kernel/卜/graph.ts) — inputMap refs
// AND metadata.schema — so definition cels (lambdas, schemas, ranges)
// are first-class edges and the cascade reaches their consumers with
// no side-band usage indexes.
const buildChildren = (cels: Map<Key, Cel>): Map<Key, Set<Key>> => {
  const children = new Map<Key, Set<Key>>();
  for (const cel of cels.values()) {
    if (!isFireable(cel)) continue;
    for (const upstream of celDependencies(cel)) {
      let s = children.get(upstream);
      if (!s) { s = new Set(); children.set(upstream, s); }
      s.add(cel.metadata.key);
    }
  }
  return children;
};

// bfsDownstream moved to kernel/卜/graph.ts (graph queries).



const buildDynamicCascade = (
  cels: Map<Key, Cel>,
  children: Map<Key, Set<Key>>,
): Set<Key> => {
  const result = new Set<Key>();
  for (const [key, cel] of cels) {
    if (!isFireable(cel)) continue;
    if (!cel.dynamic) continue;
    result.add(key);
    const ds = bfsDownstream(key, children);
    for (const k of ds) result.add(k);
  }
  return result;
};

// ── Segment-level indexes ───────────────────────────────────────────────────

/** The SegmentCels: the `segments` name-set and the role lookup. */
const buildSegmentIndexes = (
  cels: Map<Key, Cel>,
): { segments: Set<Key>; segmentRoles: Map<Key, SegmentRole> } => {
  const segments = new Set<Key>();
  const segmentRoles = new Map<Key, SegmentRole>();
  for (const cel of cels.values()) {
    if (cel.celType !== "SegmentCel") continue;
    const m = (cel as SegmentCel).v;
    segments.add(m.name);
    if (m.role) segmentRoles.set(m.name, m.role);
  }
  return { segments, segmentRoles };
};

/** A cel-edge source: anything carrying metadata that can name edge
 *  targets. Awake cels and dormant DehydratedCels both fit (a
 *  DehydratedCel is metadata + key + celType — exactly what we read). */
type EdgeSource = { metadata: { segment?: Key } & Record<string, unknown> };

/** The three target-key sources a cel contributes to its segment's
 *  outgoing edges: inputMap values, metadata.imports (a single cel key —
 *  the wasm provider), and metadata.channel (an array of cel keys). Reads
 *  the same metadata shape on awake cels and dormant DehydratedCels. */
const edgeTargetKeys = (cel: EdgeSource): Key[] => {
  const md = cel.metadata as {
    inputMap?: Record<string, Key | Key[]>;
    imports?: Key;
    channel?: Key[];
  };
  const out: Key[] = [];
  if (md.inputMap) {
    for (const ref of Object.values(md.inputMap)) {
      if (Array.isArray(ref)) out.push(...ref);
      else out.push(ref);
    }
  }
  if (md.imports) out.push(md.imports);
  if (md.channel) out.push(...md.channel);
  return out;
};

/** DORMANT-key index: cel key → owning segment name, for every cel in a
 *  SegmentCel's _dormant payload. The live `state.cels` map holds no
 *  entry for these — this is how the read/write paths discover a key is
 *  dormant. */
const buildDormantKeys = (cels: Map<Key, Cel>): Map<Key, Key> => {
  const out = new Map<Key, Key>();
  for (const cel of cels.values()) {
    if (cel.celType !== "SegmentCel") continue;
    const payload = (cel as SegmentCel)._dormant;
    if (!payload) continue;
    for (const dc of payload.cels) out.set(dc.key, payload.name);
  }
  return out;
};

/** DERIVED cross-segment adjacency: source segment → segments it
 *  depends on. Aggregated from every AWAKE cel's LIVE metadata.segment
 *  AND every DORMANT cel's metadata (from the _dormant payloads) over
 *  inputMap / imports / channel edges; self-edges omitted. Dormant cels
 *  count: a dormant segment is still architecture, so its edges feed the
 *  one-direction rule. Edge targets resolve their segment from live cels
 *  first, then the dormant index (a dormant cel may point at another
 *  dormant cel). */
const buildSegmentAdjacency = (cels: Map<Key, Cel>): Map<Key, Set<Key>> => {
  const dormant = buildDormantKeys(cels);
  // Resolve a target key's owning segment: live cel wins, else dormant index.
  const segmentOf = (key: Key): Key | undefined =>
    cels.get(key)?.metadata.segment ?? dormant.get(key);

  const adj = new Map<Key, Set<Key>>();
  const addEdges = (from: Key | undefined, cel: EdgeSource): void => {
    if (from === undefined) return;
    for (const targetKey of edgeTargetKeys(cel)) {
      const to = segmentOf(targetKey);
      if (to === undefined || to === from) continue;
      let bucket = adj.get(from);
      if (!bucket) { bucket = new Set(); adj.set(from, bucket); }
      bucket.add(to);
    }
  };

  for (const cel of cels.values()) {
    addEdges(cel.metadata.segment, cel);
    // Dormant cels live on SegmentCels' payloads, not in state.cels.
    if (cel.celType === "SegmentCel") {
      const payload = (cel as SegmentCel)._dormant;
      if (payload) for (const dc of payload.cels) addEdges(dc.metadata.segment, dc);
    }
  }
  return adj;
};

/** Compare each SegmentCel's declared `dependencies` against the derived
 *  adjacency. Declared-but-unobserved is fine (manifests may over-declare
 *  for load ordering) and stays quiet; observed-but-undeclared warns
 *  (the manifest's dependency list has drifted from reality).
 *
 *  Deduped per State: precompute runs on every structural edit, and
 *  re-warning identical drift each time is both noise and a real
 *  main-thread cost in browsers (multi-line console.warn during the
 *  mutation→paint window). Warn only when the drift SET changes. */
const lastDriftWarning = new WeakMap<object, string>();
const warnManifestDrift = (
  state: State,
  cels: Map<Key, Cel>,
  adjacency: Map<Key, Set<Key>>,
): void => {
  const undeclared: string[] = [];
  for (const cel of cels.values()) {
    if (cel.celType !== "SegmentCel") continue;
    const m = (cel as SegmentCel).v;
    const declared = new Set(m.dependencies ?? []);
    const observed = adjacency.get(m.name);
    if (!observed) continue;
    for (const dep of observed) {
      if (!declared.has(dep)) undeclared.push(`${m.name} → ${dep}`);
    }
  }
  if (undeclared.length === 0) return;
  undeclared.sort();
  const fingerprint = undeclared.join("\n");
  if (lastDriftWarning.get(state) === fingerprint) return;
  lastDriftWarning.set(state, fingerprint);
  // eslint-disable-next-line no-console
  console?.warn?.(
    "precompute: segment dependency drift (observed cel edges not declared " +
    "in 冊.dependencies):\n" + undeclared.map((d) => "  - " + d).join("\n"),
  );
};

const topoLevels = (members: Key[], cels: Map<Key, Cel>): Key[][] => {
  const memberSet = new Set(members);
  return topoLevelsGeneric<Key>(
    members,
    (key) => {
      const cel = cels.get(key)!;
      if (!isFireable(cel)) return [];
      return celDependencies(cel);
    },
    { memberSet, cycleMessagePrefix: "Dependency cycle in cel graph" },
  );
};
