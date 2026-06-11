import type {
  Cel, CelSpec, CelMetadata, FireableCel as ComputeCel, DehydratedCel, FireableCel, Fn, Key, State,
} from "../../types/index.js";
import { coordinatesFromKey, isDataCel, isDefinitionCel, isFireable } from "../cels.js";
import { precompute } from "../卜/precompute.js";
import { bumpDefGeneration } from "../卜/graph.js";
import { compileCelBody } from "../hydrate/formula.js";
import { inflateCel, disposeCel } from "../hydrate/cel.js";
import { hasHooksOrCache, makeLambdaTrampoline } from "../卜/hooks.js";
import { affectedFor, runCascade } from "../卜/runCycle.js";
import { settleStructural } from "./settle.js";
import type { SetOpts } from "../../types/index.js";
import { flushChannels } from "./flush-channels.js";
import { isCelError } from "../cel-error.js";
import { assertOneDirection, specTouchesEdges } from "../segments/edge-rule.js";
import { assertNotDormant } from "../segments/dormant.js";

// ============================================================================
// Cel-plane writes — the recompile tier.
//
// setCel manages cels as STRUCTURE, never as data:
//
//   spec.celType present  → CREATE or REPLACE the whole cel. The spec
//     is the cel's complete definition (v/f/fn are its seed content,
//     same as a hydrate seed). Replacing a definition cel (lambda,
//     schema, compiler, channel, named range) bumps the state's
//     definition generation; consumers compiled against the old
//     definition detect the stamp mismatch at their next fire and
//     recompile — that's the cascade's second reaction, and the only
//     write path that triggers it.
//
//   no spec.celType       → METADATA edit on an existing cel (name,
//     description, schema, kind, parser, inputMap, coordinates…).
//     v and f are REFUSED here: a cel's data is setValue's domain
//     (mutually exclusive tiers), and a definition's content changes
//     only by replacing the definition.
//
// registerLambda is gone — creating a lambda is setCel with a
// LambdaCel spec ({ celType, f, metadata.kind } to compile source, or
// { celType, fn } for a native runtime fn).
// ============================================================================

const TIER_MSG =
  "v/f are data — write them with setValue, or replace the whole cel by passing celType";

// Fields a metadata edit may touch. key/segment stay put: key is
// identity, segment moves are a flush/rehydrate concern.
const IMMUTABLE_METADATA = new Set(["key", "segment"]);

