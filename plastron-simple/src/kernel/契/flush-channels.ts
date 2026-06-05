import type { Channel, FlushSpec, State } from "../../types/index.js";
import { getPrecomputedIndexes } from "../卜/graph.js";

// ============================================================================
// Channel flush — drain pending channel work to completion.
//
//   spec === undefined | 'none'    no flush
//   spec === 'all'                 fixed-point drain over every channel
//   spec is a ChannelKey           drain that one channel
//
// Fixed-point drain handles channel commits that re-enter the graph via
// set/batch: a commit may trigger a new cascade that enqueues to other
// channels. We loop until no channel has pending work. Capped at
// FLUSH_MAX_ITERATIONS to surface runaway feedback as an error rather
// than hang.
//
// Within an iteration, all pending channels run concurrently — sync
// drains complete inline, async drains (IndexedDB, fetch, file write)
// run in parallel via Promise.all. Iterations stay sequential so a
// commit's writeback gets observed by the next pass rather than
// racing with the channel that triggered it.
//
// flushChannels is async-by-construction. Callers that don't pass an
// opts.flush avoid the microtask entirely by not awaiting it (see
// set/batch). Callers that do pass flush pay one microtask hop even
// when every channel is sync — acceptable, since flushing is already
// a "settle now, then continue" semantic.
// ============================================================================

// FlushSpec and SetOpts live in types/channels.ts alongside the
// Channel shapes they steer.

const FLUSH_MAX_ITERATIONS = 64;

const collectPending = (state: State): Channel[] => {
  const indexes = getPrecomputedIndexes(state);
  if (!indexes) return [];
  const pending: Channel[] = [];
  for (const cel of indexes.channels.values()) {
    const ch = cel._channel;
    if (ch && ch.hasPending()) pending.push(ch);
  }
  return pending;
};

export const flushChannels = async (
  state: State, spec: FlushSpec | undefined,
): Promise<void> => {
  if (!spec || spec === "none") return;

  if (spec === "all") {
    let iterations = 0;
    while (true) {
      if (++iterations > FLUSH_MAX_ITERATIONS) {
        throw new Error(
          `flushChannels: exceeded ${FLUSH_MAX_ITERATIONS} iterations — ` +
          `channels may be in a feedback loop (commit triggers cascade ` +
          `that re-enqueues the same channel).`,
        );
      }
      const pending = collectPending(state);
      if (pending.length === 0) return;
      const promises: Promise<void>[] = [];
      for (const ch of pending) {
        const r = ch.drain();
        if (r instanceof Promise) promises.push(r);
      }
      if (promises.length > 0) await Promise.all(promises);
    }
  }

  // Targeted drain by ChannelCel key.
  const channelCel = state.cels.get(spec);
  const ch = channelCel?.celType === "ChannelCel" ? channelCel._channel : undefined;
  if (!ch || !ch.hasPending()) return;
  const r = ch.drain();
  if (r instanceof Promise) await r;
};
