import type { Cel, Key, SegmentLoader, State, 冊 } from "../../types/index.js";
/** Reserved cel key: locked ValueCel whose v is the pending-loader
 *  registry (Map<Key, SegmentLoader>) — segments whose manifests are
 *  known but whose cels await loadSegment/ensureSegments. */
export const SEGMENT_LOADERS_KEY = "segment.loaders" as const;

/** Reserved cel key: locked ValueCel whose v is the PERSISTENT bundled-
 *  loader table (Map<Key, SegmentLoader>) — every bundled segment's code
 *  loader, populated once by createInitialState. Unlike SEGMENT_LOADERS_KEY
 *  (consumed on loadSegment), this survives load: it is the re-park source
 *  so flush/forget of a bundled segment can re-register its loader into
 *  SEGMENT_LOADERS_KEY and loadSegment brings it back. */
export const BUNDLED_LOADERS_KEY = "segment.bundled-loaders" as const;

/** Typed accessor for the pending-segment-loader registry. */
export const getSegmentLoaders = (state: State): Map<Key, SegmentLoader> | undefined =>
  state.cels.get(SEGMENT_LOADERS_KEY)?.v as Map<Key, SegmentLoader> | undefined;

/** Typed accessor for the persistent bundled-loader table. */
export const getBundledLoaders = (state: State): Map<Key, SegmentLoader> | undefined =>
  state.cels.get(BUNDLED_LOADERS_KEY)?.v as Map<Key, SegmentLoader> | undefined;

/** Re-park a bundled segment's loader into the pending registry so a
 *  later loadSegment can reinstall it. No-op when the segment isn't bundled
 *  (a runtime-born user-space segment has no code loader) or the registries
 *  are missing. Called by flush/forget after a bundled segment's cels go. */
export const reparkBundledLoader = (state: State, name: Key): void => {
  const bundled = getBundledLoaders(state);
  const pending = getSegmentLoaders(state);
  if (!bundled || !pending) return;
  const loader = bundled.get(name);
  if (loader) pending.set(name, loader);
};
import { precompute } from "../卜/precompute.js";
import { resolveSchemas } from "../hydrate/schema.js";
import { applySchemaHydrate } from "../hydrate/value.js";
import { installMemoAndTrampolines } from "../hydrate/memo-install.js";
import { getSegmentManifest, setSegmentManifest } from "./cels.js";

// ============================================================================
// Lazy / dynamic segment loading.
//
// createInitialState({ lazy: [...] }) seeds a segment's 冊 manifest as a
// SegmentCel (冊.<name>) (so listSegments, dependency walks, and host UI
// like a desktop's app icons all work) but parks its cel loader in the
// reserved registry at SEGMENT_LOADERS_KEY instead of installing cels.
// loadSegment / ensureSegments consume the loader on first need.
//
// Loaders return LIVE cels (code seeds with _fn / CompilerCel.v already
// bound) — the same shape createInitialState installs eagerly. That's why
// installation here is cels.set + the post-install passes (schemas, memo,
// precompute) with NO compile step. A segment whose cels need compiling
// (a dehydrated 甲骨 fetched from somewhere) goes through `hydrate`, which
// owns compilation — registerSegmentLoader is for code, hydrate is for data.
// ============================================================================

const loadersOf = (state: State): Map<Key, SegmentLoader> => {
  const loaders = getSegmentLoaders(state);
  if (!loaders) {
    throw new Error(
      "segment loaders: reserved cel \"segment.loaders\" is missing — " +
      "state was not built by createInitialState?",
    );
  }
  return loaders;
};

/** Register (or replace) a loader for a segment that isn't installed yet.
 *  Pass the 冊 so dependency walks and host UI see the segment before it
 *  loads; omit it when the manifest is already in state.segments. */
export const registerSegmentLoader = (
  state: State, name: Key, loader: SegmentLoader, manifest?: 冊,
): void => {
  if (manifest) setSegmentManifest(state, manifest);
  loadersOf(state).set(name, loader);
};

/** A segment is pending when its cels haven't been installed yet —
 *  i.e. a loader is still parked for it. */
export const isSegmentPending = (state: State, name: Key): boolean =>
  loadersOf(state).has(name);

const installLoaded = (state: State, cels: Cel[]): void => {
  for (const cel of cels) state.cels.set(cel.metadata.key, cel);
};

/** Install one pending segment's cels. No-op when nothing is pending
 *  under that name. Runs the hydrate post-install passes; pass
 *  { precompute: false } when batching (ensureSegments does). */
export const loadSegment = async (
  state: State, name: Key, opts?: { precompute?: boolean },
): Promise<void> => {
  const loaders = loadersOf(state);
  const loader = loaders.get(name);
  if (!loader) return;
  // Delete before awaiting so concurrent loadSegment calls don't
  // double-install; restore on failure so the segment stays loadable.
  loaders.delete(name);
  try {
    installLoaded(state, await loader());
  } catch (e) {
    loaders.set(name, loader);
    throw e;
  }
  if (opts?.precompute === false) return;
  resolveSchemas(state);
  applySchemaHydrate(state);
  installMemoAndTrampolines(state);
  precompute(state);
};

/** Walk 冊.dependencies from the named segments and load every pending
 *  segment in the closure, then precompute once. The closure follows
 *  manifests in state.segments — a pending dep with no manifest (and no
 *  loader) is reported, since firing its cels would fail later anyway. */
export const ensureSegments = async (
  state: State, names: Key[],
): Promise<void> => {
  const loaders = loadersOf(state);

  // Transitive closure over manifest dependencies.
  const closure = new Set<Key>();
  const queue = [...names];
  while (queue.length > 0) {
    const n = queue.pop()!;
    if (closure.has(n)) continue;
    closure.add(n);
    const m = getSegmentManifest(state, n);
    if (!m) {
      if (loaders.has(n)) continue; // loader without manifest: loadable, no deps to walk
      throw new Error(`ensureSegments: no manifest or loader for segment "${n}"`);
    }
    for (const dep of m.dependencies) queue.push(dep);
  }

  const pending = [...closure].filter((n) => loaders.has(n));
  if (pending.length === 0) return;
  // Loaders are independent (live cels, no cross-compile) — run them
  // concurrently, install all, then one precompute for the batch.
  await Promise.all(pending.map((n) => loadSegment(state, n, { precompute: false })));
  resolveSchemas(state);
  applySchemaHydrate(state);
  installMemoAndTrampolines(state);
  precompute(state);
};
