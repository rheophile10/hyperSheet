import type {
  甲骨, Cel, ChannelEnqueue, Fn, Key, State,
} from "../../../types/index.js";
import {
  bindNativeFns, resolveFn, retireCel, precompute, runCascade, affectedFor,
  appendError, makeCelError, isCelError,
} from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// defn — the named-function commit channel (named-function-cels design).
//
// A BINDER formula (`=JS(A1, "times100")` / `(js src "times100")`)
// computes a definition REQUEST as its value and enqueues here; the
// drain commits it:
//
//   setCel(state, name, { celType: "EditableLambdaCel", f: source,
//     metadata: { kind, segment: <binder's>, definedBy: <binder key>,
//                 origin: <source cel key> } })
//
// Ownership (metadata.definedBy) drives the lifecycle:
//   • own-name redefinition — silent replace (no flag, ever)
//   • rename — the binder's previous definition is retired
//   • foreign name — refused (CelError on the binder) unless the
//     request carries overwrite: true, which transfers ownership
//
// BINDERS ARE AUTHORITATIVE FOR A NAME'S EXISTENCE: after commits, the
// drain sweeps — any definedBy-stamped lambda whose name has no live
// binder is retired in the same frame. Renames and deleted binder
// cells therefore never leave orphans; formulas that still call a
// retired name get a clean "undefined symbol" error at next fire.
// (A future explicit detach/pin can exempt a definition from the sweep.)
//
// Effects-by-channel: the request is computed in-cascade, the write
// happens at drain — the paint-channel pattern applied to definition.
// ============================================================================

interface DefnRequest {
  defn: true; name: string; kind: string; source: string;
  overwrite?: boolean; origin?: Key;
}

const isRequest = (v: unknown): v is DefnRequest =>
  !!v && typeof v === "object"
  && (v as { defn?: unknown }).defn === true
  && typeof (v as { name?: unknown }).name === "string"
  && typeof (v as { source?: unknown }).source === "string"
  && typeof (v as { kind?: unknown }).kind === "string";

const definedBy = (c: Cel): Key | undefined =>
  (c.metadata as { definedBy?: Key }).definedBy;

// Retirement (consumer collection + dispose + defang + delete) is the
// kernel's retireCel — promoted there so the genesis drain shares it.

const trap = (state: State, binder: Cel, message: string): void => {
  const err = makeCelError([binder.metadata.key], "DefnError", new Error(message));
  appendError(state, err);
  binder.v = err;
};

const drain: Fn = async (items: ChannelEnqueue[], stateArg?: unknown): Promise<void> => {
  const state = (stateArg ?? items[0]?.state) as State | undefined;
  if (!state) return;
  const setCel = resolveFn(state, "setCel") as Fn;
  const touched: Key[] = [];     // names (re)committed via setCel — setCel precomputes itself
  const retired: Key[] = [];     // cels deleted directly — WE owe a precompute before cascading
  const stale = new Set<Key>();  // consumers of retired names — refired to trap undefined-symbol

  // ── commits ────────────────────────────────────────────────────────
  for (const { cel: binder } of items) {
    const req = binder.v;
    if (!isRequest(req)) continue; // cel stopped being a binder — sweep below handles its definitions
    const owner = binder.metadata.key;
    const existing = state.cels.get(req.name);

    if (existing && existing.locked) {
      trap(state, binder, `defn: "${req.name}" is a locked cel — pick another name.`);
      continue;
    }
    if (existing && definedBy(existing) !== owner && !req.overwrite) {
      const by = definedBy(existing);
      trap(state, binder,
        `defn: "${req.name}" is already defined${by ? ` by ${by}` : ""} — pass TRUE to overwrite.`);
      continue;
    }

    // rename: retire this binder's previous definitions under other names
    for (const [k, c] of [...state.cels]) {
      if (k !== req.name && definedBy(c) === owner) {
        retireCel(state, k, stale);
        retired.push(k);
      }
    }

    // idempotence: same source+kind+owner → nothing to do
    const live = state.cels.get(req.name) as (Cel & { f?: string }) | undefined;
    if (live && live.f === req.source
        && (live.metadata as { kind?: string }).kind === req.kind
        && definedBy(live) === owner) continue;

    try {
      await setCel(state, req.name, {
        celType: "EditableLambdaCel",
        f: req.source,
        metadata: {
          kind: req.kind,
          segment: binder.metadata.segment,
          definedBy: owner,
          origin: req.origin,
        },
      });
      touched.push(req.name);
      // Compile failures trap-as-value on the definition cel; mirror
      // them onto the binder so the failure shows where the user typed.
      const made = state.cels.get(req.name);
      if (made && isCelError(made.v)) {
        trap(state, binder, `defn: "${req.name}" failed to compile — ${made.v.message}`);
      }
    } catch (e) {
      trap(state, binder, `defn: "${req.name}" failed to compile — ${(e as Error).message}`);
    }
  }

  // ── orphan sweep: binders are authoritative for a name's existence ──
  const liveNames = new Set<Key>();
  for (const c of state.cels.values()) {
    const v = c.v;
    if (isRequest(v)) liveNames.add(v.name);
  }
  for (const [k, c] of [...state.cels]) {
    if (definedBy(c) !== undefined && !liveNames.has(k)) {
      retireCel(state, k, stale);
      retired.push(k);
    }
  }

  // settle topology + refire consumers of everything that changed shape.
  // Stale consumers join the affected set explicitly (their edge to the
  // retired key is gone from the rebuilt index), and the cascade runs
  // UNSUPPRESSED: a retired input resolves to undefined in the rebuilt
  // _inputEntries, so input-based suppression would skip exactly the
  // cels that must refire to trap undefined-symbol.
  const seeds = [...new Set([...touched, ...retired])];
  if (retired.length > 0) precompute(state);
  if (seeds.length > 0 || stale.size > 0) {
    const affected = affectedFor(state, [...seeds, ...stale]);
    for (const k of stale) affected.add(k);
    await runCascade(state, affected);
  }
};

export const name = "defn" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["defn.drain", drain],
]));
