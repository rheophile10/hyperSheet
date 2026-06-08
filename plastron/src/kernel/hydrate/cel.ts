import type {
  Cel, CelMetadata, ChannelCel, FireableCel as ComputeCel, ComputeCelMetadata, DehydratedCel, Key,
  State,
} from "../../types/index.js";
import { toRange } from "../卜/space.js";
import { coordinatesFromKey, isFireable } from "../cels.js";
import { resolveFn } from "../resolve-fn.js";

// tsconfig deliberately omits DOM/Node libs; declare the one host
// global we touch (best-effort deprecation warning) locally.
declare const console: { warn(message: string): void } | undefined;

// One-time deprecation warning when a .甲 still uses the old
// FormulaCelMetadata.compiler field. The migration itself is silent
// per-cel; we only log the first occurrence to keep output sane.
let compilerMigrationWarned = false;

const migrateCompilerToParser = (
  metadata: { parser?: string; compiler?: string },
  key: string,
): void => {
  if (metadata.compiler === undefined) return;
  if (metadata.parser === undefined) metadata.parser = metadata.compiler;
  delete metadata.compiler;
  if (compilerMigrationWarned) return;
  compilerMigrationWarned = true;
  console?.warn(
    `plastron: FormulaCelMetadata.compiler is deprecated — ` +
    `rename to FormulaCelMetadata.parser. Migrated cel "${key}" ` +
    `(further occurrences in this process are silenced).`,
  );
};

// Build a live Cel of the right kind from a DehydratedCel. Pure
// construct — no compilation. Fireable cels carry over their `f`
// source body but `_fn` is left unset; compileFireable runs a topo-
// ordered compile pass after every cel in the hydrate batch is
// installed, so a compiler defined in the same batch as the cels
// that name it resolves correctly.
export const inflateCel = (dc: DehydratedCel): Cel => {
  const metadata: CelMetadata = { ...dc.metadata, key: dc.key };
  if (dc.celType === "FormulaCel") {
    migrateCompilerToParser(metadata as { parser?: string; compiler?: string }, dc.key);
  }
  // Coordinate keys ("3,1", "grid!0,-2,7") position the cel; explicit
  // metadata.coordinates wins over the derived vector. Coordinates are
  // a DATA-plane concept: only Value/Formula cels live in coordinate
  // space (the cells of a sheet / CA grid). Definition cels are named,
  // never positioned — explicit coordinates there are an authoring
  // error; coordinate-LOOKING keys are merely ignored.
  const isDataType = dc.celType === "ValueCel" || dc.celType === "FormulaCel";
  if (!isDataType && metadata.coordinates !== undefined) {
    throw new Error(
      `inflateCel: "${dc.key}" is a ${dc.celType} — only Value/Formula cels carry coordinates`,
    );
  }
  if (isDataType && metadata.coordinates === undefined) {
    const coords = coordinatesFromKey(dc.key);
    if (coords) metadata.coordinates = coords;
  }
  // Authored seed JSON puts `v` at the DehydratedCel top level for
  // readability (see js-common-schema.json, cel-error.json — schema
  // bodies are too rich to nest under metadata). Dehydrate, by contrast,
  // writes value into metadata.v so the type stays homogeneous. Inflate
  // accepts either: top-level wins (the authoring form), metadata.v is
  // the fallback (round-trip form).
  const dcLoose = dc as DehydratedCel & { v?: unknown };
  const baseV: unknown = dcLoose.v ?? metadata.v ?? null;

  switch (dc.celType) {
    case "ValueCel": {
      const cel = { celType: "ValueCel", metadata, v: baseV } as Cel;
      if (dc.wave   !== undefined) (cel as { wave?: number }).wave   = dc.wave;
      if (dc.locked !== undefined) cel.locked  = dc.locked;
      return cel;
    }
    case "SchemaCel":
    case "CompilerCel":
    case "ChannelCel": {
      const cel = { celType: dc.celType, metadata, v: baseV } as Cel;
      if (dc.locked !== undefined) cel.locked = dc.locked;
      if (dc.celType === "ChannelCel") {
        // Live Channel cache is populated by precompute.buildChannel;
        // placeholder here is just the dehydrated descriptor on v.
        (cel as ChannelCel)._channel = undefined;
      }
      return cel;
    }
    case "RangeCel": {
      // Named range. Authoring convenience: v may be notation
      // ("Seg!A1:B3", "1,1:2,2") — parse it to the Range struct here so
      // formulas and rangeToKeys always see the canonical shape.
      const range = toRange(baseV);
      if (!range) {
        throw new Error(
          `RangeCel "${dc.key}": v is not a Range or parseable range notation ` +
          `(got ${JSON.stringify(baseV)}).`,
        );
      }
      const cel = { celType: "RangeCel", metadata, v: range } as Cel;
      if (dc.locked !== undefined) cel.locked = dc.locked;
      return cel;
    }
    case "FormulaCel":
    case "EditableLambdaCel":
    case "LockedLambdaCel": {
      const cel = {
        celType: dc.celType,
        metadata: metadata as ComputeCelMetadata,
        v: baseV,
      } as ComputeCel;
      if (dc.wave    !== undefined) cel.wave    = dc.wave;
      if (dc.locked  !== undefined) cel.locked  = dc.locked;
      if (dc.dynamic !== undefined) cel.dynamic = dc.dynamic;
      if (dc.f       !== undefined) {
        // DehydratedCel.f accepts string | string[]; ComputeCel.f is
        // a single string. Always-on join — no schema needed on the
        // input side. The opt-in `lambda-source` schema's
        // sourceDehydrate is what re-splits on the way out.
        cel.f = Array.isArray(dc.f) ? dc.f.join("\n") : dc.f;
      }
      return cel as Cel;
    }
    case "SegmentCel":
      // SegmentCels are not segment payload — they're created directly
      // by setSegmentManifest, never inflated from a 甲骨 (dehydrate
      // excludes them). Reaching here means a manifest cel leaked into a
      // segment payload.
      throw new Error(
        `inflateCel: "${dc.key}" is a SegmentCel — manifests don't ` +
        `travel as segment payload (use setSegmentManifest).`,
      );
  }
};

