import type {
  Cel, DehydratedCel, FireableCel, Fn, Key, SegmentCel, State, 甲骨, 冊,
} from "../../types/index.js";
import { isFireable } from "../cels.js";
import { disposeCel } from "../hydrate/cel.js";
import { compileFireable, inflateAllCels } from "../hydrate/segment.js";
import { resolveSchemas } from "../hydrate/schema.js";
import { applySchemaHydrate } from "../hydrate/value.js";
import { installMemoAndTrampolines } from "../hydrate/memo-install.js";
import { deflateCel } from "../dehydrate/cel.js";
import { flushChannels } from "../契/index.js";
import { precompute } from "../卜/precompute.js";
import { affectedFor, runCascade } from "../卜/runCycle.js";
import { getPrecomputedIndexes } from "../卜/graph.js";
import { resolveFn } from "../resolve-fn.js";
import { kernelClosureOf } from "./graph.js";
import { getSegmentManifest, segmentCelKeyOf } from "./cels.js";
import { flush } from "./flush.js";

// ============================================================================
// wake / sleep / forget — the three lifecycle verbs (design phase 3).
//
//   wake(state, name)      — inflate + compile a dormant segment plus its
//                            dormant dependency closure, settle once.
//                            Idempotent; async (compilers may be async).
//   sleep(state, name, o?) — dehydrate-in-place: _dispose each cel, deflate
//                            to a 甲骨 payload on the SegmentCel's _dormant,
//                            drop the live cels. Refuses when AWAKE
//                            dependents exist (per derived adjacency,
//                            reversed) unless { cascade: true }. Explicit.
//   forget(state, name, o?)— remove the SegmentCel + payload. On a dormant
//                            segment: optional persist-to-sink, delete,
//                            precompute. On an awake segment: sleep-then-
//                            forget (delegates to flush, which already owns
//                            the cel-walk teardown + dependents policy).
//
// Persistence sinks: a SegmentCel manifest may carry
// `sink: { kind, autoSave? }`. sleep/forget consult it; autoSave persists
// the payload via the resolved `store.put` fn cel before going dormant /
// forgotten. The kernel never imports the segment-store library — it
// resolves the fn through the cel registry and no-ops gracefully when
// absent.
//
// Design: docs/1-design/3-accepted/00-ontology/derived-activity-working-set.md
//   §"Verbs, not policy", §"Dehydration", §"What this costs".
// ============================================================================

// ── sink metadata (minimal — the full sink story matures in roadmap 06) ──────

/** Per-segment persistence sink, carried on the 冊 manifest. */
export interface SegmentSink {
  kind: "none" | "segment-store" | "opfs";
  /** When true, sleep/forget persist the payload before going dormant /
   *  forgotten. Default false. */
  autoSave?: boolean;
}

const sinkOf = (state: State, name: Key): SegmentSink | undefined =>
  (getSegmentManifest(state, name) as (冊 & { sink?: SegmentSink }) | undefined)?.sink;

/** Persist a segment's payload through its declared sink, if any, when
 *  autoSave is set. Reuses user-space-ops' machinery via the cel registry
 *  (`store.put`) — the kernel never imports 甲骨坑. No-ops gracefully when
 *  the sink is none/absent or the store fn isn't installed. */
const persistThroughSink = async (
  state: State, name: Key, payload: 甲骨,
): Promise<void> => {
  const sink = sinkOf(state, name);
  if (!sink || sink.kind === "none" || !sink.autoSave) return;
  // segment-store + opfs both land through the resolved store.put fn cel
  // today (opfs is the browser twin of the same store surface). Resolve it
  // off the registry; if absent, persistence silently degrades to none —
  // the dormant payload still lives in-state, just not externalized.
  const put = resolveFn(state, "store.put") as Fn | undefined;
  if (!put) return;
  const manifest = getSegmentManifest(state, name);
  if (!manifest) return;
  await put(state, name, manifest.version, manifest, payload);
};

// ── derived-graph dependents (segmentAdjacency REVERSED) ──────────────────────

/** Segments whose cels depend on `name` via ANY of the three edge kinds
 *  (inputMap / imports / channel), per the DERIVED segment adjacency — the
 *  reverse of `segmentAdjacency` (which maps source → its deps). Only AWAKE
 *  segments matter for sleep's refusal: a dormant dependent doesn't fire.
 *  Restricted to `awake` (segments with at least one live cel) so a dormant
 *  dependent — itself already inert — is never flagged. */
