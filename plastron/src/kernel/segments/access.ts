import type { Cel, Key, State, ValueCel } from "../../types/index.js";

// ============================================================================
// Segment access capabilities — Layer 1 (in-process closures).
//
// Every segment carries an ACCESS POLICY: two lists, `get` (who may read
// its cels) and `set` (who may write them). Each is `"public"` (any
// segment), `"private"` (self only), or an explicit segment allowlist
// (those + self). A direction may be SEALED — the declared list is
// authoritative and no bundle grant can widen it.
//
// DEFAULT: { get: "public", set: "private" }. Anyone reads; only the
// segment itself writes. The hot path short-circuits on a public target.
//
// Two choke points enforce it against the ACCESSOR — the segment of the
// currently-running cel:
//   • READ  (formula dep resolution): accessor A reading Y@B succeeds
//     iff A ∈ B.get; else the resolved input becomes a #DENIED sentinel
//     cel (no edge to the real value ever forms — the formula closure
//     captures the sentinel, not B).
//   • WRITE (setValue / setCel): A writing Y@B succeeds iff A ∈ B.set;
//     else the write is refused.
//
// Policy lives in a per-segment cel `访.<segment>` (inspectable /
// dehydratable / reactive), default-synthesized. Bundles (named sets of
// segments that may get/set each other, except where a member sealed a
// direction) live in a single registry cel `access.bundles`.
// ============================================================================

/** A direction's allowlist. `"public"` = any accessor; `"private"` =
 *  self only; an array = those segments plus self. */
export type AccessList = "public" | "private" | Key[];

export interface AccessPolicy {
  get: AccessList;
  set: AccessList;
  /** When true, no bundle grant widens the get direction. */
  getSealed?: boolean;
  /** When true, no bundle grant widens the set direction. */
  setSealed?: boolean;
}

/** The default every un-declared segment gets: world-readable,
 *  self-writable. */
export const DEFAULT_POLICY: AccessPolicy = { get: "public", set: "private" };

const POLICY_PREFIX = "访." as const;
/** Cel key for a segment's access-policy cel. */
export const accessPolicyKeyOf = (segment: Key): Key => `${POLICY_PREFIX}${segment}`;

/** Reserved cel key: ValueCel whose v is the bundle registry —
 *  Array<Set<Key>>, one Set per bundle group. */
export const ACCESS_BUNDLES_KEY = "access.bundles" as const;

/** The #DENIED sentinel — the value a denied read resolves to. A plain
 *  tagged object so formulas and host code can recognize it without a
 *  shared class identity across module copies. */
export const DENIED = Object.freeze({ "#DENIED": true }) as { readonly "#DENIED": true };

export const isDenied = (v: unknown): boolean =>
  typeof v === "object" && v !== null && (v as Record<string, unknown>)["#DENIED"] === true;

// ── accessor context ─────────────────────────────────────────────────────────
//
// The ACCESSOR is the segment of the currently-running cel. The kernel
// pushes it around every formula eval + handler dispatch; setValue /
// setCel read the top of the stack to attribute a write. A per-State
// stack (module-level WeakMap, like runCycle's cascadeGuards) so
// independent States never cross-contaminate. An empty stack means
// "host / top-level" — privileged, every check passes (a test or host
// calling setValue directly is not sandboxed).

const accessorStacks = new WeakMap<State, Key[]>();

const stackFor = (state: State): Key[] => {
  let s = accessorStacks.get(state);
  if (!s) { s = []; accessorStacks.set(state, s); }
  return s;
};

/** The segment of the cel currently running, or undefined at top level. */
export const currentAccessor = (state: State): Key | undefined => {
  const s = accessorStacks.get(state);
  return s && s.length > 0 ? s[s.length - 1] : undefined;
};

/** Run `thunk` with `segment` pushed as the accessor. Sync — the kernel
 *  wraps the synchronous fire window (an async cel initiates its IO in
 *  that window, like the _currentCel provenance). Always pops, even on
 *  throw. */
export const withAccessor = <T>(state: State, segment: Key | undefined, thunk: () => T): T => {
  if (segment === undefined) return thunk();
  const s = stackFor(state);
  s.push(segment);
  try { return thunk(); } finally { s.pop(); }
};

// ── policy resolution ────────────────────────────────────────────────────────

/** True when a segment has explicitly DECLARED an access policy (a
 *  `访.<segment>` cel exists). A segment that hasn't opted in is
 *  unrestricted — both choke points pass through. This is the back-compat
 *  pivot: the design's nominal default is get-public / set-private, but
 *  ENFORCING set-private on every undeclared segment would refuse the
 *  cross-segment writes the existing graph relies on (a handler in one
 *  segment committing cels into another). Layer 1 enforces only what a
 *  segment opted into; an undeclared segment behaves exactly as before. */
export const hasDeclaredPolicy = (state: State, segment: Key): boolean =>
  state.cels.has(accessPolicyKeyOf(segment));

/** Read a segment's declared access policy, or the default when none is
 *  declared. Always returns a fully-populated policy (get/set present). */
export const accessPolicyOf = (state: State, segment: Key): AccessPolicy => {
  const cel = state.cels.get(accessPolicyKeyOf(segment));
  const declared = cel?.v as Partial<AccessPolicy> | undefined;
  if (!declared) return DEFAULT_POLICY;
  return {
    get: declared.get ?? DEFAULT_POLICY.get,
    set: declared.set ?? DEFAULT_POLICY.set,
    getSealed: declared.getSealed,
    setSealed: declared.setSealed,
  };
};

