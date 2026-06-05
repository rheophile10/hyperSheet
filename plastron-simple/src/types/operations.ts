import type { Key } from "./index.js";
import type { Coordinate } from "./甲骨/index.js";

// Option/result types for kernel operations — kernel files carry no
// interfaces of their own; they all live here or with their domain.

export interface CompileCelBodyOpts {
  /** Evict the compile-cache entry before lookup so the source is
   *  re-parsed against current state (e.g. a named range changed). */
  evictCache?: boolean;
  /** Drop auto-wired inputMap entries (name === ref) the fresh
   *  extractDeps pass no longer reports. Off at hydrate (add-only
   *  merge); on for staleness recompiles and formula f-writes. */
  pruneAutoWired?: boolean;
}

export interface TopoLevelsOptions<T> {
  /** Only treat upstream edges whose upstream is in this set. */
  memberSet?: ReadonlySet<T>;
  /** Error prefix when a cycle is detected. Default: "Dependency cycle". */
  cycleMessagePrefix?: string;
}

/** A neighbor sample from kernel/卜/space.ts neighborsOf. */
export interface NeighborSample {
  coordinates: Coordinate[];
  key: Key;
  value: unknown;
}

export interface NeighborOptions {
  /** Chebyshev radius (default 1 — the immediate shell). */
  radius?: number;
  /** Include diagonal neighbors (default true — Moore; false = von
   *  Neumann, face-adjacent only). */
  diagonal?: boolean;
  /** Include positions with no cel (default false — skip holes). */
  includeEmpty?: boolean;
}

export interface CreateInitialStateOptions {
  /** Bundled segments to defer: manifests seed as SegmentCels (冊.<name>)
   *  but cels are NOT installed — loaders park in the reserved registry.
   *  Load on demand with loadSegment / ensureSegments. "kernel" can't
   *  be deferred. Default: empty — fully eager. */
  lazy?: Key[];
}
