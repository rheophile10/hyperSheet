// ============================================================================
// origin-main — THE boot for the origin host (origin-segment.md).
//
// The whole host: wake the origin segment, hydrate, paint. The kernel
// surfaces 元.view at "#app" — one centered cel in freespace whose value
// is the readme. Type formulas to grow an application out of it.
// ============================================================================
import {
  createInitialState, resolveFn, precomputeOptional, createPainter, setPainter,
} from "../../plastron/dist/index.js";

const resolve = resolveFn as (s: unknown, k: string) => (...a: unknown[]) => Promise<unknown> | unknown;

const state = createInitialState();
setPainter(state, createPainter(state)); // real rAF + document
await (resolve(state, "ensureSegments"))(state, ["origin"]);
await (resolve(state, "hydrate"))(state, [], []);
await (resolveFn(state, "precomputeOptional") ?? precomputeOptional)(state);
await (resolve(state, "runCycle"))(state);
// boot the desktop: 元's value is a genesis (doc(desktop)…); commit drains it so
// the wallpaper + app windows materialize (hydrate/runCycle alone don't drain
// genesis). With an empty draft, commit re-applies the README = the desktop seed.
await (resolve(state, "origin.commit"))(state, "元");
await (resolve(state, "drain"))(state, "dom.paint");

// restore a previously =save()d sheet (localStorage default slot), then repaint
await (resolve(state, "origin.autoload"))(state);
await (resolve(state, "drain"))(state, "dom.paint");

// expose for console tinkering + the Playwright suite (createPainter/setPainter
// let harnesses swap in a synchronous painter for measurement)
(globalThis as { plastron?: unknown }).plastron = { state, resolveFn, createPainter, setPainter, precomputeOptional };
