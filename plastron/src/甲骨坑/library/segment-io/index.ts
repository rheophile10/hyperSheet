import type { State, Key } from "../../../types/index.js";
import { resolveFn, dehydrate, getSegmentManifest, setSegmentManifest, segmentEntries } from "../../../kernel/index.js";

// segment-io — consolidated serialize/transport for SEGMENTS (segment-kinds-and-io.md,
// accepted). Scope is keyed on BOOT-SET MEMBERSHIP, not role: the boot substrate
// (the bundled manifests woken at boot, registered in state.segments) is never
// exported; everything minted since — the document stack — is.
//
// This first slice is the discriminator the export scope + import name-guard both
// need. dump/load (formula + archive) land next (see the roadmap task).

const SUBSTRATE_ROLES = new Set(["kernel", "library", "application"]);

/** SUBSTRATE: a segment whose manifest role is kernel/library/application — the
 *  bundled boot substrate. These names are RESERVED: import/define MUST refuse a
 *  name for which this is true (you can't mint/import over `net`/`dom`/`origin`/…).
 *  Role (not `state.segments` membership) is the stable signal — membership grows
 *  as imports register, so it can't tell boot-substrate from an imported segment.
 *  (The origin task captures the exact boot-set snapshot; role approximates it.) */
export const isSubstrateSegment = (state: State, name: Key): boolean => {
  const m = getSegmentManifest(state, name) as { role?: string } | undefined;
  return !!m && SUBSTRATE_ROLES.has(String(m.role ?? ""));
};

/** The DOCUMENT segments — what segment-io exports: segments minted by a generator
 *  (their cels carry `metadata.generatedBy`). This intrinsic mark survives a
 *  dump→load round-trip (the substrate, seeded not minted, never carries it) and
 *  filters runtime infra (e.g. win.geom, set directly with no owner).
 *
 *  Caveat: origin's BOOT furniture (desktop / readme window) is also genesis-minted,
 *  so a full-boot state over-includes it. A `kind` field on the 冊 manifest is the
 *  precise fix (the one open question in segment-kinds-and-io.md) and will subsume
 *  this heuristic. */
export const documentSegments = (state: State): Key[] => {
  const owned = new Set<Key>();
  // The uniform rule (segment-nav-and-memory.md keystone): a document segment is
  // any registered segment with role "user" — minted (genesis registers a
  // {kind, role:user} manifest) AND imported (loadArchive does too). No heuristic.
  for (const [name, m] of segmentEntries(state) as Iterable<[Key, { role?: string }]>) {
    if (m?.role === "user") owned.add(name);
  }
  return [...owned].sort();
};

// ── archive form (lossless 甲骨 dehydrate/hydrate) ───────────────────────────
// The FORMULA form (=segment(…) re-derivation via buildSeed) is origin-coupled
// and lands with the origin import/export task; the archive form is the
// substrate-free path and lives here.

/** Dump ONE segment to a lossless `甲骨` archive string — its live cels, exactly
 *  (compiled bodies, schemas, values), restricted to that segment. */
export const dumpArchive = (state: State, seg: Key): string =>
  JSON.stringify(dehydrate(state, { onlySegments: [seg] }));

/** Dump SEVERAL segments to one `甲骨` archive string — whole-doc export passes
 *  `documentSegments(state)` (every minted segment; the substrate stays out). */
export const dumpSegments = (state: State, segs: Key[]): string =>
  JSON.stringify(dehydrate(state, { onlySegments: segs }));

/** The segment names a `甲骨` archive string would install — for the boot-set
 *  name-guard BEFORE loading (refuse a substrate-name collision). */
export const archiveSegmentNames = (json: string): Key[] => {
  try { return ((JSON.parse(json) as { segments?: Array<{ name: Key }> }).segments ?? []).map((s) => s.name); }
  catch { return []; }
};

// ── completeness gate ───────────────────────────────────────────────────────
// The reusable check behind SEGMENT(json) / import / paste: is every segment +
// cel complete enough to hydrate? A dehydrated cel needs a key, a known
// celType, metadata, and — for the source tiers — a body `f`. (ValueCel value
// is `dc.v ?? metadata.v ?? null` at inflate, so it is never "incomplete".)

