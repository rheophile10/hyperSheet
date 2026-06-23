import type { 甲骨, Cel, ChannelEnqueue, Fn, Key, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// origin-lifecycle — the single public lifecycle surface for origin documents
// (segment-lifecycle umbrella). It does NOT re-implement persistence: it
// composes the shipped ops (user-space-ops + segment-store + kernel) behind
// one descriptor channel.
//
// Slots are FormulaCels. An origin-application carries .open/.edit/.new/.save/
// .load/.close slots and an origin-user carries .flush — each evaluates to a
// pure {op,…} DESCRIPTOR (built by the origin.* verbs, which declare
// metadata.emitsTo:"origin.io") and emits to origin.io. The descriptor never
// carries state; the drain holds it and dispatches:
//
//   new   → newUserSpace(state, name, app)
//   save  → saveUserSpace(state, name)
//   open  → hydrate-closure(state, app)            (app standalone, no doc)
//   close → closeUserSpace(state, name)
//   load  → sha/compat GATE, then loadUserSpace(state, name, version)
//   flush → optional saveUserSpace (the kernel evicts the cels itself)
//
// Triggering is DISCRETE: origin.fire(state, slotKey) enqueues a slot's current
// descriptor and drains (the host's save/open/… actions); the kernel flush hook
// is the same trigger for the <seg>.flush slot.
// ============================================================================

interface Descriptor {
  op: "new" | "save" | "load" | "open" | "close" | "flush" | "edit";
  name?: string; app?: string; version?: string; save?: boolean;
}

const isDescriptor = (v: unknown): v is Descriptor =>
  !!v && typeof v === "object" && typeof (v as { op?: unknown }).op === "string";

// ── descriptor builders (PURE — no state) ───────────────────────────────────
const mkNew:   Fn = (app, name)      => ({ op: "new",   app: String(app), name: String(name) });
const mkSave:  Fn = (name)           => ({ op: "save",  name: String(name) });
const mkLoad:  Fn = (name, version)  => ({ op: "load",  name: String(name), version: version === undefined ? undefined : String(version) });
const mkOpen:  Fn = (app)            => ({ op: "open",  app: String(app) });
const mkClose: Fn = (name)           => ({ op: "close", name: String(name) });
const mkFlush: Fn = (name, save)     => ({ op: "flush", name: name === undefined ? undefined : String(name), save: !!save });

// The load GATE: an origin-user pins its parent application's sha. It loads only
// if the pinned sha matches the app's current sha OR is in the app's `compat`
// list. Lenient when either side is unstamped (no sha yet) — strict once both
// are present. Refuses (throws) on a hard mismatch — the user file cannot load.
const loadWithGate = async (state: State, name: string, version?: string): Promise<void> => {
  const get  = resolveFn(state, "store.get")     as Fn;
  const load = resolveFn(state, "loadUserSpace") as Fn;
  const probe = (await get(state, name, version)) as { manifest?: { applications?: Key[]; applicationSha?: string } } | undefined;
  const pinned  = probe?.manifest?.applicationSha;
  const appName = probe?.manifest?.applications?.[0];
  if (pinned && appName) {
    // Read the app's CANONICAL (stored) sha + compat list — sha is a
    // persistence property, so the store is authoritative.
    const appStored = (await get(state, appName)) as { manifest?: { sha?: string; compat?: string[] } } | undefined;
    const cur = appStored?.manifest?.sha;
    const compat = appStored?.manifest?.compat ?? [];
    if (cur && pinned !== cur && !compat.includes(pinned)) {
      throw new Error(
        `origin.load: "${name}" pins application sha ${pinned}, incompatible with "${appName}" ` +
        `(current ${cur}; not in compat list); the user file cannot load.`,
      );
    }
  }
  await load(state, name, version);
};

const run = async (state: State, d: Descriptor): Promise<void> => {
  const call = (k: Key): Fn => resolveFn(state, k) as Fn;
  switch (d.op) {
    case "new":   await call("newUserSpace")(state, d.name, d.app); break;
    case "save":  await call("saveUserSpace")(state, d.name); break;
    case "open":  await call("hydrate-closure")(state, d.app); break;
    case "close": await call("closeUserSpace")(state, d.name); break;
    case "load":  await loadWithGate(state, String(d.name), d.version); break;
    case "flush": if (d.save && d.name) await call("saveUserSpace")(state, d.name); break;
    case "edit":  throw new Error("origin.edit: the editor application is being overhauled — not implemented.");
    default: break;
  }
};

const drain: Fn = async (items: ChannelEnqueue[], stateArg?: unknown): Promise<void> => {
  const state = (stateArg ?? items[0]?.state) as State | undefined;
  if (!state) return;
  for (const { cel } of items) {
    const d = cel.v;
    if (isDescriptor(d)) await run(state, d);
  }
};

// Discrete trigger: enqueue a slot's current descriptor to its declared
// channel(s), then drain origin.io. The slot's `.v` is its last-computed
// descriptor (parameterized by whatever cels it references).
const fire: Fn = async (state: State, slotKey: unknown): Promise<State> => {
  const slot = state.cels.get(String(slotKey));
  if (!slot) throw new Error(`origin.fire: no slot cel "${String(slotKey)}"`);
  for (const chKey of slot.metadata.channel ?? []) {
    const ch = state.cels.get(chKey);
    if (ch?.celType === "ChannelCel") ch._channel?.enqueue({ cel: slot, state });
  }
  await (resolveFn(state, "drain") as Fn)(state, "origin.io");
  return state;
};

export const name = "origin-lifecycle" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["origin.io.drain", drain],
  ["origin.new",   mkNew],
  ["origin.save",  mkSave],
  ["origin.load",  mkLoad],
  ["origin.open",  mkOpen],
  ["origin.close", mkClose],
  ["origin.flush", mkFlush],
  ["origin.fire",  fire],
]));
