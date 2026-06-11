import type { Fn, State } from "../../types/index.js";
import { resolveFn } from "../resolve-fn.js";

// settleStructural — close the "out of band genesis" seam. A generator (a cel
// whose value is a {genesis}/{defn} STRUCTURE request) enqueues its structural
// channel when it fires. Until now only origin.commit's settle loop drained
// those, so a generator re-fired by a VALUE change (not a user commit) — e.g.
// =walletKeys(walletNote) — enqueued genesis.commit but nothing materialized
// it. This runs after every data/structure mutation's cascade: drain the
// structural channels its firing enqueued, let the materialized cels fire
// (the drain's own setCelBatch cascades them), and loop until quiescent.
//
// PERFORMANCE: the FAST PATH returns immediately when no structural channel is
// pending — a pure value cascade (the bench's edit-storm hot path) never pays
// more than two Map lookups. Only a cascade that actually fired a generator
// settles.
//
// RE-ENTRANCY: a drain materializes via setCelBatch, which mutates and so
// re-enters this function; the `_settling` guard makes that nested call a
// no-op, and the TOP-LEVEL loop catches whatever the new cels enqueue. The
// pass cap bounds a pathological self-regenerating generator.

const STRUCTURAL_CHANNELS = ["genesis.commit", "defn.commit"] as const;
const MAX_SETTLE_PASSES = 16;

interface ChannelLike { hasPending?: () => boolean; drain?: () => void | Promise<void> }
const channelOf = (state: State, key: string): ChannelLike | undefined =>
  (state.cels.get(key) as { _channel?: ChannelLike } | undefined)?._channel;

export const settleStructural = async (state: State): Promise<void> => {
  const s = state as State & { _settling?: boolean };
  if (s._settling) return;
  if (!STRUCTURAL_CHANNELS.some((k) => channelOf(state, k)?.hasPending?.())) return; // fast path
  s._settling = true;
  let materialized = false;
  try {
    for (let pass = 0; pass < MAX_SETTLE_PASSES; pass++) {
      let drained = false;
      for (const key of STRUCTURAL_CHANNELS) {
        const ch = channelOf(state, key);
        if (ch?.hasPending?.()) {
          const r = ch.drain?.();
          if (r instanceof Promise) await r;
          drained = true;
        }
      }
      if (!drained) break;
      materialized = true;
    }
    // Structure materialized OUT OF BAND (a generator fired by a value change,
    // not a user commit). A host renders a fixed cell list, so it must be told
    // to refresh. The "view.refresh" cel is the generic hook a host provides
    // (origin: rewire 元.cells + repaint); off-host (tests) it's absent → no-op.
    // Runs while _settling is true, so the refresh's own writes (origin's
    // rewireView) don't re-enter this settle. Formula fns can't read the
    // registry, so the view can't derive its set purely from inputMap — this
    // imperative hook, triggered reactively here, is the bridge.
    if (materialized) {
      const refresh = resolveFn(state, "view.refresh") as Fn | undefined;
      if (refresh) { const r = refresh(state); if (r instanceof Promise) await r; }
    }
  } finally {
    s._settling = false;
  }
};
