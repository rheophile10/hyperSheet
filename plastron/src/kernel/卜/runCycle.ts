import type { Cel, ChannelCel, FireableCel as ComputeCel, FireableCel, Fn, Key, ResolvedInputs, State } from "../../types/index.js";
import { bump } from "../counters.js";
import { isFireable } from "../cels.js";
import type { PrecomputedIndexes } from "../../types/index.js";
import { PRECOMPUTED_STATES_KEY } from "../卜/graph.js";
import { bfsDownstream, isDefinitionStale } from "./graph.js";
import { precompute } from "./precompute.js";
import { compileCelBody } from "../hydrate/formula.js";
import { hasHooksOrCache as hooked, makeLambdaTrampoline } from "./hooks.js";
import { resolveFn } from "../resolve-fn.js";
import { appendError, makeCelError } from "../cel-error.js";
import { deriveCacheKeysFromInputMap, hasHooksOrCache, runHookedExecution } from "./hooks.js";

// Route a changed compute cel onto every channel handler. Fast path
// reads cel._channelHandlers; fallback resolves channels via the
// per-cel ChannelCel._channel.
const enqueueChannels = (cel: FireableCel, state: State): void => {
  const handlers = cel._channelHandlers;
  if (handlers) {
    for (const h of handlers) h.enqueue({ cel, state });
    return;
  }
  const channels = cel.metadata.channel;
  if (!channels || channels.length === 0) return;
  for (const k of channels) {
    const channelCel = state.cels.get(k) as ChannelCel | undefined;
    channelCel?._channel?.enqueue({ cel, state });
  }
};

const readIndexes = (state: State): PrecomputedIndexes | undefined =>
  state.cels.get(PRECOMPUTED_STATES_KEY)?.v as PrecomputedIndexes | undefined;

// Head rule — shared with the formula parsers' input lookup (see the
// infix parser's lookupFromInputs): a lambda/compiler cel contributes
// its CALLABLE, a FormulaCel its computed value, everything else its v.
// This keeps the fast value-record path semantically equal to the
// _evaluate path: a cel's FIRST fire (genesis installs fire in the
// same cascade that created them, before precomputeOptional has built
// _evaluate) must resolve function symbols the same way later fires do.
const inputValue = (c: Cel | undefined): unknown => {
  if (c === undefined) return undefined;
  if (c.celType === "FormulaCel") return c.v;
  return (c as { _fn?: unknown })._fn ?? c.v;
};

const resolveInputs = (cel: FireableCel, state: State): Record<string, unknown> => {
  const inputs: Record<string, unknown> = {};
  if (cel._inputEntries) {
    for (const [name, cs] of cel._inputEntries) {
      if (cs === undefined) inputs[name] = undefined;
      else if (Array.isArray(cs)) inputs[name] = cs.map((c) => inputValue(c));
      else inputs[name] = inputValue(cs);
    }
    return inputs;
  }
  if (cel.metadata.inputMap) {
    for (const [name, refKey] of Object.entries(cel.metadata.inputMap)) {
      if (Array.isArray(refKey)) {
        const arr: unknown[] = new Array(refKey.length);
        for (let i = 0; i < refKey.length; i++) {
          arr[i] = inputValue(state.cels.get(refKey[i]));
        }
        inputs[name] = arr;
      } else {
        inputs[name] = inputValue(state.cels.get(refKey));
      }
    }
  }
  return inputs;
};

// Recompile a definition-stale consumer in place, then hand back to
// fireCel. The fresh extractDeps pass prunes auto-wired inputMap
// entries the new parse no longer references (a shrunk named range's
// old members), so the post-cycle precompute sees the rewired graph.
const recompileStale = async (
  state: State, cel: FireableCel, recompiled: Set<Key>,
): Promise<void> => {
  if (cel._dispose) { try { cel._dispose(); } catch { /* swallow */ } }
  cel._dispose = undefined;
  cel._fn = undefined;
  cel._buildEvaluate = undefined;
  cel._evaluate = undefined;
  cel._inputEntries = undefined;
  if ((cel as ComputeCel)._memoCache) (cel as ComputeCel)._memoCache!.clear();
  await compileCelBody(cel, state, { evictCache: true, pruneAutoWired: true });
  if ((cel.celType === "EditableLambdaCel" || cel.celType === "LockedLambdaCel")
      && hooked(cel as ComputeCel) && cel._fn) {
    cel._fn = makeLambdaTrampoline(cel._fn, cel as ComputeCel, state);
  }
  // Rebuild the monomorphic evaluate closure NOW — the cel re-fires in
  // this same cascade, and the generic slow path resolves input VALUES
  // (a lambda head needs the resolved cel's _fn, which only the
  // buildEvaluate closure reads). precomputeOptional would eventually
  // redo this, but it's async fire-and-forget.
  const inputMap = cel.metadata.inputMap;
  // Re-read through a fresh reference — TS still narrows _buildEvaluate
  // to the `undefined` we assigned above, but compileCelBody repopulated it.
  const buildEv = (cel as ComputeCel)._buildEvaluate;
  if (buildEv && inputMap) {
    const resolved: ResolvedInputs = {};
    const entries: Array<[string, Cel | undefined | Array<Cel | undefined>]> = [];
    for (const [name, ref] of Object.entries(inputMap)) {
      const cs = Array.isArray(ref) ? ref.map((k) => state.cels.get(k)) : state.cels.get(ref);
      resolved[name] = cs;
      entries.push([name, cs]);
    }
    cel._inputEntries = entries;
    const cspOk = (state.cels.get("csp.eval-available")?.v as boolean | undefined) ?? true;
    try {
      const ev = buildEv(resolved, cspOk);
      cel._evaluate = ev instanceof Promise ? await ev : ev;
    } catch { cel._evaluate = undefined; }
  }
  recompiled.add(cel.metadata.key);
};

