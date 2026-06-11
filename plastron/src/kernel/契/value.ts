import type { Fn, Key, State } from "../../types/index.js";
import type { SetOpts } from "../../types/index.js";
import { isDataCel } from "../cels.js";
import { affectedFor, runCascade } from "../卜/runCycle.js";
import { settleStructural } from "./settle.js";
import { resolveFn } from "../resolve-fn.js";
import { precompute } from "../卜/precompute.js";

// Post-mutation observer hook. A host capability (the p2p peer transport) can
// register "cascade.observe" to react to the keys a host just WROTE (the seed
// keys, not derived cascade values — a remote recomputes its own derived). No
// observer registered → skipped (zero cost beyond a registry lookup). An
// observer error must never break the write.
const observeMutation = (state: State, keys: Key[]): void => {
  const obs = resolveFn(state, "cascade.observe") as Fn | undefined;
  if (obs) { try { void obs(state, keys); } catch { /* observer is best-effort */ } }
};
import { compileCelBody } from "../hydrate/formula.js";
import { flushChannels } from "./flush-channels.js";
import { assertNotDormant, dormantSegmentOf, dormantView } from "../segments/dormant.js";
import { canSet, currentAccessor } from "../segments/access.js";

// ============================================================================
// Data-plane writes — the recalc tier.
//
// setValue writes the cels that hold the application's data: a
// ValueCel's v, or a FormulaCel's f (its source IS its content — the
// spreadsheet gesture). Only DataCels (Value | Formula) are writable
// here; definition cels (lambdas, schemas, compilers, channels, named
// ranges) are replaced wholesale via setCel — the tiers are mutually
// exclusive by construction, so a setValue can trigger recalculation
// but never a consumer recompile.
//
// A FormulaCel f-write recompiles THAT cel (its own body changed) and
// re-runs precompute (its dependency set may have shifted) — but its
// consumers only ever recalculate: nothing compiles against a formula.
//
// Reads: getCel is the one read — it returns the live Cel; callers
// take .v (or .f, .metadata) from there.
//
// Atomicity: setValueBatch validates every write before any mutation.
// ============================================================================

// getCel — the one read. Returns the live Cel for an awake key, or a
// read-only VIEW reconstructed from the dehydrated record for a dormant
// key (no inflation, no caching — dormant cels are absent from state.cels).
// Unknown keys return undefined (the dormant lookup doesn't change that).
export const getCel: Fn = (state: State, key: Key) => {
  const live = state.cels.get(key);
  if (live) return live;
  const segment = dormantSegmentOf(state, key);
  if (segment !== undefined) return dormantView(state, key, segment);
  return undefined;
};

const validateValueWrite = (
  state: State, key: Key, value: unknown, label: string,
): void => {
  // Dormant cels are read-only — a write throws naming the cel + segment.
  assertNotDormant(state, key, label);
  const cel = state.cels.get(key);
  if (!cel)        throw new Error(`${label}: unknown cel "${key}"`);
  if (cel.locked)  throw new Error(`${label}: cel "${key}" is locked`);
  // SET choke point — the accessor (running cel's segment) must be in the
  // target segment's set-list. Top-level/host (no accessor) is privileged.
  const accessor = currentAccessor(state);
  if (!canSet(state, accessor, cel.metadata.segment)) {
    throw new Error(
      `${label}: segment "${accessor}" may not write cel "${key}" in ` +
      `segment "${cel.metadata.segment}" (set policy refuses it)`,
    );
  }
  if (!isDataCel(cel)) {
    throw new Error(
      `${label}: cel "${key}" is a ${cel.celType} — definitions are replaced via setCel`,
    );
  }
  if (cel.celType === "FormulaCel" && typeof value !== "string") {
    throw new Error(
      `${label}: FormulaCel "${key}" takes formula source (a string); got ${typeof value}`,
    );
  }
};

// Apply one validated write. Returns true when the write was a formula
// f-edit (the caller owes a precompute before its cascade).
const applyValueWrite = async (
  state: State, key: Key, value: unknown,
): Promise<boolean> => {
  const cel = state.cels.get(key)!;
  if (cel.celType === "ValueCel") {
    cel.v = value;
    return false;
  }
  // FormulaCel — the data IS the source. Recompile in place; prune
  // auto-wired deps the new source no longer references.
  const fcel = cel as Extract<typeof cel, { celType: "FormulaCel" }>;
  if (fcel._dispose) { try { fcel._dispose(); } catch { /* swallow */ } }
  fcel._dispose = undefined;
  fcel._fn = undefined;
  fcel._buildEvaluate = undefined;
  fcel._evaluate = undefined;
  fcel._inputEntries = undefined;
  if (fcel._memoCache) fcel._memoCache.clear();
  fcel.f = value as string;
  await compileCelBody(fcel, state, { pruneAutoWired: true });
  return true;
};

export const setValue: Fn = async (
  state: State, key: Key, value: unknown, opts?: SetOpts,
) => {
  validateValueWrite(state, key, value, "setValue");
  const topoChanged = await applyValueWrite(state, key, value);
  if (topoChanged) precompute(state);
  await runCascade(state, affectedFor(state, [key]), new Set([key]));
  await settleStructural(state);
  observeMutation(state, [key]);
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

export const setValueBatch: Fn = async (
  state: State, writes: Array<[Key, unknown]>, opts?: SetOpts,
) => {
  // Atomic pre-flight — fail before any mutation.
  for (const [k, v] of writes) validateValueWrite(state, k, v, "setValueBatch");

  const firedKeys: Key[] = [];
  const seen = new Set<Key>();
  let topoChanged = false;
  for (const [k, v] of writes) {
    if (await applyValueWrite(state, k, v)) topoChanged = true;
    if (!seen.has(k)) { seen.add(k); firedKeys.push(k); }
  }
  if (topoChanged) precompute(state);
  await runCascade(state, affectedFor(state, firedKeys), new Set(firedKeys));
  await settleStructural(state);
  observeMutation(state, firedKeys);
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};
