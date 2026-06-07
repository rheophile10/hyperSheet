// ============================================================================
// origin-main — THE boot for the origin host (origin-segment.md).
//
// The whole host: wake the origin segment, hydrate, paint. The kernel
// surfaces 元.view at "#app" — one centered cel in freespace whose value
// is the readme. Type formulas to grow an application out of it.
// ============================================================================
import {
  createInitialState, resolveFn, precomputeOptional, createPainter, setPainter,
} from "../../plastron-simple/dist/index.js";

const state = createInitialState();
setPainter(state, createPainter(state)); // real rAF + document
await (resolveFn(state, "ensureSegments") as (s: unknown, n: string[]) => Promise<unknown>)(state, ["origin"]);
await (resolveFn(state, "hydrate") as (s: unknown, seg: unknown[], m: unknown[]) => Promise<unknown>)(state, [], []);
await (resolveFn(state, "precomputeOptional") ?? precomputeOptional)(state);
await (resolveFn(state, "runCycle") as (s: unknown) => Promise<unknown>)(state);
await (resolveFn(state, "drain") as (s: unknown, c: string) => Promise<unknown>)(state, "plastron-dom.paint");

// expose for console tinkering
(globalThis as { plastron?: unknown }).plastron = { state, resolveFn };