const awakeDependentsOf = (state: State, name: Key, awake: Set<Key>): Key[] => {
  const adj = getPrecomputedIndexes(state)?.segmentAdjacency;
  if (!adj) return [];
  const out: Key[] = [];
  for (const [source, deps] of adj) {
    if (source === name) continue;
    if (deps.has(name) && awake.has(source)) out.push(source);
  }
  return out;
};

/** Which segments are AWAKE: at least one live (non-SegmentCel) cel carries
 *  `metadata.segment === X`. A dormant segment has a SegmentCel but no live
 *  member cels, so it's absent from this set. */
const awakeSegments = (state: State): Set<Key> => {
  const out = new Set<Key>();
  for (const cel of state.cels.values()) {
    if (cel.celType === "SegmentCel") continue;
    const seg = cel.metadata.segment;
    if (seg !== undefined) out.add(seg);
  }
  return out;
};

// ── user-space SCC (strongly-connected user segments sleep as a unit) ─────────

/** The strongly-connected component of `name` over the derived adjacency,
 *  restricted to user-space-role members. The one-direction rule exempts
 *  user-space, so user⇄user cycles are legal — they sleep together as one
 *  node. For a code segment (no user-space cycles by construction) this is
 *  just `{ name }`. Computed as: nodes reachable forward from `name` (over
 *  user-space members) ∩ nodes that can reach `name`. */
const userSpaceSCC = (state: State, name: Key): Set<Key> => {
  const indexes = getPrecomputedIndexes(state);
  const adj = indexes?.segmentAdjacency;
  const roles = indexes?.segmentRoles;
  if (!adj || !roles || roles.get(name) !== "user-space") return new Set([name]);

  const isUser = (n: Key): boolean => roles.get(n) === "user-space";
  // Forward reachability over user-space members.
  const forward = new Set<Key>();
  const walk = (start: Key, next: (n: Key) => Iterable<Key>): void => {
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      if (forward.has(n)) continue;
      forward.add(n);
      for (const m of next(n)) if (isUser(m)) stack.push(m);
    }
  };
  walk(name, (n) => adj.get(n) ?? []);

  // Reverse adjacency (over user-space members only).
  const rev = new Map<Key, Key[]>();
  for (const [s, deps] of adj) {
    if (!isUser(s)) continue;
    for (const d of deps) {
      if (!isUser(d)) continue;
      (rev.get(d) ?? rev.set(d, []).get(d)!).push(s);
    }
  }
  const backward = new Set<Key>();
  const stack = [name];
  while (stack.length) {
    const n = stack.pop()!;
    if (backward.has(n)) continue;
    backward.add(n);
    for (const m of rev.get(n) ?? []) stack.push(m);
  }
  // SCC = forward ∩ backward.
  const scc = new Set<Key>([name]);
  for (const n of forward) if (backward.has(n)) scc.add(n);
  return scc;
};

// ── wake ──────────────────────────────────────────────────────────────────

/** The dormant dependency closure of `name`: `name` itself if dormant, plus
 *  every dormant segment it (transitively) depends on per the derived
 *  adjacency. Awake deps are already live and skipped. Cycles in user-space
 *  are absorbed by the visited-set (idempotent insertion). */
const dormantWakeClosure = (state: State, name: Key): Set<Key> => {
  const adj = getPrecomputedIndexes(state)?.segmentAdjacency;
  const out = new Set<Key>();
  const stack = [name];
  while (stack.length) {
    const n = stack.pop()!;
    if (out.has(n)) continue;
    const segCel = state.cels.get(segmentCelKeyOf(n)) as SegmentCel | undefined;
    // Only DORMANT segments wake — an awake dep is already live.
    if (!segCel?._dormant) continue;
    out.add(n);
    for (const dep of adj?.get(n) ?? []) stack.push(dep);
  }
  return out;
};

/** Inflate + compile a set of dormant segments' payloads into live cels.
 *  Mirrors hydrate's installCels two-step (inflate, then topo-compile) over
 *  the gathered 甲骨, REUSING `inflateAllCels` / `compileFireable` so the
 *  compile.cache softens recompiles (a re-wake of source-bearing cels hits
 *  the cache). The SegmentCels' `_dormant` fields are cleared as their cels
 *  go live. */
