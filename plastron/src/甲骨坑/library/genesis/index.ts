import type {
  甲骨, Cel, ChannelEnqueue, Fn, Key, State,
} from "../../../types/index.js";
import {
  bindNativeFns, resolveFn, retireCel, precompute, runCascade, affectedFor,
  getSegmentManifest, setSegmentManifest,
  appendError, makeCelError, isCelError,
} from "../../../kernel/index.js";
type AccessPolicy = Record<string, unknown>;  // (vestigial: req.access/mints shape; no longer applied)
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// genesis — structure-producing formulas (genesis-segment.md, accepted).
//
// The defn pattern generalized to BATCHES of arbitrary cels: a
// generator formula's value is
//
//   { genesis: true, layer?, overwrite?, cels: Record<Key, CelSpec> }
//
// and this drain commits it — one setCelBatch per generator (one
// precompute per batch), every committed cel stamped
// `metadata.generatedBy`. GENERATORS ARE AUTHORITATIVE: regeneration
// diffs against the owned set (removed specs retire), and the sweep
// retires every generatedBy-stamped cel whose generator no longer
// requests it. Delete the formula → its bloom is unmade.
//
// Accepted answers wired in:
//   Q1 diff identity — view-shaped FormulaCels (html-template parsers /
//      render-spec schema) treat f as STRUCTURE; bare ones as seed;
//      spec.fStructural overrides.
//   Q2 atomicity — per-key commit, ONE aggregated CelError on the
//      generator listing refusals/failures.
//   Q3 layer — request.layer names the target segment; default =
//      generator's segment.
//   Q4 — ownership edges live in segment ADJACENCY only (precompute),
//      never celDependencies (a cascade edge onto an owned cel would
//      let fireCel overwrite it).
//   seed-vs-content — spec v/f apply at CREATION; regeneration
//      preserves the data plane wherever the structural spec is
//      unchanged (spec.reset forces re-seed).
// ============================================================================

interface CelSpecish {
  celType: string;
  v?: unknown;
  f?: string;
  metadata?: Record<string, unknown>;
  fStructural?: boolean;
  reset?: boolean;
}

interface GenesisRequest {
  genesis: true;
  layer?: string;
  kind?: string;                           // the segment KIND a layered mint registers (workbook/winapp/wasm/jail/…)
  overwrite?: boolean;
  access?: Partial<AccessPolicy>;          // minting: the new segment's policy (default public-get/private-set)
  reassert?: boolean;                      // re-write the policy on every regen (default: write-once)
  mints?: Record<string, Partial<AccessPolicy>>;  // composed (segment(...)): per-part-layer policies
  cels: Record<Key, CelSpecish>;
}

const isRequest = (v: unknown): v is GenesisRequest =>
  !!v && typeof v === "object"
  && (v as { genesis?: unknown }).genesis === true
  && typeof (v as { cels?: unknown }).cels === "object"
  && (v as { cels?: unknown }).cels !== null;

const generatedBy = (c: Cel): Key | undefined =>
  (c.metadata as { generatedBy?: Key }).generatedBy;

const trap = (state: State, generator: Cel, message: string): void => {
  const err = makeCelError([generator.metadata.key], "GenesisError", new Error(message));
  appendError(state, err);
  generator.v = err;
};


