import type { Key, State, ValueCel } from "../../types/index.js";

// ============================================================================
// Capability trust — quarantine, Layer-B. A companion to the 访 access policy
// (access.ts): where 访 governs WHICH SEGMENTS a cel may reach, trust governs
// WHICH CAPABILITIES it may use. Two grant tiers — kernel and segment — each a
// `信.<scope>` ValueCel (inspectable / dehydratable, like `访.<segment>`). A
// cel's *request* is not stored here; it comes from its formula's `(needs …)`.
//
// granted(cap) = kernel ∧ segment.   Default (no 信. cel) = FULL — so the
// top-level session and every existing test are unrestricted; quarantine is
// opt-in (origin stamps a spawned / URL child kernel LOCKED at the kernel tier).
// See docs/1-design/1-under-consideration/quarantine.md.
// ============================================================================

/** A capability quarantine gates. dom/cels/arithmetic are ungated non-threats. */
export type Capability = "code" | "net" | "storage" | "secrets";

/** A per-capability grant object, default all off ("locked"). `segments` is a
 *  cross-segment reach whitelist layered on the 访 access policy. */
export interface Trust {
  code?: boolean;
  net?: boolean;
  storage?: boolean;
  secrets?: boolean;
  segments?: Key[];
}

export const CAPABILITIES: readonly Capability[] = ["code", "net", "storage", "secrets"];

/** The implicit default when no 信. cel is declared — fully trusted (no
 *  regression for the top-level kernel). */
export const FULL_TRUST: Trust = Object.freeze({ code: true, net: true, storage: true, secrets: true });
/** Everything off + reach nothing — what origin stamps a URL/spawned child. */
export const LOCKED_TRUST: Trust = Object.freeze({ code: false, net: false, storage: false, secrets: false, segments: [] });

const TRUST_PREFIX = "信." as const;
/** The kernel-tier (whole-instance) trust cel key. */
export const TRUST_KERNEL_KEY = `${TRUST_PREFIX}kernel` as const;
/** A segment's trust cel key. */
export const trustKeyOf = (segment: Key): Key => `${TRUST_PREFIX}${segment}`;

const declaredTrust = (state: State, key: Key): Partial<Trust> | undefined => {
  const v = state.cels.get(key)?.v;
  return v && typeof v === "object" ? (v as Partial<Trust>) : undefined;
};

/** meet — `child` narrows `parent`. An absent child cap inherits the parent;
 *  a present cap is ANDed (so a child can never WIDEN — monotonic). `segments`
 *  intersect (absent parent = all). */
const meet = (parent: Trust, child: Partial<Trust> | undefined): Trust => {
  if (!child) return parent;
  const out: Trust = { ...parent };
  for (const c of CAPABILITIES) {
    if (child[c] !== undefined) out[c] = (parent[c] ?? true) && (child[c] as boolean);
  }
  if (child.segments !== undefined) {
    out.segments = parent.segments === undefined
      ? [...child.segments]
      : parent.segments.filter((s) => child.segments!.includes(s));
  }
  return out;
};

/** Kernel-tier trust — FULL unless a `信.kernel` cel narrows it. */
export const kernelTrust = (state: State): Trust => meet(FULL_TRUST, declaredTrust(state, TRUST_KERNEL_KEY));

/** The effective grant for a segment: kernel ∧ segment. `undefined` (top-level
 *  / host) gets the kernel tier. */
export const resolveTrust = (state: State, segment: Key | undefined): Trust => {
  const base = kernelTrust(state);
  return segment === undefined ? base : meet(base, declaredTrust(state, trustKeyOf(segment)));
};

/** Does the accessor segment hold capability `cap`? */
export const canUse = (state: State, accessor: Key | undefined, cap: Capability): boolean =>
  resolveTrust(state, accessor)[cap] !== false;

/** May `accessor` reach `target` per the trust whitelist? (The 访 access policy
 *  is a separate, ANDed gate.) `segments` absent → no trust restriction. */
export const trustAllowsReach = (state: State, accessor: Key | undefined, target: Key): boolean => {
  if (accessor === undefined || accessor === target) return true;
  const { segments } = resolveTrust(state, accessor);
  return segments === undefined || segments.includes(target);
};

/** Create / narrow a trust cel. `target` is "kernel" (the kernel tier) or a
 *  segment name. A locked-free definition cel — inspectable / dehydratable. */
export const setTrust = (state: State, target: Key, trust: Partial<Trust>): void => {
  const key = target === "kernel" ? TRUST_KERNEL_KEY : trustKeyOf(target);
  const prior = declaredTrust(state, key) ?? {};
  const cel: ValueCel = { celType: "ValueCel", metadata: { key, segment: target }, v: { ...prior, ...trust }, locked: false };
  state.cels.set(key, cel);
};

const NEEDS_RE = /\(\s*needs\b([^)]*)\)/g;
/** Statically read `(needs "net" "storage" "seg:clients")` declarations from
 *  formula source into a requested-capability partial — extracted BEFORE the
 *  body runs (like extractDeps), computationally inert. */
export const extractNeeds = (source: string): Partial<Trust> => {
  const req: Partial<Trust> = {};
  const segs: string[] = [];
  let m: RegExpExecArray | null;
  NEEDS_RE.lastIndex = 0;
  while ((m = NEEDS_RE.exec(source))) {
    for (const raw of m[1]!.match(/["']([^"']+)["']/g) ?? []) {
      const t = raw.slice(1, -1);
      if ((CAPABILITIES as readonly string[]).includes(t)) req[t as Capability] = true;
      else if (t.startsWith("seg:")) segs.push(t.slice(4));
    }
  }
  if (segs.length) req.segments = segs;
  return req;
};

/** Which requested capabilities are NOT covered by `granted` — the set the user
 *  must approve (the grant-delta) before the formula may run. */
export const grantDelta = (requested: Partial<Trust>, granted: Trust): Capability[] =>
  CAPABILITIES.filter((c) => requested[c] === true && granted[c] !== true);