const inflateClosure = async (state: State, names: Set<Key>): Promise<甲骨[]> => {
  const payloads: 甲骨[] = [];
  for (const n of names) {
    const segCel = state.cels.get(segmentCelKeyOf(n)) as SegmentCel | undefined;
    const payload = segCel?._dormant;
    if (!payload) continue;
    payloads.push(payload);
  }
  inflateAllCels(state, payloads);
  await compileFireable(state, payloads);
  // Clear _dormant only after a successful inflate+compile — the cels are
  // now live and the SegmentCel is no longer dormant.
  for (const n of names) {
    const segCel = state.cels.get(segmentCelKeyOf(n)) as SegmentCel | undefined;
    if (segCel) segCel._dormant = undefined;
  }
  return payloads;
};

// ── pending external sources (函 url / store payloads) ────────────────────────

/** Coerce a fetched / stored value into a 甲骨 payload. Accepts a bare 甲骨
 *  (`{ name, cels }`), or a `{ segment: 甲骨 }` wrapper (segment-store's
 *  `store.get` shape `{ manifest, segment }`). Throws on anything else. */
const asPayload = (name: Key, raw: unknown, origin: string): 甲骨 => {
  const r = raw as { name?: unknown; cels?: unknown; segment?: unknown } | null;
  if (r && Array.isArray(r.cels) && typeof r.name === "string") return r as unknown as 甲骨;
  if (r && r.segment && Array.isArray((r.segment as { cels?: unknown }).cels)) {
    return r.segment as 甲骨;
  }
  throw new Error(
    `wake "${name}": ${origin} did not resolve to a 甲骨 payload ` +
    `({ name, cels } or { segment: { name, cels } }).`,
  );
};

/** Resolve one pending external payload source into a 甲骨 and hang it on the
 *  SegmentCel's `_dormant`, clearing `_pendingSource`. url → fetch + JSON;
 *  store → resolveFn'd `store.get`. The kernel never imports 甲骨坑 — store
 *  access goes through the cel registry and errors gracefully when the store
 *  library isn't installed. Inline/codeSeed never reach here (inline resolves
 *  to `_dormant` at 函-hydrate; codeSeed parks a bundled loader). Plain await.
 *
 *  Nesting refusal (DECIDED v1: no nesting): a payload that resolves to
 *  another 函 (a `{ version, boot, segments }` record) is unsupported — throw
 *  a clear message rather than recursing. */
const resolvePendingSource = async (state: State, name: Key): Promise<void> => {
  const segCel = state.cels.get(segmentCelKeyOf(name)) as SegmentCel | undefined;
  const source = segCel?._pendingSource;
  if (!segCel || !source) return;

  let payload: 甲骨;
  if ("url" in source) {
    if (typeof fetch !== "function") {
      throw new Error(`wake "${name}": payload source is a url but no global fetch is available.`);
    }
    const resp = await fetch(source.url);
    if (!resp.ok) {
      throw new Error(`wake "${name}": fetch ${source.url} failed (${resp.status} ${resp.statusText}).`);
    }
    const raw = await resp.json();
    assertNotNested(name, raw, `url ${source.url}`);
    payload = asPayload(name, raw, `url ${source.url}`);
  } else if ("store" in source) {
    const get = resolveFn(state, "store.get") as Fn | undefined;
    if (!get) {
      throw new Error(
        `wake "${name}": payload source is a segment-store ref but the ` +
        `segment-store library ("store.get") is not installed.`,
      );
    }
    const raw = await get(state, source.store.name, source.store.version);
    if (raw === undefined) {
      throw new Error(
        `wake "${name}": segment-store has no entry for "${source.store.name}"` +
        (source.store.version ? `@${source.store.version}` : "") + ".",
      );
    }
    assertNotNested(name, raw, `store ${source.store.name}`);
    payload = asPayload(name, raw, `store ${source.store.name}`);
  } else {
    // inline/codeSeed should never carry _pendingSource — defensive no-op.
    return;
  }

  // The resolved payload's cels must NOT be live; install dormant.
  for (const dc of payload.cels) state.cels.delete(dc.key);
  segCel._dormant = { name, cels: payload.cels };
  segCel._pendingSource = undefined;
};

/** Refuse a payload source that points at another 函 (nesting). DECIDED v1:
 *  no nesting — wake does not recurse into a nested application artifact. */
const assertNotNested = (name: Key, raw: unknown, origin: string): void => {
  const r = raw as { version?: unknown; boot?: unknown; segments?: unknown } | null;
  if (r && typeof r === "object" && "boot" in r && "segments" in r && Array.isArray(r.segments)) {
    throw new Error(
      `wake "${name}": ${origin} resolved to a 函 (application artifact), not a ` +
      `segment payload. 函 nesting is unsupported in v1 — a payload source may ` +
      `not point at another 函.`,
    );
  }
};

