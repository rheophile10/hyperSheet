import type {
  Cel, Key, State, 函, 冊, SegmentRole,
} from "./types/index.js";
import { getSegmentLoaders, getBundledLoaders } from "./kernel/segments/load.js";
import { setSegmentManifest } from "./kernel/segments/cels.js";
import { segmentMap } from "./kernel/segments/graph.js";

import manifestSeed from "./甲骨坑/冊.json" with { type: "json" };

// Code seeds — each module exports `name` (segment) and `cels: Cel[]`.
// Lambda + Compiler cels ship with their runtime fn already on the cel
// (LambdaCel._fn, CompilerCel.v), so the kernel's resolveFn(state, key)
// reaches them directly from state.cels — no separate dispatch surface.
import * as kernelSeg        from "./甲骨坑/kernel/index.js";
import * as csp             from "./甲骨坑/library/csp/index.js";
import * as host            from "./甲骨坑/library/host/index.js";
import * as wasmTypes       from "./甲骨坑/library/wasm-types/index.js";
import * as lambdaSource    from "./甲骨坑/library/lambda-source/index.js";
import * as jsCommonSchema  from "./甲骨坑/library/js-common-schema/index.js";
import * as jsCompiler      from "./甲骨坑/library/js-compiler/index.js";
import * as builtins        from "./甲骨坑/library/builtins/index.js";
import * as watCompiler     from "./甲骨坑/library/wat-compiler/index.js";
import * as wasmBytes       from "./甲骨坑/library/wasm-bytes/index.js";
import * as pyCompiler      from "./甲骨坑/library/py-compiler/index.js";
import * as phpCompiler     from "./甲骨坑/library/php-compiler/index.js";
import * as formulaCompiler from "./甲骨坑/library/formula-compiler/index.js";
import * as fileStore       from "./甲骨坑/library/file-store/index.js";
import * as htmlTemplate    from "./甲骨坑/library/html-template-parser/index.js";
import * as plastronDom     from "./甲骨坑/library/dom/index.js";
import * as sheetHost       from "./甲骨坑/library/sheet-host/index.js";
import * as sheets          from "./甲骨坑/library/sheets/index.js";
import * as winapps         from "./甲骨坑/library/winapps/index.js";
import * as windows         from "./甲骨坑/library/windows/index.js";
import * as windowSeg       from "./甲骨坑/library/window/index.js";
import * as fileExplorer    from "./甲骨坑/library/file-explorer/index.js";
import * as wasmWindow      from "./甲骨坑/library/wasm-window/index.js";
import * as winappsWasm     from "./甲骨坑/library/winapps-wasm/index.js";
import * as doom            from "./甲骨坑/library/doom/index.js";
import * as peer            from "./甲骨坑/library/peer/index.js";
import * as xlsx            from "./甲骨坑/library/xlsx/index.js";
import * as ioKeys          from "./甲骨坑/library/io-keys/index.js";
import * as ioTouch         from "./甲骨坑/library/io-touch/index.js";
import * as segmentStore    from "./甲骨坑/library/segment-store/index.js";
import * as opfsSeeding     from "./甲骨坑/library/opfs-seeding/index.js";
import * as cliSegmentExport from "./甲骨坑/library/cli-segment-export/index.js";
import * as sheet           from "./甲骨坑/library/sheet/index.js";
import * as userSpaceOps    from "./甲骨坑/library/user-space-ops/index.js";
import * as originLifecycle from "./甲骨坑/library/origin-lifecycle/index.js";
import * as segmentArchive  from "./甲骨坑/library/segment-archive/index.js";
import * as defn            from "./甲骨坑/library/defn/index.js";
import * as genesis         from "./甲骨坑/library/genesis/index.js";
import * as checkpoint      from "./甲骨坑/library/checkpoint/index.js";
import * as plastronCanvas  from "./甲骨坑/library/plastron-canvas/index.js";
import * as charts          from "./甲骨坑/library/charts/index.js";
import * as net             from "./甲骨坑/library/net/index.js";
import * as cryptoLib       from "./甲骨坑/library/crypto/index.js";
import * as seal            from "./甲骨坑/library/seal/index.js";
import * as sqlite          from "./甲骨坑/library/sqlite/index.js";
import * as sqliteClient    from "./甲骨坑/library/sqlite-client/index.js";
import * as sqliteDemo      from "./甲骨坑/library/sqlite-demo/index.js";
import * as docgraph        from "./甲骨坑/library/docgraph/index.js";
import * as forcegraph      from "./甲骨坑/library/forcegraph/index.js";
import * as origin          from "./甲骨坑/application/origin/index.js";
import * as sound           from "./甲骨坑/library/sound/index.js";
import * as music           from "./甲骨坑/library/music/index.js";