const fireCel = (
  state: State,
  key: Key,
  suppression: boolean,
  changed: Set<Key> | undefined,
  recompiled?: Set<Key>,
): void | Promise<void> => {
  const cel = state.cels.get(key);
  if (!cel || !isFireable(cel)) return;

  // Definition staleness — a lambda/schema/range/compiler this cel
  // compiled against changed after the cel's _compiledGen. Recompile
  // first (the second cascade reaction), then evaluate as usual.
  if (recompiled && cel.f !== undefined && isDefinitionStale(state, cel)) {
    return recompileStale(state, cel, recompiled).then(
      () => fireCel(state, key, suppression, changed),
      (e) => {
        const ce = makeCelError([cel.metadata.key], "CompileError", e);
        appendError(state, ce);
        finishFireSync(state, cel, ce, suppression, changed);
      },
    );
  }

  const fn = cel._fn;
  if (!fn) return;

  if (suppression) {
    let shouldFire = cel.dynamic === true;
    if (!shouldFire) {
      if (cel._inputEntries) {
        outer: for (const [, cs] of cel._inputEntries) {
          if (cs === undefined) continue;
          if (Array.isArray(cs)) {
            for (const c of cs) {
              if (c && changed!.has(c.metadata.key)) { shouldFire = true; break outer; }
            }
          } else if (changed!.has(cs.metadata.key)) {
            shouldFire = true; break;
          }
        }
      } else if (cel.metadata.inputMap) {
        outer: for (const ref of Object.values(cel.metadata.inputMap)) {
          const refs = Array.isArray(ref) ? ref : [ref];
          for (const k of refs) {
            if (changed!.has(k)) { shouldFire = true; break outer; }
          }
        }
      }
    }
    if (!shouldFire) return;
  }
  bump("fires"); // counts cels that proceed to EVALUATION (post-suppression-gate)

  // Hooked path: when the cel has _memoCache or pre/post-fns, all
  // execution funnels through the hook reducer. Always async (hook fns
  // may be async); errors flow through the accumulator's `acc.error`
  // and are caught here for trap-as-value translation.
  if (hasHooksOrCache(cel as ComputeCel)) {
    const inputs = resolveInputs(cel, state);
    const cacheKeys = deriveCacheKeysFromInputMap(cel as ComputeCel, inputs);
    const runFn = (): unknown => {
      if (cel.celType === "FormulaCel" && cel._evaluate) return cel._evaluate();
      return fn(inputs);
    };
    return runHookedExecution(state, cel as ComputeCel, { inputs, cacheKeys, runFn }).then(
      (newV) => { finishFireSync(state, cel, newV, suppression, changed); },
      (e) => {
        const ce = makeCelError([cel.metadata.key], "RuntimeError", e);
        appendError(state, ce);
        finishFireSync(state, cel, ce, suppression, changed);
      },
    );
  }

  // Fast path — original unhooked behavior.
  // Trap-as-value: any throw from _evaluate or the slow-path fn becomes a
  // CelError stored on cel.v. The cascade keeps going; downstream cels
  // see the error value and either propagate it (most ops will NaN /
  // throw / no-op naturally) or detect it via isCelError() and short-
  // circuit. Without this, one buggy formula aborts the whole runCycle,
  // which is hostile to incremental authoring (pictograph hit this).
  let fnResult: unknown;
  try {
    if (cel.celType === "FormulaCel" && cel._evaluate) {
      fnResult = cel._evaluate();
    } else {
      fnResult = fn(resolveInputs(cel, state));
    }
  } catch (e) {
    const ce = makeCelError([cel.metadata.key], "RuntimeError", e);
    appendError(state, ce);
    fnResult = ce;
  }

  if (fnResult instanceof Promise) {
    return fnResult.then(
      (newV) => { finishFireSync(state, cel, newV, suppression, changed); },
      (e)    => {
        const ce = makeCelError([cel.metadata.key], "RuntimeError", e);
        appendError(state, ce);
        finishFireSync(state, cel, ce, suppression, changed);
      },
    );
  }
  finishFireSync(state, cel, fnResult, suppression, changed);
};