/** wake(state, name) — inflate + compile a dormant segment plus its dormant
 *  dependency closure, run the hydrate post-install passes, then ONE settle
 *  cascade over the woken cels so their formulas recompute against current
 *  inputs. Idempotent: waking an awake segment (no `_dormant`) is a no-op.
 *
 *  Settle choice (documented): `runCascade` over the woken fireable keys +
 *  their downstream — cheaper than a full `runCycle` (which re-fires every
 *  cel in the graph) and sufficient, since only the just-woken formulas
 *  lack a value computed against the current awake inputs. */
export const wake: Fn = async (state: State, name: Key): Promise<State> => {
  // First wake of an external-source segment: resolve its pending payload
  // (url fetch / store.get) into `_dormant` so the closure walk sees its
  // edges. Resolution may surface MORE pending-source deps as the adjacency
  // grows — iterate to a fixed point, precomputing so each newly-installed
  // `_dormant` joins segmentAdjacency before the next closure walk. Bounded
  // by the segment count (each pass resolves ≥1 new source or stops).
  let pendingResolved = false;
  for (;;) {
    const segCel = state.cels.get(segmentCelKeyOf(name)) as SegmentCel | undefined;
    if (segCel?._pendingSource) { await resolvePendingSource(state, name); pendingResolved = true; }
    // Any pending-source segment reachable from the (now richer) closure.
    if (pendingResolved) precompute(state);
    const closurePeek = dormantWakeClosure(state, name);
    let progressed = false;
    for (const n of closurePeek) {
      const c = state.cels.get(segmentCelKeyOf(n)) as SegmentCel | undefined;
      if (c?._pendingSource) { await resolvePendingSource(state, n); progressed = true; pendingResolved = true; }
    }
    if (!progressed) break;
    precompute(state);
  }
  if (pendingResolved) precompute(state);

  const closure = dormantWakeClosure(state, name);
  if (closure.size === 0) return state; // already awake (or unknown) — no-op.

  const payloads = await inflateClosure(state, closure);

  // Hydrate post-install passes (mirror loadSegment / hydrate's tail).
  resolveSchemas(state);
  applySchemaHydrate(state);
  installMemoAndTrampolines(state);
  precompute(state);

  // One settle cascade over the woken cels: their downstream PLUS the woken
  // fireable cels themselves (affectedFor returns only downstream of the
  // seeds; the woken formulas need to fire to compute against live inputs).
  const wokenKeys: Key[] = [];
  for (const p of payloads) for (const dc of p.cels) wokenKeys.push(dc.key);
  const affected = affectedFor(state, wokenKeys);
  for (const k of wokenKeys) {
    const cel = state.cels.get(k);
    if (cel && isFireable(cel)) affected.add(k);
  }
  await runCascade(state, affected, undefined);
  return state;
};

// ── sleep ──────────────────────────────────────────────────────────────────

export interface SleepOptions {
  /** Sleep awake dependents first (leaves-first over the derived graph)
   *  rather than refusing. Default false. */
  cascade?: boolean;
}

/** A native-bodied cel (a code seed: _fn bound, no `f` source) cannot be
 *  reconstructed from a deflated payload — wake-from-payload re-inflates
 *  from data only. Sleeping such a cel would lose it. v1 REFUSES (honest
 *  over lossy): a segment carrying any native-bodied cel can't sleep. */
const isNativeBodied = (cel: Cel): boolean => {
  if (isFireable(cel)) {
    const fc = cel as FireableCel;
    return fc._fn !== undefined && fc.f === undefined;
  }
  if (cel.celType === "CompilerCel") {
    return typeof cel.v === "function" && cel.f === undefined;
  }
  return false;
};

/** The live (non-SegmentCel) cels owned by `name`. */
const liveCelsOf = (state: State, name: Key): Cel[] => {
  const out: Cel[] = [];
  for (const cel of state.cels.values()) {
    if (cel.celType === "SegmentCel") continue;
    if (cel.metadata.segment === name) out.push(cel);
  }
  return out;
};

/** Deflate one awake segment's live cels to a 甲骨 payload and drop them.
 *  Fires _dispose per cel (lambda-side + schema-side cleanup), then deletes.
 *  The SegmentCel stays (it's the manifest); its `_dormant` is set to the
 *  payload. Native-bodied cels are refused upstream — every cel here is
 *  deflatable. Painter teardown for view mounts happens in `sleep` BEFORE
 *  the final channel drain, so it is not done here. */