// ============================================================================
// Boot dispatch — 冊.json drives which segments install. Each named
// manifest must have a loader registered below. The loader returns the
// Cel[] to install. Adding a new bundled segment is two lines: import
// here, add a loader entry to the group that matches its 甲骨坑 folder.
//
// Role is DERIVED from the group a loader lives in (the folder encodes
// it on disk: 甲骨坑/library/<segment>/, 甲骨坑/application/<segment>/, and
// — the kernel role admits exactly one segment by rule — the flat
// 甲骨坑/kernel/ which IS the kernel segment). 冊.json no longer carries a
// `role` field — createInitialState stamps each manifest's role from
// these tables when seeding state.segments.
// ============================================================================

const kernelLoaders: Record<Key, () => Cel[]> = {
  // kernelSeg.cels() is a builder — the internal cels it leads with hold
  // mutable per-State containers (Maps inside PrecomputedIndexes, the
  // compile-cache Map), so each State needs its own. The cel-error
  // SchemaCel + protocol fns and every IO/lifecycle/segment native fn
  // ride in the one merged 甲骨.json behind it.
  "kernel": () => [...kernelSeg.cels()],
};

const libraryLoaders: Record<Key, () => Cel[]> = {
  "csp":              () => [...csp.cels],
  "host":             () => [...host.cels],
  "wasm-types":       () => [...wasmTypes.cels],
  "lambda-source":    () => [...lambdaSource.cels],
  "js-common-schema": () => [...jsCommonSchema.cels],
  "js-compiler":      () => [...jsCompiler.cels],
  "builtins":         () => [...builtins.cels],
  "wat-compiler":     () => [...watCompiler.cels],
  "wasm-bytes":       () => [...wasmBytes.cels],
  "py-compiler":      () => [...pyCompiler.cels],
  "php-compiler":     () => [...phpCompiler.cels],
  "formula-compiler": () => [...formulaCompiler.cels],
  "file-store":       () => [...fileStore.cels],
  "html-template-parser": () => [...htmlTemplate.cels],
  "dom":     () => [...plastronDom.cels],
  "sheet-host":       () => [...sheetHost.cels],
  "sheets":           () => [...sheets.cels],
  "winapps":          () => [...winapps.cels],
  "windows":          () => [...windows.cels],
  "window":           () => [...windowSeg.cels],
  "file-explorer":    () => [...fileExplorer.cels],
  "wasm-window":      () => [...wasmWindow.cels],
  "winapps-wasm":     () => [...winappsWasm.cels],
  "doom":             () => [...doom.cels],
  "peer":             () => [...peer.cels],
  "xlsx":             () => [...xlsx.cels],
  "io-keys":          () => [...ioKeys.cels],
  "io-touch":         () => [...ioTouch.cels],
  "segment-store":    () => [...segmentStore.cels],
  "opfs-seeding":     () => [...opfsSeeding.cels],
  "cli-segment-export": () => [...cliSegmentExport.cels],
  "sheet":            () => [...sheet.cels],
  "user-space-ops":   () => [...userSpaceOps.cels],
  "origin-lifecycle": () => [...originLifecycle.cels],
  "segment-archive":  () => [...segmentArchive.cels],
  "sound":            () => [...sound.cels],
  "music":            () => [...music.cels],
  "defn":             () => [...defn.cels],
  "genesis":          () => [...genesis.cels],
  "checkpoint":       () => [...checkpoint.cels],
  "plastron-canvas":  () => [...plastronCanvas.cels],
  "charts":           () => [...charts.cels],
  "net":              () => [...net.cels],
  "crypto":           () => [...cryptoLib.cels],
  "seal":             () => [...seal.cels],
  "sqlite":           () => [...sqlite.cels],
  "sqlite-client":    () => [...sqliteClient.cels],
  "sqlite-demo":      () => [...sqliteDemo.cels],
  "docgraph":         () => [...docgraph.cels],
  "forcegraph":       () => [...forcegraph.cels],
};

// application/ segments. origin is the freespace host application,
// loaded by `ensureSegments(["origin"])` and parked-by-default below.
const applicationLoaders: Record<Key, () => Cel[]> = {
  "origin":           () => [...origin.cels],
};

const segmentLoaders: Record<Key, () => Cel[]> = {
  ...kernelLoaders,
  ...libraryLoaders,
  ...applicationLoaders,
};

