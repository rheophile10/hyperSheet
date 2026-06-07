import type { Key } from "../index.js";
import type { ChannelCelMetadata, DehydratedChannel } from "../甲骨/index.js";
import type { State } from "../state.js";
import type { BaseCel } from "./baseCel.js";
import type { Cel } from "./cel.js";

export type ChannelKey = Key;

export interface ChannelEnqueue {
  cel: Cel;
  state: State;
}

/** Hydrated channel — the live form, built at precompute from the
 *  DehydratedChannel descriptor on v. */
export interface Channel {
  /** The live queue — exposed so precompute's buildChannel can carry
   *  pending enqueues across index rebuilds (a drain that commits cels
   *  precomputes mid-flush; effects must survive it). */
  _queue?: ChannelEnqueue[];
  enqueue: (args: ChannelEnqueue) => void;
  hasPending: () => boolean;
  drain: () => void | Promise<void>;
  dispose: () => void;
}

/** DEFINITION plane. v is the dehydrated descriptor; _channel the live
 *  handler precompute rebuilds. */
export interface ChannelCel extends BaseCel {
  celType: "ChannelCel";
  metadata: ChannelCelMetadata;
  v: DehydratedChannel;
  _channel?: Channel;
}

/** What 契/flushChannels should drain after a write settles. */
export type FlushSpec = ChannelKey | "all" | "none";

/** Common opts for write/effect fns that want to flush channels after
 *  the cascade settles. */
export interface SetOpts {
  flush?: FlushSpec;
}