const sleepOne = (state: State, name: Key): void => {
  const liveCels = liveCelsOf(state, name);
  const cels: DehydratedCel[] = [];
  for (const cel of liveCels) {
    cels.push(deflateCel(cel, state));
    disposeCel(cel, state);
  }
  for (const cel of liveCels) state.cels.delete(cel.metadata.key);

  const segCel = state.cels.get(segmentCelKeyOf(name)) as SegmentCel | undefined;
  if (segCel) segCel._dormant = { name, cels };
};

/** sleep(state, name, opts?) — dehydrate a segment in place: refuse when
 *  awake dependents exist (naming them) unless { cascade: true }, which
 *  sleeps dependents first (leaves-first). Native-bodied (code-seed) cels
 *  refuse (honest over lossy — wake-from-payload would lose them). The
 *  kernel segment never sleeps. Explicit only; consults the sink (autoSave
 *  persists the payload). User-space SCCs sleep as a unit. */
export const sleep: Fn = async (
  state: State, name: Key, opts: SleepOptions = {},
): Promise<State> => {
  // Kernel-closure guard: kernel + transitively-kernel segments never sleep.
  const kernelSet = kernelClosureOf(state);
  if (kernelSet.has(name)) {
    throw new Error(
      `sleep "${name}": segment is part of the kernel closure ` +
      `(role:"kernel" or transitively depended on by one); refused.`,
    );
  }

  const awake = awakeSegments(state);
  if (!awake.has(name)) return state; // already dormant / no live cels — no-op.

  // The unit that sleeps together: the user-space SCC of `name` (just
  // `{ name }` for code segments). Dependents / native-body checks treat
  // the SCC as one node.
  const unit = userSpaceSCC(state, name);

  // Refuse-with-list (DECIDED default) when AWAKE dependents OUTSIDE the unit
  // exist, unless cascade. Dependents are per the reversed derived adjacency.
  const dependents = new Set<Key>();
  for (const member of unit) {
    for (const dep of awakeDependentsOf(state, member, awake)) {
      if (!unit.has(dep)) dependents.add(dep);
    }
  }
  if (dependents.size > 0 && !opts.cascade) {
    throw new Error(
      `sleep "${name}": awake dependents still loaded: ` +
      [...dependents].join(", ") +
      `. Pass { cascade: true } to sleep dependents first.`,
    );
  }

  if (opts.cascade && dependents.size > 0) {
    // Leaves-first: sleep each dependent before the target. Each recursive
    // sleep re-applies the policy at its own level (a chain settles bottom
    // up). Idempotent on already-slept segments.
    for (const dep of dependents) {
      await (sleep as Fn)(state, dep, { cascade: true });
    }
  }

  // Native-body refusal — check every member of the unit before mutating.
  for (const member of unit) {
    for (const cel of state.cels.values()) {
      if (cel.celType === "SegmentCel") continue;
      if (cel.metadata.segment !== member) continue;
      if (isNativeBodied(cel)) {
        throw new Error(
          `sleep "${member}": cel "${cel.metadata.key}" is native-bodied ` +
          `(a code seed: bound fn, no serializable source) — sleeping it ` +
          `would lose it on wake-from-payload. v1 refuses to sleep segments ` +
          `containing native-bodied cels (honest over lossy).`,
        );
      }
    }
  }

  // Painter empty-spec teardown for the unit's view cels at their vacated
  // mounts — enqueued onto the paint channel BEFORE the drain so the
  // teardown specs reach the painter while the cels (and their last
  // RenderSpec + mount) are still live. Off-browser-safe.
  for (const member of unit) tearDownViewMounts(state, liveCelsOf(state, member));

  // Drain channels to fixed point before deleting any cel — a queued
  // {cel, state} for a soon-to-be-removed cel would otherwise commit a
  // write for a cel no longer in state.cels (mirrors flush). This ALSO
  // forwards the teardown specs above to the painter.
  await flushChannels(state, "all");

  // Sleep every member of the unit (deflate + drop), then ONE precompute.
  for (const member of unit) {
    const segCel = state.cels.get(segmentCelKeyOf(member)) as SegmentCel | undefined;
    if (!segCel || segCel._dormant) continue; // already dormant — skip.
    sleepOne(state, member);
    // autoSave: persist the freshly-built payload through the sink.
    if (segCel._dormant) await persistThroughSink(state, member, segCel._dormant);
  }
  precompute(state);
  return state;
};