const finishFireSync = (
  state: State, cel: FireableCel, newV: unknown,
  suppression: boolean, changed: Set<Key> | undefined,
): void => {
  if (!suppression) {
    cel.v = newV;
    enqueueChannels(cel, state);
    return;
  }
  const isChangedKey = cel.schema?.protocols.isChanged;
  const isChanged = isChangedKey ? resolveFn(state, isChangedKey) : undefined;
  if (isChanged) {
    if (!isChanged(cel.v, newV)) { bump("suppressed"); return; }
  } else if (cel.v === newV) {
    bump("suppressed");
    return;
  }
  commitChange(state, cel, newV, changed!);
};

const commitChange = (
  state: State, cel: FireableCel, newV: unknown, changed: Set<Key>,
): void => {
  cel.v = newV;
  changed.add(cel.metadata.key);
  enqueueChannels(cel, state);
};

export const runCascade = async (
  state: State,
  affected: Set<Key>,
  changed?: Set<Key>,
): Promise<void> => {
  const indexes = readIndexes(state);
  if (!indexes || affected.size === 0) return;

  const suppression = changed !== undefined;
  const recompiled = new Set<Key>();

  for (const wave of indexes.sortedWaves) {
    const levels = indexes.waveCascade.get(wave)!;
    for (const level of levels) {
      let promises: Promise<void>[] | null = null;
      for (const key of level) {
        if (!affected.has(key)) continue;
        const r = fireCel(state, key, suppression, changed, recompiled);
        if (r instanceof Promise) {
          if (!promises) promises = [];
          promises.push(r);
        }
      }
      if (promises) await Promise.all(promises);
    }
  }

  // Mid-cascade recompiles rewired inputMaps under a sort built for the
  // old graph. Finish the cycle on the old order (above), then fold the
  // new edges into the indexes and run one follow-up cascade seeded by
  // the recompiled cels so anything their rewiring exposed settles.
  // Terminates because recompiling restamps _compiledGen — a cel can
  // only re-enter this set if a definition changes again.
  if (recompiled.size > 0) {
    precompute(state);
    await runCascade(state, affectedFor(state, [...recompiled]), new Set(recompiled));
  }
};

export const affectedFor = (state: State, writtenKeys: Key[]): Set<Key> => {
  const affected = new Set<Key>();
  const indexes = readIndexes(state);
  if (!indexes) return affected;
  for (const k of indexes.dynamicCascade) affected.add(k);
  for (const k of writtenKeys) {
    let ds = indexes.downstream.get(k);
    if (!ds) {
      ds = bfsDownstream(k, indexes.children);
      indexes.downstream.set(k, ds);
    }
    for (const c of ds) affected.add(c);
  }
  return affected;
};

// ── 連鎖 — the cascade ───────────────────────────────────────────────────────
//
//   "A system of cels. Interlinked. Within cels interlinked. Within
//    cels interlinked. Within one stem."
//
// 連鎖 (rensa, "linked chain / chain-reaction") fires the full cascade
// once across every fireable cel, propagating each change through the
// interlinked graph until it settles. This is the kernel's beating
// heart — the loop that makes cels interlinked behave as one reactive
// body. Surfaced publicly as `interlinked` (and the short `ilk`); the
// legacy `runCycle` name is kept as an alias.
const 連鎖: Fn = async (state: State) => {
  const indexes = readIndexes(state);
  if (!indexes) return state;

  const all = new Set<Key>();
  for (const levels of indexes.waveCascade.values()) {
    for (const level of levels) {
      for (const k of level) all.add(k);
    }
  }
  await runCascade(state, all, undefined);
  return state;
};

export type { Cel };

/** The cascade, named. `interlinked` is canonical; `ilk` is the short
 *  form for formulas (`(ilk)`); `runCycle` is the legacy alias. All
 *  three resolve to 連鎖. */
export const interlinked = 連鎖;
export const ilk = 連鎖;
export const runCycle = 連鎖;
export { 連鎖 };
