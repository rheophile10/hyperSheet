import type { Dehydrate } from "../../types/index.js";
import { collectManifests, groupCelsBySegment } from "./segment.js";

// Re-export the per-entity helpers so other kernel modules / host code
// can grab them directly.
export { deflateCel } from "./cel.js";
export { dehydrateValue } from "./schema.js";
export { collectManifests, groupCelsBySegment } from "./segment.js";
export { dehydrate函 } from "./函.js";
export type { Dehydrate函Options } from "./函.js";

// ============================================================================
// Archive format version.
//
// The dehydrated `.甲` archive object now carries a top-level
// `formatVersion`. It pins the compiler/serialization semantics the
// archive was written under, so a reader can tell whether its kernel
// matches, predates, or postdates the bytes it's loading.
//
// BUMP POLICY — bump CURRENT_FORMAT_VERSION by 1 whenever a change to
// dehydrate/hydrate would make an OLD archive recompile or rehydrate
// with DIFFERENT semantics under the new kernel (e.g. a parser/compiler
// behavior change, a cel-shape change, a schema-protocol change). A
// purely additive change that old archives ignore does NOT need a bump.
// Each bump should land with a one-line compat note here describing what
// changed and how (or whether) old archives migrate.
//
// Compat notes:
//   1 — initial versioned format. Archives written before this field
//       existed have NO marker; they are treated as version 0 (legacy)
//       and loaded as-is (see checkFormatVersion).
// ============================================================================
export const CURRENT_FORMAT_VERSION = 1;

/** Inspect an archive's `formatVersion` against the running kernel.
 *
 *  - missing marker  → a pre-versioning (legacy) archive; load as-is,
 *    log a one-line note.
 *  - newer than ours → kernel predates the archive; surface a clear
 *    warning (the reader may misinterpret newer semantics) but do NOT
 *    throw — best-effort load.
 *  - same/older      → silent normal path.
 *
 *  Returns the resolved numeric version (0 for an unmarked legacy
 *  archive) so callers can branch if they ever need to.
 */
export const checkFormatVersion = (
  archive: { formatVersion?: number } | null | undefined,
  log: (msg: string) => void = console.warn,
): number => {
  const v = archive?.formatVersion;
  if (v === undefined) {
    log(`[plastron] loading a pre-versioning .甲 archive (no formatVersion); treating as legacy v0 (current=${CURRENT_FORMAT_VERSION}).`);
    return 0;
  }
  if (v > CURRENT_FORMAT_VERSION) {
    log(`[plastron] .甲 archive formatVersion ${v} is NEWER than this kernel (current=${CURRENT_FORMAT_VERSION}); loading best-effort — newer semantics may be misread.`);
  }
  return v;
};

// ============================================================================
// dehydrate — decompose a State into JSON-serializable {segments, manifests}.
// Inverse of hydrate; lossy where Zod schemas carry refinements,
// transforms, or brands.
//
// opts.onlySegments — when present, restrict output to those segment
// names. Useful for apps that want to ship just their user segment
// (e.g. pictograph's "象形") without also re-emitting every boot-
// loaded kernel segment (csp, js-compiler, cel-error, ...) which
// createInitialState re-seeds anyway.
// ============================================================================

export const dehydrate: Dehydrate = (state, opts) => {
  const filter = opts?.onlySegments ? new Set(opts.onlySegments) : undefined;
  return {
    formatVersion: CURRENT_FORMAT_VERSION,
    segments: groupCelsBySegment(state, filter),
    manifests: collectManifests(state, filter),
  };
};