// Folder placement = role. Derived here so it can't drift from the seed.
const roleOf = (name: Key): SegmentRole => {
  if (name in kernelLoaders)      return "kernel";
  if (name in applicationLoaders) return "application";
  return "library";
};

const seedManifests: ReadonlyArray<冊> = manifestSeed as unknown as 冊[];

/** Per-state copies of module-level seed cels. The segment modules
 *  build their cel arrays ONCE at import; without cloning, every state
 *  shares the same cel OBJECTS, and any seed with a mutable v
 *  (origin's freespace counter/draft, checkpoint's ring) or a mutated
 *  metadata (元.view's rewired inputMap) leaks across states. Runtime
 *  fields (_fn etc.) ride the shallow copy — they're stateless. */
const freshCel = (cel: Cel): Cel => {
  const out = { ...cel } as Cel;
  out.metadata = structuredClone(cel.metadata);
  if (cel.v !== undefined && typeof cel.v !== "function") {
    try { out.v = structuredClone(cel.v); } catch { /* non-cloneable runtime value — share */ }
  }
  return out;
};

export interface CreateInitialStateOptions {
  /** Bundled segments to defer: their 冊 manifests are seeded as
   *  SegmentCels (冊.<name>) (dependency walks and host UI see them) but
   *  their cels are NOT installed — a loader is parked in the reserved
   *  registry at SEGMENT_LOADERS_KEY instead. Load on demand with
   *  loadSegment / ensureSegments (also bound as cels). "kernel" can't
   *  be deferred. Default: empty — everything installs eagerly, exactly
   *  as before.
   *
   *  Reimplemented (roadmap 06) as the bundled 函: `lazy` removes those
   *  names from boot.wake, leaving them parked exactly as today. */
  lazy?: Key[];
}

// ── the bundled 函 ────────────────────────────────────────────────────────────
// 冊.json no longer drives a bespoke seeding path. It is the SOURCE from
// which the BUNDLED application 函 is generated: every bundled segment
// becomes a codeSeed entry, boot.wake lists all bundled segments (eager
// default = wake all). `lazy` removes names from boot.wake, leaving them
// parked. createInitialState applies this 函 — codeSeed-only, so the
// install is synchronous (no fetch / no formula compile / no settle), which
// is why createInitialState stays sync. The parallel manifest-seed +
// loader-park special cases collapsed into buildBundled函 + this installer.

/** Generate the BUNDLED 函 from 冊.json. Roles are derived from folder
 *  placement (roleOf), not stored in 冊.json. boot.wake = every bundled
 *  name except those in `lazy`. No boot.set — the kernel seed carries no
 *  initial value writes. */
const buildBundled函 = (lazy: Set<Key>): 函 => ({
  version: "1.0.0",
  boot: { wake: seedManifests.map((m) => m.name).filter((n) => !lazy.has(n)) },
  segments: seedManifests.map((seed) => {
    const { name: _n, ...rest } = seed;
    void _n;
    return {
      name: seed.name,
      payload: { codeSeed: true } as const,
      manifest: { ...rest, role: roleOf(seed.name) } satisfies Partial<Omit<冊, "name">>,
    };
  }),
});

