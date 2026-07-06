import type {
  甲骨, Cel, ChannelEnqueue, Fn, Key, State,
} from "../../../types/index.js";
import {
  bindNativeFns, resolveFn, disposeCel, precompute, precomputeOptional, kernelClosureOf,
  appendError, makeCelError,
} from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// checkpoint — recovery for a world where formulas edit structure
// (checkpoint-undo.md, accepted: snapshot-only v1, whole-user-space).
//
// A checkpoint is a dehydrate snapshot held in an in-memory ring
// (N=20) on a kernel-segment cel (excluded from dehydrate — snapshots
// don't nest). Restore = wipe every non-kernel-closure cel, rehydrate
// the snapshot, precompute, cycle — the wake path, so compiled fns and
// painter state rebuild themselves.
//
//   =checkpoint("name")  — formula form: value is a request, committed
//                          by this channel's drain (effects-at-drain).
//   checkpoint.restore   — DISPATCHED fn only (accepted Q4: a formula
//                          computing a restore mid-cascade is a footgun).
//   checkpoint.delta     — two snapshot names → { added, removed,
//                          changed } cel-key lists (review-gate food).
// ============================================================================

const RING_MAX = 20;

interface Snapshot { name: string; at: number; segments: unknown[]; manifests: unknown[] }

const ringOf = (state: State): Snapshot[] => {
  const cel = state.cels.get("checkpoint.ring");
  if (!cel) return [];
  if (!Array.isArray(cel.v)) cel.v = [];
  return cel.v as Snapshot[];
};

const takeSnapshot = async (state: State, name: string): Promise<Snapshot> => {
  const dehydrate = resolveFn(state, "dehydrate") as Fn;
  const out = JSON.parse(JSON.stringify(await dehydrate(state))) as { segments: unknown[]; manifests: unknown[] };
  const snap: Snapshot = { name, at: ringOf(state).length, segments: out.segments, manifests: out.manifests };
  const ring = ringOf(state);
  const existing = ring.findIndex((s) => s.name === name);
  if (existing >= 0) ring.splice(existing, 1);
  ring.push(snap);
  while (ring.length > RING_MAX) ring.shift();
  return snap;
};

const drain: Fn = async (items: ChannelEnqueue[], stateArg?: unknown): Promise<void> => {
  const state = (stateArg ?? items[0]?.state) as State | undefined;
  if (!state) return;
  for (const { cel } of items) {
    const req = cel.v as { checkpoint?: unknown; name?: unknown } | undefined;
    if (!req || req.checkpoint !== true || typeof req.name !== "string") continue;
    // FIRST-WINS: the formula declares "a checkpoint named X exists".
    // It refires every cycle; retaking would roll the moment forward to
    // include everything since (found the hard way: the snapshot kept
    // swallowing the cels it was meant to protect against). Re-take
    // explicitly via checkpoint.snapshot (which replaces).
    if (ringOf(state).some((sn) => sn.name === req.name)) continue;
    try {
      await takeSnapshot(state, req.name);
    } catch (e) {
      const err = makeCelError([cel.metadata.key], "CheckpointError", e);
      appendError(state, err);
      cel.v = err;
    }
  }
};

/** The `checkpoint` vocabulary fn — its VALUE is the request; the
 *  parser genesis/channel machinery isn't needed: metadata.channel on
 *  the formula attaches via the head-marker the same way genesis heads
 *  do (metadata.checkpoint on this cel; see 甲骨.json + parser note). */
const checkpointFn: Fn = (name: unknown) => ({
  checkpoint: true,
  name: typeof name === "string" && name !== "" ? name : "checkpoint",
});

const snapshotNow: Fn = async (state: State, name?: unknown) =>
  takeSnapshot(state, typeof name === "string" && name !== "" ? name : "checkpoint");

const restore: Fn = async (state: State, nameArg?: unknown) => {
  const ring = ringOf(state);
  const name = typeof nameArg === "string" && nameArg !== "" ? nameArg : ring[ring.length - 1]?.name;
  const snap = ring.findLast ? ring.findLast((s) => s.name === name) : [...ring].reverse().find((s) => s.name === name);
  if (!snap) throw new Error(`checkpoint: no snapshot named "${String(name)}"`);

  // wipe DOCUMENT STATE: what dehydrate would emit. Kernel-closure
  // segments stay, and so do native-bodied husks (library code cels —
  // _fn with no source, fn-valued compilers): dehydrate skips them, so
  // a restore that wiped them could never bring them back.
  const keep = kernelClosureOf(state);
  const nativeBodied = (c: Cel): boolean => {
    const f = (c as { f?: string }).f;
    if ((c as { _fn?: unknown })._fn !== undefined && f === undefined) return true;
    return c.celType === "CompilerCel" && typeof c.v === "function";
  };
  for (const [k, c] of [...state.cels]) {
    const seg = c.metadata.segment;
    if (seg !== undefined && keep.has(seg)) continue;
    if (nativeBodied(c)) continue;
    disposeCel(c, state);
    state.cels.delete(k);
  }
  precompute(state);

  // rehydrate the snapshot — the wake path rebuilds compiled fns
  const hydrate = resolveFn(state, "hydrate") as Fn;
  await hydrate(state, snap.segments, snap.manifests);
  // precomputeOptional is a kernel EXPORT, not a cel — a resolveFn lookup here
  // returned undefined and silently skipped this pass on every restore.
  await precomputeOptional(state);
  await (resolveFn(state, "runCycle") as Fn)(state);
  return state;
};

/** Cel-level delta between two snapshots (or a snapshot and live state
 *  when `to` is omitted): { added, removed, changed } key lists. */
const delta: Fn = (state: State, fromName: unknown, toName?: unknown) => {
  const ring = ringOf(state);
  const grab = (n: unknown): Map<string, string> | undefined => {
    const s = [...ring].reverse().find((x) => x.name === n);
    if (!s) return undefined;
    const m = new Map<string, string>();
    for (const seg of s.segments as { cels?: { key: string }[] }[]) {
      for (const dc of seg.cels ?? []) m.set(dc.key, JSON.stringify(dc));
    }
    return m;
  };
  const a = grab(fromName);
  if (!a) throw new Error(`checkpoint: no snapshot named "${String(fromName)}"`);
  let b: Map<string, string>;
  if (toName !== undefined) {
    const m = grab(toName);
    if (!m) throw new Error(`checkpoint: no snapshot named "${String(toName)}"`);
    b = m;
  } else {
    b = new Map();
    const keep = kernelClosureOf(state);
    for (const [k, c] of state.cels) {
      const seg = c.metadata.segment;
      if (seg !== undefined && keep.has(seg)) continue;
      b.set(k, JSON.stringify({ celType: c.celType, v: c.v, f: (c as { f?: string }).f }));
    }
  }
  const added: Key[] = [], removed: Key[] = [], changed: Key[] = [];
  for (const k of b.keys()) if (!a.has(k)) added.push(k);
  for (const k of a.keys()) {
    if (!b.has(k)) removed.push(k);
    else if (toName !== undefined && a.get(k) !== b.get(k)) changed.push(k);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
};

const list: Fn = (state: State) => ringOf(state).map((s) => s.name);

export const name = "checkpoint" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["checkpoint",          checkpointFn],
  ["checkpoint.drain",    drain],
  ["checkpoint.snapshot", snapshotNow],
  ["checkpoint.restore",  restore],
  ["checkpoint.delta",    delta],
  ["checkpoint.list",     list],
]));