const drain: Fn = async (items: ChannelEnqueue[], stateArg?: unknown): Promise<void> => {
  const state = (stateArg ?? items[0]?.state) as State | undefined;
  if (!state) return;
  const setCelBatch = resolveFn(state, "setCelBatch") as Fn;
  const touched: Key[] = [];
  const retired: Key[] = [];
  const stale = new Set<Key>();

  for (const { cel: generator } of items) {
    const req = generator.v;
    if (!isRequest(req)) continue; // ex-generator — sweep handles its bloom
    const owner = generator.metadata.key;
    const segment = req.layer ?? generator.metadata.segment;
    const errors: string[] = [];

    // (the 访 access-policy minting was removed — segments are no longer closures;
    // req.access / req.mints are accepted for compatibility but no longer applied.)

    // REGISTER the minted segment (segment-nav-and-memory.md keystone): a layered
    // genesis is a real document segment — give it a `冊` manifest {kind, role:user}
    // so it's a `state.segments` member: segments() lists it, wake/sleep manage it,
    // documentSegments/the boot-set guard use the registry not a heuristic. Idempotent
    // (write-once; regeneration keeps the manifest). Composed parts (mints) each register.
    const register = (name: Key, kind: string): void => {
      if (!getSegmentManifest(state, name)) {
        setSegmentManifest(state, { name, version: "0.0.0", description: `${kind} (minted)`, dependencies: [], role: "user", kind });
      }
    };
    if (req.layer) register(req.layer, String(req.kind ?? "document"));
    if (req.mints) for (const part of Object.keys(req.mints)) register(part, "document");

    // current owned set
    const owned = new Map<Key, Cel>();
    for (const [k, c] of state.cels) if (generatedBy(c) === owner) owned.set(k, c);

    // ── regeneration diff: removals first ──
    // SPARSE grids: a cel BORN into a sheet's address space (committed after
    // genesis, stamped with this generator's ownership) is USER DATA — it is
    // never in the sparse spec, but it survives regeneration as long as the
    // generator still declares the sheet (its `<seg>.dims` is in the spec)
    // AND the address is within the declared range (a shrink sweeps
    // out-of-range cels, exactly like the old eager blanks). The final sweep
    // below still reclaims it when the generator itself goes away.
    const colIdx = (s: string): number => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
    const inDeclaredRange = (k: Key): boolean => {
      const dot = k.lastIndexOf(".");
      if (dot <= 0) return false;
      const m = /^([A-Z]+)(\d+)$/.exec(k.slice(dot + 1));
      if (!m) return false;
      const dimsSpec = req.cels[`${k.slice(0, dot)}.dims`] as { v?: { rows?: unknown; cols?: unknown } } | undefined;
      if (!dimsSpec) return false;
      const rows = Number(dimsSpec.v?.rows) || 0, cols = Number(dimsSpec.v?.cols) || 0;
      return Number(m[2]) <= rows && colIdx(m[1]!) <= cols;
    };
    for (const [k] of owned) {
      if (!(k in req.cels)) {
        if (inDeclaredRange(k)) continue;
        retireCel(state, k, stale);
        retired.push(k);
      }
    }

    // ── additions / structural changes (per-key, errors aggregated) ──
    const batch: Record<Key, unknown> = {};
    for (const [k, spec] of Object.entries(req.cels)) {
      const existing = state.cels.get(k);
      if (existing && existing.locked) {
        errors.push(`"${k}" is a locked cel`);
        continue;
      }
      if (existing && generatedBy(existing) !== owner && !req.overwrite) {
        const by = generatedBy(existing);
        errors.push(`"${k}" is ${by ? `generated by ${by}` : "not this generator's"} — overwrite: true to take it`);
        continue;
      }
      const prior = owned.get(k);
      // Seeds apply at CREATION. An existing owned cel is the USER's now
      // — their value OR their formula (a grid cell they typed `=A1*2`
      // into is a FormulaCel; the seed was an empty ValueCel). Leave it
      // untouched on regeneration so worksheets are fillable; only
      // `reset: true` re-applies the seed. Regeneration's job is to ADD
      // missing cels and (below) RETIRE removed ones, not to overwrite.
      if (prior && !spec.reset) continue;
      // preserve a stamped per-part segment (segment() composition) over the
      // request-wide segment, so a composed window's cels land in its OWN segment.
      const md = { ...(spec.metadata ?? {}), segment: (spec.metadata as { segment?: string } | undefined)?.segment ?? segment, generatedBy: owner };
      const out: Record<string, unknown> = { celType: spec.celType, metadata: md };
      if (spec.f !== undefined) out.f = spec.f;
      if (spec.v !== undefined) out.v = spec.v;
      batch[k] = out;
      touched.push(k);
    }

    if (Object.keys(batch).length > 0) {
      try {
        await setCelBatch(state, batch);
        for (const k of Object.keys(batch)) {
          const made = state.cels.get(k);
          if (made && isCelError(made.v)) errors.push(`"${k}" failed to compile — ${made.v.message}`);
        }
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    if (errors.length > 0) {
      trap(state, generator, `genesis: ${errors.join("; ")}`);
    }
  }

  // ── sweep: generators are authoritative for their bloom's existence ──
  const liveOwners = new Set<Key>();
  for (const c of state.cels.values()) {
    if (isRequest(c.v)) liveOwners.add(c.metadata.key);
  }
  for (const [k, c] of [...state.cels]) {
    const owner = generatedBy(c);
    if (owner !== undefined && !liveOwners.has(owner)) {
      retireCel(state, k, stale);
      retired.push(k);
    }
  }

  // settle + refire (unsuppressed — the defn lesson: retired inputs
  // resolve undefined and suppression would skip the trap-bearers)
  const seeds = [...new Set([...touched, ...retired])];
  if (retired.length > 0) precompute(state);
  if (seeds.length > 0 || stale.size > 0) {
    const affected = affectedFor(state, [...seeds, ...stale]);
    for (const k of stale) affected.add(k);
    await runCascade(state, affected);
  }
};

export const name = "genesis" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["genesis.drain", drain],
]));
