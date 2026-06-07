import type {
  甲骨, Cel, ChannelEnqueue, Fn, Key, State,
} from "../../../types/index.js";
import {
  bindNativeFns, resolveFn, retireCel, precompute, runCascade, affectedFor,
  appendError, makeCelError, isCelError,
} from "../../../kernel/index.js";
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
  overwrite?: boolean;
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

// Q1: is this spec's f STRUCTURE (template/view) or seed/content?
const VIEW_PARSERS = new Set(["html-template", "html-template-ref"]);
const fIsStructural = (spec: CelSpecish): boolean => {
  if (spec.fStructural !== undefined) return spec.fStructural;
  const md = spec.metadata ?? {};
  return VIEW_PARSERS.has(String(md.parser ?? "")) || md.schema === "render-spec";
};

// Structural identity for the regeneration diff. Compares celType +
// metadata (minus ownership/segment stamps the drain itself writes) +
// f when structural. JSON deep-equal is fine — specs are plain data.
const STAMPED = new Set(["generatedBy", "segment", "key"]);
const structuralKey = (spec: CelSpecish): string => {
  const md: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec.metadata ?? {})) {
    if (!STAMPED.has(k)) md[k] = v;
  }
  return JSON.stringify({
    celType: spec.celType,
    metadata: md,
    f: fIsStructural(spec) ? spec.f : undefined,
  });
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

    // current owned set
    const owned = new Map<Key, Cel>();
    for (const [k, c] of state.cels) if (generatedBy(c) === owner) owned.set(k, c);

    // ── regeneration diff: removals first ──
    for (const [k] of owned) {
      if (!(k in req.cels)) {
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
      const sk = structuralKey(spec);
      const prior = owned.get(k);
      if (prior && !spec.reset && structuralKey({
        celType: prior.celType,
        metadata: prior.metadata as Record<string, unknown>,
        f: (prior as { f?: string }).f,
      } as CelSpecish) === sk) {
        continue; // unchanged structure — user's data plane untouched
      }
      // seed-vs-content: on a structural REPLACE of an existing owned
      // cel, carry the user's data plane forward when celType matches
      // and the spec doesn't force a reset.
      const carryV = prior && !spec.reset && prior.celType === spec.celType ? prior.v : undefined;
      const md = { ...(spec.metadata ?? {}), segment, generatedBy: owner };
      const out: Record<string, unknown> = { celType: spec.celType, metadata: md };
      if (spec.f !== undefined) out.f = spec.f;
      if (spec.v !== undefined || carryV !== undefined) out.v = carryV !== undefined ? carryV : spec.v;
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