const applySpec = async (
  state: State, key: Key, spec: CelSpec,
): Promise<{ topoChanged: boolean }> => {
  // Dormant cels are read-only: a setCel against a key living in a dormant
  // segment's payload throws (naming cel + segment) before any mutation.
  // The SegmentCel itself (冊.<name>) is live, never dormant, so replacing
  // or editing a manifest stays allowed.
  assertNotDormant(state, key, "setCel");
  const existing = state.cels.get(key);
  if (existing?.locked) throw new Error(`setCel: cel "${key}" is locked`);

  // ── Metadata edit ──────────────────────────────────────────────────
  if (spec.celType === undefined) {
    if (!existing) throw new Error(`setCel: unknown cel "${key}" (pass celType to create)`);
    if ("v" in spec || "f" in spec || spec.fn !== undefined) {
      throw new Error(`setCel: "${key}" — ${TIER_MSG}`);
    }
    if (!spec.metadata) return { topoChanged: false };
    if (spec.metadata.coordinates !== undefined && !isDataCel(existing)) {
      throw new Error(
        `setCel: "${key}" is a ${existing.celType} — only Value/Formula cels carry coordinates`,
      );
    }
    let topoChanged = false;
    let recompile = false;
    const md = existing.metadata as Record<string, unknown>;
    for (const [k, v] of Object.entries(spec.metadata)) {
      if (IMMUTABLE_METADATA.has(k)) continue;
      if (md[k] === v) continue;
      md[k] = v;
      if (k === "inputMap" || k === "schema") topoChanged = true;
      if (k === "kind" || k === "parser") recompile = true;
    }
    if (recompile && isFireable(existing) && existing.f !== undefined) {
      existing._fn = undefined;
      existing._buildEvaluate = undefined;
      existing._evaluate = undefined;
      await compileCelBody(existing, state, { evictCache: false });
      topoChanged = true;
    }
    return { topoChanged };
  }

  // ── Create / replace ───────────────────────────────────────────────
  const isLambdaType = spec.celType === "EditableLambdaCel" || spec.celType === "LockedLambdaCel";
  if (isLambdaType && spec.fn !== undefined && spec.f !== undefined) {
    throw new Error(`setCel: "${key}" provides both fn and f — pick one body.`);
  }
  if (isLambdaType && spec.fn === undefined && spec.f === undefined) {
    throw new Error(`setCel: "${key}" needs either fn or f for a Lambda celType.`);
  }
  const segment = spec.metadata?.segment ?? existing?.metadata.segment ?? "default";
  const metadata = { ...spec.metadata, key, segment } as CelMetadata;
  const dc: DehydratedCel = { key, celType: spec.celType, metadata };
  if ("v" in spec)              (dc as { v?: unknown }).v = spec.v;
  if (spec.f       !== undefined) dc.f       = spec.f;
  if (spec.wave    !== undefined) dc.wave    = spec.wave;
  if (spec.dynamic !== undefined) dc.dynamic = spec.dynamic;
  if (spec.locked  !== undefined) dc.locked  = spec.locked;

  const cel = inflateCel(dc);
  if (spec.fn !== undefined) {
    if (!isFireable(cel)) {
      throw new Error(`setCel: "${key}" — fn only applies to Lambda/Formula celTypes`);
    }
    (cel as ComputeCel)._fn = spec.fn;
  }
  if (spec.dispose !== undefined) {
    if (!isFireable(cel)) {
      throw new Error(`setCel: "${key}" — dispose only applies to Lambda/Formula celTypes`);
    }
    (cel as ComputeCel)._dispose = spec.dispose;
  }

  // Compile BEFORE touching state — setCel is the imperative API, so a
  // bad source throws here and a failed replace leaves the existing cel
  // exactly as it was (hydrate, the declarative path, traps the same
  // failure as a CelError value instead).
  if (isFireable(cel) && cel.f !== undefined && spec.fn === undefined) {
    await compileCelBody(cel as FireableCel, state);
    if (isCelError(cel.v)) {
      const err = (cel.v as { message?: string }).message ?? "compile failed";
      throw new Error(`setCel: "${key}" — ${err}`);
    }
  }

  if (existing) disposeCel(existing, state);
  state.cels.set(key, cel);

  if (isFireable(cel) && hasHooksOrCache(cel as ComputeCel) && (cel as ComputeCel)._fn) {
    (cel as ComputeCel)._fn =
      makeLambdaTrampoline((cel as ComputeCel)._fn!, cel as ComputeCel, state);
  }

  // Definition plane: stamp the new generation so consumers compiled
  // against the previous cel recompile at their next fire. Replacing a
  // DATA cel needs no stamp — nothing compiles against data.
  if (isDefinitionCel(cel)) bumpDefGeneration(state, cel);

  return { topoChanged: true };
};

export const setCel: Fn = async (
  state: State, key: Key, spec: CelSpec, opts?: SetOpts,
) => {
  const { topoChanged } = await applySpec(state, key, spec);
  if (topoChanged) precompute(state);
  // One-direction rule: only when the spec could introduce a cross-
  // segment edge (inputMap / imports / channel / segment change). Runs
  // against the fresh adjacency; throws AFTER the mutation (v1 does not
  // revert — see roadmap Notes).
  if (specTouchesEdges(spec)) assertOneDirection(state);
  await runCascade(state, affectedFor(state, [key]), new Set([key]));
  await settleStructural(state);
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

export const setCelBatch: Fn = async (
  state: State, writes: Record<Key, CelSpec>, opts?: SetOpts,
) => {
  const keys = Object.keys(writes);
  if (keys.length === 0) return state;
  // Atomic pre-flight — reject a dormant key before ANY spec in the batch
  // lands (mirrors setValueBatch's validate-then-apply).
  for (const key of keys) assertNotDormant(state, key, "setCelBatch");
  let topoChanged = false;
  let checkEdges = false;
  for (const key of keys) {
    const r = await applySpec(state, key, writes[key]!);
    if (r.topoChanged) topoChanged = true;
    if (specTouchesEdges(writes[key]!)) checkEdges = true;
  }
  if (topoChanged) precompute(state);
  if (checkEdges) assertOneDirection(state);
  await runCascade(state, affectedFor(state, keys), new Set(keys));
  await settleStructural(state);
  if (opts?.flush) await flushChannels(state, opts.flush);
  return state;
};

// Re-exported so hydrate-time coordinate auto-population and setCel
// agree on what counts as a coordinate key.
export { coordinatesFromKey };

export type { Cel };