// ── forget ──────────────────────────────────────────────────────────────────

export interface ForgetOptions {
  /** Sleep awake dependents first when forgetting an awake segment.
   *  Forwarded to the underlying flush as { cascade: true }. Default false. */
  cascade?: boolean;
}

/** forget(state, name, opts?) — remove a segment from state entirely.
 *
 *  On a DORMANT segment: optional persist-to-sink, then delete the
 *  SegmentCel (+ its `_dormant`) and precompute.
 *
 *  On an AWAKE segment: delegate to `flush` (which owns the cel-walk
 *  teardown, channel drain, dependents policy, and kernel-closure guard) —
 *  this IS sleep-then-forget reduced to a single teardown. The eventual
 *  dedup (forget fully subsumes flush) is noted in the roadmap.
 *
 *  Kernel-closure guard stays (delegated to flush on the awake path,
 *  enforced directly on the dormant path). */
export const forget: Fn = async (
  state: State, name: Key, opts: ForgetOptions = {},
): Promise<State> => {
  const segCel = state.cels.get(segmentCelKeyOf(name)) as SegmentCel | undefined;
  const isDormant = segCel?._dormant !== undefined;

  if (!isDormant) {
    // Awake (or no live cels): flush owns the teardown + dependents policy
    // + kernel-closure guard. cascade maps straight through.
    return (flush as Fn)(state, name, { cascade: opts.cascade }) as Promise<State>;
  }

  // Dormant path: kernel-closure guard (a dormant kernel segment can't
  // happen — kernel never sleeps — but guard anyway for symmetry).
  const kernelSet = kernelClosureOf(state);
  if (kernelSet.has(name)) {
    throw new Error(
      `forget "${name}": segment is part of the kernel closure; refused.`,
    );
  }
  // Optional persist-to-sink before discarding.
  if (segCel?._dormant) await persistThroughSink(state, name, segCel._dormant);
  state.cels.delete(segmentCelKeyOf(name));
  precompute(state);
  return state;
};

// ── painter empty-spec teardown ──────────────────────────────────────────────

/** Tear down the mounted DOM for a sleeping segment's view cels WITHOUT
 *  kernel→甲骨坑 coupling. A view cel declares `metadata.channel` containing
 *  the paint channel and its last value is a RenderSpec carrying a non-null
 *  mount. We enqueue an empty spec ({ vnode: null-ish, mount, listeners: [] })
 *  onto that channel and drain it: the painter diffs the prior tree → an
 *  empty tree (removal patch) at the vacated mount. The painter and its
 *  RenderSpec type are NOT imported here — we route through the existing
 *  ChannelCel the cel already names, so the kernel stays decoupled.
 *
 *  Off-browser-safe: drain forwards to the painter, which records the patch
 *  but skips DOM mutation when no document is present (tests inspect via
 *  lastPatch). Best-effort: silently skips cels with no paint channel, no
 *  RenderSpec value, or a null mount. */
const PAINT_CHANNEL = "plastron-dom.paint" as const;

const tearDownViewMounts = (state: State, liveCels: Cel[]): void => {
  for (const cel of liveCels) {
    if (!isFireable(cel)) continue;
    const channels = cel.metadata.channel;
    if (!channels || !channels.includes(PAINT_CHANNEL)) continue;
    const spec = cel.v as { vnode?: unknown; mount?: string | null } | undefined;
    if (!spec || typeof spec !== "object" || !("mount" in spec)) continue;
    const mount = spec.mount ?? null;
    if (mount === null) continue;
    const channelCel = state.cels.get(PAINT_CHANNEL);
    const channel = (channelCel as { _channel?: { enqueue: (a: unknown) => void } } | undefined)?._channel;
    if (!channel) continue;
    // An empty spec at the same mount: the painter diffs prev → empty and
    // removes the subtree. We hand a transient cel-shaped carrier whose `v`
    // is the empty spec; paintDrain reads `cel.v`. vnode is an empty text
    // node (a null vnode would make the diff a no-op against an existing
    // tree in some paths; an empty text is the minimal "render nothing").
    const emptySpec = { vnode: { type: "text", text: "" }, mount, listeners: [] };
    const carrier = { metadata: { key: cel.metadata.key }, v: emptySpec } as unknown as Cel;
    channel.enqueue({ cel: carrier, state });
  }
};

// Re-exported so other kernel modules can read the sink shape.
export type { SegmentSink as Sink };