const KNOWN_CELTYPES = new Set<string>([
  "ValueCel", "EditableLambdaCel", "LockedLambdaCel", "SchemaCel",
  "FormulaCel", "CompilerCel", "ChannelCel", "RangeCel", "SegmentCel",
]);

export interface ArchiveProblem { where: string; message: string; }

/** Validate a `甲骨` archive (JSON string OR already-parsed object). Returns the
 *  list of completeness problems — empty means it is safe to hydrate. */
export const validateArchive = (archive: string | unknown): ArchiveProblem[] => {
  const problems: ArchiveProblem[] = [];
  let arch: { segments?: Array<{ name?: unknown; cels?: unknown }> };
  try {
    arch = (typeof archive === "string" ? JSON.parse(archive) : archive) as typeof arch;
  } catch (e) {
    return [{ where: "(archive)", message: `not valid JSON: ${(e as Error).message}` }];
  }
  const segments = arch?.segments;
  if (!Array.isArray(segments)) return [{ where: "(archive)", message: "missing a `segments` array" }];
  for (const seg of segments) {
    const segName = typeof seg?.name === "string" ? seg.name : undefined;
    if (!segName) problems.push({ where: "(segment)", message: "segment missing a string `name`" });
    const cels = seg?.cels;
    if (cels !== undefined && !Array.isArray(cels)) {
      problems.push({ where: segName ?? "(segment)", message: "`cels` is not an array" });
      continue;
    }
    for (const c of (cels ?? []) as Array<Record<string, unknown>>) {
      const key = typeof c?.key === "string" && c.key.length > 0 ? c.key : undefined;
      const at = key ?? `${segName ?? "?"}:(unkeyed)`;
      if (!key) problems.push({ where: at, message: "cel missing a non-empty string `key`" });
      const ct = c?.celType;
      if (typeof ct !== "string" || !KNOWN_CELTYPES.has(ct)) {
        problems.push({ where: at, message: `cel has unknown celType ${JSON.stringify(ct)}` });
        continue;
      }
      if (c?.metadata === undefined || typeof c.metadata !== "object") {
        problems.push({ where: at, message: "cel missing `metadata`" });
      }
      if (ct === "FormulaCel" || ct === "EditableLambdaCel") {
        const f = c?.f;
        if (typeof f !== "string" && !Array.isArray(f)) {
          problems.push({ where: at, message: `${ct} missing its source body \`f\`` });
        }
      }
    }
  }
  return problems;
};

/** Load a `甲骨` archive string into `state` (hydrate). WHOLESALE: same-key cels
 *  are replaced. Returns the segment names installed. Caller enforces the
 *  boot-set-name guard (origin task) — this is the raw materialiser. */
export const loadArchive = async (state: State, json: string): Promise<Key[]> => {
  const arch = JSON.parse(json) as { segments?: Array<{ name: Key; cels?: Array<{ metadata?: Record<string, unknown> }> }>; manifests?: unknown[]; formatVersion?: number };
  // Completeness gate: refuse an incomplete archive BEFORE it touches state.
  const problems = validateArchive(arch);
  if (problems.length > 0) {
    throw new Error(
      `loadArchive: incomplete archive — ${problems.map((p) => `${p.where}: ${p.message}`).join("; ")}`,
    );
  }
  const segments = arch.segments ?? [];
  // An imported segment is STATIC DATA, not a live genesis bloom: strip
  // metadata.generatedBy so the genesis drain can't sweep its cels as orphaned
  // (their original generator is absent here). Mark each segment role:"user" so
  // it stays a tracked, stompable DOCUMENT segment (never substrate).
  for (const s of segments) {
    for (const c of (s.cels ?? [])) { if (c.metadata) delete c.metadata.generatedBy; }
  }
  const hydrate = resolveFn(state, "hydrate") as (s: State, seg: unknown, man: unknown, v?: number) => Promise<unknown>;
  await hydrate(state, segments, arch.manifests ?? [], arch.formatVersion);
  for (const s of segments) setSegmentManifest(state, { name: s.name, version: "0.0.0", description: "imported document segment", dependencies: [], role: "user" });
  return segments.map((s) => s.name);
};
