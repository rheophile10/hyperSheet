import type { Hydrate } from "../../types/index.js";
import { precompute } from "../卜/precompute.js";
import { validateInputKinds } from "./input-kinds.js";
import { installMemoAndTrampolines } from "./memo-install.js";
import { resolveSchemas } from "./schema.js";
import { installCels, validateManifests } from "./segment.js";
import { applySchemaHydrate } from "./value.js";
import { setSegmentManifest } from "../segments/cels.js";
import { assertOneDirection } from "../segments/edge-rule.js";

// Re-export the per-entity helpers so other kernel modules (cel-body,
// flush, host code) can grab them directly without reaching into the
// subfolder structure.
export { inflateCel, disposeCel, retireCel } from "./cel.js";
export { compileCelBody } from "./formula.js";
import { compileCelBody } from "./formula.js";
export { validateInputKinds } from "./input-kinds.js";
export { resolveSchemas } from "./schema.js";
export {
  installCels, inflateAllCels, compileFireable, validateManifests,
} from "./segment.js";
export { hydrateValue, applySchemaHydrate } from "./value.js";
export { hydrate函 } from "./函.js";
export { applyManifestDefaults } from "./segment.js";

// ============================================================================
// hydrate — fold incoming 甲骨[] + 冊[] into state.
//
// Order matters:
//   1. validateManifests   — fail-fast on missing deps before any
//                            mutation.
//   2. installCels         — inflate every dehydrated cel (pure
//                            construct), then topo-compile fireable
//                            cels with `f` so a compiler shipped in
//                            the same batch as the cels that name it
//                            compiles first.
//   3. resolveSchemas      — populate cel.schema from each cel's
//                            metadata.schema reference. Deferred until
//                            all cels exist so cross-segment refs work.
//   4. applySchemaHydrate  — walk every cel and run its schema's
//                            `protocols.hydrate` fn on cel.v (if
//                            declared). Inflates JSON-shaped values
//                            (e.g. RegExp, Uint8Array) into live form.
//                            Best-effort: silently skipped when the
//                            schema, the protocol fn, or the fn cel is
//                            absent.
//   5. precompute(state)   — rebuild waveCascade, children,
//                            dynamicCascade. Bumps generation.
//   6. record manifests    — only after precompute returns successfully,
//                            so a cycle/throw leaves state.segments
//                            untouched.
//
// Lambda fns no longer come through hydrate — every fn is owned by a
// cel in a segment (kernel-io, kernel-lifecycle, kernel-segments,
// js-compiler, ...) and gets installed via installCels above. The
// runtime fn lookup goes through resolveFn(state, key) which reads
// cel._fn (Lambda/Formula) or cel.v (CompilerCel).
// ============================================================================

export const hydrate: Hydrate = async (state, segments, manifests) => {
  validateManifests(state, manifests);
  await installCels(state, segments);
  // Seed FormulaCels: boot-time segments (origin's 元.view is the first)
  // may ship source-bodied fireables OUTSIDE the hydrate payload —
  // bindNativeFns inflates them without a compile pass. Make the state
  // runnable: compile any NON-PAYLOAD fireable that has source but no
  // body and no trapped compile (payload cels already went through
  // compileFireable — a missing _fn there is a recorded CompileError,
  // not a todo).
  const payloadKeys = new Set<string>();
  for (const seg of segments) for (const dc of seg.cels) payloadKeys.add(dc.key);
  for (const cel of state.cels.values()) {
    if (payloadKeys.has(cel.metadata.key)) continue;
    if ((cel as { f?: string }).f !== undefined && (cel as { _fn?: unknown })._fn === undefined
        && (cel.v as { kind?: string } | undefined)?.kind !== "error"
        && (cel.celType === "FormulaCel" || cel.celType === "EditableLambdaCel")) {
      await compileCelBody(cel as never, state);
    }
  }
  validateInputKinds(state);
  resolveSchemas(state);
  applySchemaHydrate(state);
  installMemoAndTrampolines(state);
  // Install the manifests as SegmentCels BEFORE precompute so the derived
  // segment adjacency + roles see them this pass. validateManifests has
  // already mutated each with applyManifestDefaults. (Step 6 used to
  // record into state.segments after precompute "so a cycle/throw leaves
  // state.segments untouched"; precompute can't cycle on manifest cels —
  // SegmentCels carry no inputMap — so installing before is safe.)
  for (const m of manifests) setSegmentManifest(state, m);
  precompute(state);
  // One-direction rule against the fresh adjacency. Throws (after the
  // mutation above) naming the offending code-segment pair; v1 does NOT
  // revert — see the roadmap Notes.
  assertOneDirection(state);
  return state;
};