/** Create or replace a segment's access-policy cel. A locked-free
 *  definition-plane cel so hosts can inspect / dehydrate it. */
export const setAccessPolicy = (state: State, segment: Key, policy: Partial<AccessPolicy>): void => {
  const key = accessPolicyKeyOf(segment);
  const cel: ValueCel = {
    celType: "ValueCel",
    metadata: { key, segment },
    v: { ...accessPolicyOf(state, segment), ...policy },
    locked: false,
  };
  state.cels.set(key, cel);
};

// ── bundles ──────────────────────────────────────────────────────────────────

const readBundles = (state: State): Array<Set<Key>> => {
  const cel = state.cels.get(ACCESS_BUNDLES_KEY);
  return (cel?.v as Array<Set<Key>> | undefined) ?? [];
};

/** True when A and B share at least one bundle group. */
const bundledTogether = (state: State, a: Key, b: Key): boolean => {
  for (const group of readBundles(state)) {
    if (group.has(a) && group.has(b)) return true;
  }
  return false;
};

/** Grant a bundle: every listed segment may get/set every other listed
 *  segment, EXCEPT where a member sealed that direction. Merges into the
 *  existing registry (a segment may belong to many bundles). */
export const bundleSegments = (state: State, segments: Key[]): void => {
  const group = new Set<Key>(segments);
  const cel = state.cels.get(ACCESS_BUNDLES_KEY);
  if (cel) {
    (cel.v as Array<Set<Key>>).push(group);
    return;
  }
  const fresh: ValueCel = {
    celType: "ValueCel",
    metadata: { key: ACCESS_BUNDLES_KEY, segment: "kernel" },
    v: [group] as Array<Set<Key>>,
    locked: true,
  };
  state.cels.set(ACCESS_BUNDLES_KEY, fresh);
};

// ── the two predicates ───────────────────────────────────────────────────────

const listAllows = (list: AccessList, accessor: Key): boolean => {
  if (list === "public") return true;
  if (list === "private") return false;
  return list.includes(accessor);
};

/** May accessor A read a cel in segment B? Self always may. A public get
 *  short-circuits (the common case). An explicit-list member may. A
 *  bundle peer may UNLESS B sealed its get direction. */
export const canGet = (state: State, accessor: Key | undefined, target: Key): boolean => {
  if (accessor === undefined) return true;       // host / top-level — privileged
  if (accessor === target) return true;          // self
  if (!hasDeclaredPolicy(state, target)) return true;  // undeclared — unrestricted
  const policy = accessPolicyOf(state, target);
  if (policy.get === "public") return true;       // hot-path short-circuit
  if (listAllows(policy.get, accessor)) return true;
  if (!policy.getSealed && bundledTogether(state, accessor, target)) return true;
  return false;
};

/** May accessor A write a cel in segment B? Same shape as canGet over
 *  the set direction. */
export const canSet = (state: State, accessor: Key | undefined, target: Key): boolean => {
  if (accessor === undefined) return true;       // host / top-level — privileged
  if (accessor === target) return true;          // self
  if (!hasDeclaredPolicy(state, target)) return true;  // undeclared — unrestricted
  const policy = accessPolicyOf(state, target);
  if (policy.set === "public") return true;
  if (listAllows(policy.set, accessor)) return true;
  if (!policy.setSealed && bundledTogether(state, accessor, target)) return true;
  return false;
};

// ── the #DENIED sentinel cel ───────────────────────────────────────────────
//
// When a read is denied, the consumer's resolved input is swapped for
// this cel rather than the real one. Its v is the DENIED sentinel, so
// the formula closure (which captured this cel) reads #DENIED — and the
// edge to the real value never forms.

/** A frozen ValueCel whose v is the DENIED sentinel, namespaced per
 *  denied target key so it reads as the right "slot" but carries no real
 *  value. Cached on the state so repeated resolutions reuse one object. */
const DENIED_CELS = new WeakMap<State, Map<Key, Cel>>();

export const deniedCel = (state: State, key: Key): Cel => {
  let perState = DENIED_CELS.get(state);
  if (!perState) { perState = new Map(); DENIED_CELS.set(state, perState); }
  let cel = perState.get(key);
  if (!cel) {
    cel = {
      celType: "ValueCel",
      metadata: { key, segment: "#DENIED" },
      v: DENIED,
      locked: true,
    } satisfies ValueCel;
    perState.set(key, cel);
  }
  return cel;
};

/** Resolve an input cel for a consumer, applying the GET choke point.
 *  Returns the live cel when the accessor may read it, the #DENIED
 *  sentinel cel when it may not, or undefined when the key is absent.
 *  This is the ONE place input refs become cels — precompute, the
 *  runCycle fallback, and recompile all route through it so the closure
 *  captures the right (real-or-sentinel) cel. */
export const resolveInputCel = (
  state: State, accessorSegment: Key, refKey: Key,
): Cel | undefined => {
  const cel = state.cels.get(refKey);
  if (cel === undefined) return undefined;
  if (canGet(state, accessorSegment, cel.metadata.segment)) return cel;
  return deniedCel(state, refKey);
};
