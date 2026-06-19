import type { Key, State } from "../../types/index.js";

// ============================================================================
// Accessor context — the segment of the currently-running cel.
//
// (The 访 segment-access GATE — per-segment get/set policies, bundles, the
// #DENIED read-denial choke point — was removed: the consent model gates io/code
// and the jail confines untrusted code, so in-process cross-segment isolation is
// redundant. What survives is the accessor STACK: the CONSENT runtime check reads
// the firing segment from it for per-segment consent.)
//
// The kernel pushes the accessor around every formula eval + handler dispatch.
// A per-State stack (module-level WeakMap) so independent States never
// cross-contaminate. An empty stack means "host / top-level".
// ============================================================================

/** The #DENIED sentinel — a tagged object host code can recognize across module
 *  copies. (Kept as a generic refusal value some paths still emit.) */
export const DENIED = Object.freeze({ "#DENIED": true }) as { readonly "#DENIED": true };
export const isDenied = (v: unknown): boolean =>
  typeof v === "object" && v !== null && (v as Record<string, unknown>)["#DENIED"] === true;

const accessorStacks = new WeakMap<State, Key[]>();
const stackFor = (state: State): Key[] => {
  let s = accessorStacks.get(state);
  if (!s) { s = []; accessorStacks.set(state, s); }
  return s;
};

/** The segment of the cel currently running, or undefined at top level. The
 *  consent runtime check reads this for per-segment consent. */
export const currentAccessor = (state: State): Key | undefined => {
  const s = accessorStacks.get(state);
  return s && s.length > 0 ? s[s.length - 1] : undefined;
};

/** Run `thunk` with `segment` pushed as the accessor. Sync — wraps the
 *  synchronous fire window. Always pops, even on throw. */
export const withAccessor = <T>(state: State, segment: Key | undefined, thunk: () => T): T => {
  if (segment === undefined) return thunk();
  const s = stackFor(state);
  s.push(segment);
  try { return thunk(); } finally { s.pop(); }
};