/** Retire an OWNED cel (defn/genesis lifecycle): collect its live
 *  consumers FIRST (after deletion, precompute drops the dangling
 *  edges and affectedFor can no longer reach them — they must be
 *  refired explicitly to trap undefined-symbol), dispose, DEFANG
 *  (consumers' compiled closures captured the cel object; a stale
 *  dispatch must resolve to undefined, not ghost-call the old fn),
 *  then drop it from the registry. Promoted from the defn segment —
 *  the genesis drain shares the exact lifecycle and segment isolation
 *  forbids sibling imports. */
export const retireCel = (state: State, key: Key, stale: Set<Key>): void => {
  const c = state.cels.get(key);
  if (!c) return;
  for (const [k, cc] of state.cels) {
    const im = cc.metadata.inputMap;
    if (!im) continue;
    for (const ref of Object.values(im)) {
      if (ref === key || (Array.isArray(ref) && ref.includes(key))) { stale.add(k); break; }
    }
  }
  disposeCel(c, state);
  const z = c as { _fn?: unknown; _evaluate?: unknown; _buildEvaluate?: unknown; v?: unknown };
  z._fn = undefined; z._evaluate = undefined; z._buildEvaluate = undefined; z.v = undefined;
  state.cels.delete(key);
};

export const disposeCel = (cel: Cel, state: State): void => {
  if (isFireable(cel) && cel._dispose) {
    try { cel._dispose(); } catch { /* swallow */ }
  }
  const disposeKey = cel.schema?.protocols.dispose;
  const disposeFn = disposeKey ? resolveFn(state, disposeKey) : undefined;
  if (disposeFn) {
    try { disposeFn(); } catch { /* swallow */ }
  }
};