export const createInitialState = (opts?: CreateInitialStateOptions): State => {
  const cels     = new Map<Key, Cel>();
  const lazy     = new Set(opts?.lazy ?? []);
  // `origin` is a HOST CHOICE, parked by default: it paints the freespace
  // starting point to "#app", which a host providing its own root does not
  // want. The origin host wakes it explicitly —
  // `await ensureSegments(state, ["origin"])` then `hydrate(state, [], [])`.
  // Pass `lazy: []` (or any list without "origin") to opt OUT of parking.
  if (opts?.lazy === undefined) lazy.add("origin");
  if (lazy.has("kernel")) {
    throw new Error("createInitialState: the \"kernel\" segment cannot be lazy.");
  }
  // A lazy name must be a bundled segment — the 函's codeSeed entries are
  // exactly the bundled segments, so an unknown lazy name can never park.
  for (const name of lazy) {
    if (!segmentLoaders[name]) {
      throw new Error(`createInitialState: lazy names unknown segment "${name}".`);
    }
  }

  const state: State = {
    cels,
    precomputeGeneration: 0,
    defGeneration: 0,
  };

  // Backward-compatible DERIVED view. The authoritative store is now the
  // SegmentCels in `cels`; `state.segments` is a read-only Map<Key, 冊>
  // materialized on each access from those cels (no longer a stored side
  // Map). Kept so host code and tests that only READ manifests keep
  // working; mutation goes through setSegmentManifest. Non-enumerable so
  // it never rides on a JSON-shaped State (dehydrate, structuredClone).
  Object.defineProperty(state, "segments", {
    get() { return segmentMap(this as State); },
    enumerable: false,
    configurable: true,
  });

  // Install the kernel segment FIRST: its internal code seed builds the
  // reserved registries (precomputedStates, compile-cache, segment.loaders,
  // segment.bundled-loaders) the steps below populate.
  const kernelLoader = segmentLoaders["kernel"];
  if (!kernelLoader) throw new Error("createInitialState: no \"kernel\" loader registered.");
  setSegmentManifest(state, { ...seedManifests.find((m) => m.name === "kernel")!, role: "kernel" });
  for (const cel of kernelLoader()) cels.set(cel.metadata.key, cel);

  // Populate the PERSISTENT bundled-loader table (the re-park source AND the
  // codeSeed-existence check hydrate函 runs). Every bundled segment's loader
  // lands here; unlike the pending registry it survives load.
  const bundled = getBundledLoaders(state);
  if (bundled) {
    for (const seed of seedManifests) {
      const loader = segmentLoaders[seed.name];
      if (loader) bundled.set(seed.name, loader);
    }
  }

  // Apply the bundled 函. codeSeed-only ⇒ install synchronously, mirroring
  // hydrate函's entry loop (manifest + eager-when-in-boot.wake, else park).
  // This REPLACES the old per-manifest seed/install/park triple — one data
  // artifact, one installer.
  const app = buildBundled函(lazy);
  const wakeRoots = new Set(app.boot.wake);
  const pending = getSegmentLoaders(state);
  for (const entry of app.segments) {
    if (entry.name === "kernel") continue;                 // already installed above
    const manifest: 冊 = {
      ...entry.manifest,
      name: entry.name,
      version: (entry.manifest?.version as string | undefined) ?? "0.0.0",
      dependencies: (entry.manifest?.dependencies as Key[] | undefined) ?? [],
    };
    setSegmentManifest(state, manifest);
    const loader = segmentLoaders[entry.name];
    if (!loader) {
      throw new Error(`createInitialState: 冊.json names segment "${entry.name}" but no loader is registered.`);
    }
    if (wakeRoots.has(entry.name)) {
      for (const cel of loader().map(freshCel)) cels.set(cel.metadata.key, cel);
    } else {
      // Lazy: park the loader (today's defer behavior — a name absent from
      // boot.wake).
      if (!pending) {
        throw new Error("createInitialState: reserved cel \"segment.loaders\" missing from kernel seed.");
      }
      pending.set(entry.name, () => loader().map(freshCel));
    }
  }

  return state;
};

export type * from "./types/index.js";
export { PRECOMPUTED_STATES_KEY, getPrecomputedIndexes } from "./kernel/卜/graph.js";
export { COMPILE_CACHE_KEY } from "./kernel/hydrate/formula.js";
export { SEGMENT_LOADERS_KEY, getSegmentLoaders } from "./kernel/segments/load.js";
export {
  resolveFn,
  precompute, precomputeOptional,
  getSegmentManifest, listSegments, findDependents,
  installDormant, dormantSegmentOf, dormantView, assertNotDormant,
  assertOneDirection,
  hydrate函, dehydrate函,
  wake, sleep, forget,
  registerSegmentLoader, loadSegment, ensureSegments, isSegmentPending,
  currentAccessor, withAccessor, isDenied, DENIED,
  validateManifests,
  celDependencies, dependentsOf, downstreamOf, upstreamOf,
  celAt, valueAt, valuesInRange, neighborsOf,
  zodToJsonSchema, jsonSchemaToZod,
} from "./kernel/index.js";
export {
  isFireable, kindOf, coordinatesFromKey, isDataCel, isDefinitionCel,
} from "./kernel/cels.js";
export {
  parseA1, parseCoordinates, parseAddress, parseRange,
  isRangeNotation, addressToKey, toRange, rangeToKeys,
} from "./kernel/卜/space.js";
export { isRangeNode } from "./kernel/卜/formula.js";
export { isWitPrimitive, isWasmHandle } from "./kernel/wit.js";
export { isCelError, makeCelError } from "./kernel/index.js";
export { buildSheet } from "./甲骨坑/library/sheet/index.js";
export { createPainter, getPainter, setPainter, el, text, memo } from "./甲骨坑/library/dom/index.js";
