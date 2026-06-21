import type {
  Cel, Fn, Key, SegmentCel, State, 函, 函SegmentEntry, 冊,
} from "../../types/index.js";
import { precompute } from "../卜/precompute.js";
import { getBundledLoaders, getSegmentLoaders } from "../segments/load.js";
import { installDormant } from "../segments/dormant.js";
import { wake } from "../segments/wake-sleep.js";
import { setValueBatch } from "../契/value.js";
import { applyManifestDefaults, validateManifests } from "./segment.js";
import { setSegmentManifest, segmentCelKeyOf } from "../segments/cels.js";
import { assertOneDirection } from "../segments/edge-rule.js";

// ============================================================================
// hydrate函 — boot an application from ONE data artifact (design phase 4).
//
// A 函 (the application book-case) is a version + per-segment payload-source
// entries + a boot record. hydrate函 folds it into a State that already
// carries the kernel closure (createInitialState):
//
//   1. Validate manifests for every entry (fail-fast on missing deps /
//      role-lattice violations), and assert every codeSeed entry's loader
//      exists in the bundled-loader table — a MISSING seed throws HERE, at
//      函-hydrate, before anything installs (the design's "fails at
//      函-hydrate" rule).
//   2. Install each entry as DORMANT (or, for codeSeed, install the bundled
//      cels — they're native-bodied, can't ship as data):
//        • inline   → installDormant with the carried 甲骨 payload.
//        • codeSeed → install the bundled loader's cels eagerly when the
//                     entry's name is in boot.wake; otherwise park the
//                     loader (lazy) — codeSeed is the bundled-segment shape,
//                     which can't go dormant (no serializable body).
//        • url/store → install a SegmentCel + record the source on
//                     `_pendingSource`; FIRST WAKE resolves it (fetch /
//                     store.get) — see wake-sleep.ts.
//   3. Boot record: wake each root (pulls its dormant dependency closure),
//      then apply boot.set via setValueBatch({ flush: "all" }). A set write
//      to a cel in a segment boot.wake did NOT wake throws (dormant write) —
//      a 函 author must wake what they set (or target an always-awake
//      kernel cel).
//
// The kernel never imports 甲骨坑: store access is via resolveFn'd fn cels
// (in wake), the bundled loaders are the persistent table seeded at
// createInitialState. 函 nesting is unsupported in v1 (a payload source
// pointing at another 函 throws at wake — see assertNotNested).
// ============================================================================

/** Build a full 冊 manifest for a 函 entry, merging the entry's partial
 *  manifest fields over the entry name and the role/version defaults. */
const manifestOf = (entry: 函SegmentEntry): 冊 => {
  const m: 冊 = {
    // Spread the partial first; fixed fields below win (name from the
    // entry, version/dependencies defaulted when absent). The spread
    // carries role, applications, sink, description, …
    ...entry.manifest,
    name: entry.name,
    version: (entry.manifest?.version as string | undefined) ?? "0.0.0",
    dependencies: (entry.manifest?.dependencies as Key[] | undefined) ?? [],
  };
  applyManifestDefaults(m);
  return m;
};

export const hydrate函: Fn = async (state: State, app: 函): Promise<State> => {
  if (!app || typeof app !== "object" || !Array.isArray(app.segments) || !app.boot) {
    throw new Error("hydrate函: expected a 函 ({ version, boot, segments }).");
  }
  const wakeRoots = new Set(app.boot.wake ?? []);

  // ── 1. validate manifests + codeSeed-loader existence (fail-fast) ──────────
  const manifests = app.segments.map(manifestOf);
  validateManifests(state, manifests);

  const bundled = getBundledLoaders(state);
  for (const entry of app.segments) {
    if (!("codeSeed" in entry.payload && entry.payload.codeSeed)) continue;
    if (!bundled?.has(entry.name)) {
      throw new Error(
        `hydrate函: segment "${entry.name}" is a codeSeed but no bundled loader ` +
        `is registered for it (native fns can't ship as data). A codeSeed must ` +
        `exist in the host bundle — fails at 函-hydrate, before anything runs.`,
      );
    }
  }

  // ── 2. install each entry ──────────────────────────────────────────────────
  for (let i = 0; i < app.segments.length; i++) {
    const entry = app.segments[i];
    const manifest = manifests[i];
    const src = entry.payload;

    if ("inline" in src) {
      // Set the FULL manifest FIRST (applications/sink/description), then
      // installDormant hangs the 甲骨 on the existing SegmentCel's _dormant —
      // it preserves an existing manifest rather than overwriting it. (Doing
      // it the other way would drop _dormant when the manifest re-seeds.)
      // First wake inflates the payload from in-state data.
      setSegmentManifest(state, manifest);
      installDormant(state, { name: entry.name, cels: src.inline.cels });
    } else if ("codeSeed" in src && src.codeSeed) {
      // Native-bodied bundled segment. Install its cels when it's a boot
      // root (eager = wake-all maps here); otherwise the bundled loader is
      // already in the persistent table — record the manifest so topology +
      // host UI see it, and a later wake/loadSegment brings the cels in.
      setSegmentManifest(state, manifest);
      if (wakeRoots.has(entry.name)) {
        // Bundled loaders are sync code seeds (createInitialState's table).
        const loaded = (bundled!.get(entry.name)!)() as Cel[];
        for (const cel of loaded) state.cels.set(cel.metadata.key, cel);
      } else {
        // Lazy bundled segment: park the loader in the pending registry so
        // loadSegment / ensureSegments brings its cels on demand — exactly
        // today's `lazy: [...]` behavior, now expressed as a 函 entry whose
        // name is absent from boot.wake.
        getSegmentLoaders(state)?.set(entry.name, bundled!.get(entry.name)!);
      }
    } else {
      // url / store: install the SegmentCel + record the pending source.
      // The segment is dormant with NO payload yet; first wake resolves it.
      setSegmentManifest(state, manifest);
      const segCel = state.cels.get(segmentCelKeyOf(entry.name)) as SegmentCel;
      segCel._pendingSource = src;
    }
  }

  precompute(state);
  // One-direction rule against the fresh adjacency (inline dormant edges are
  // in it; url/store segments contribute nothing until their first wake).
  assertOneDirection(state);

  // ── 3. boot record ──────────────────────────────────────────────────────────
  for (const root of app.boot.wake ?? []) {
    await (wake as Fn)(state, root);
  }
  if (app.boot.set && app.boot.set.length > 0) {
    await (setValueBatch as Fn)(state, app.boot.set, { flush: "all" });
  }
  return state;
};
