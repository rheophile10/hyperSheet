import type { State, Key, Cel } from "../../../types/index.js";
import { resolveFn, dehydrate, getSegmentManifest } from "../../../kernel/index.js";

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
  for (const [, c] of state.cels as Map<Key, Cel>) {
    const md = c.metadata as { segment?: Key; generatedBy?: unknown } | undefined;
    if (md?.segment && md?.generatedBy != null) owned.add(md.segment);
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

/** Load a `甲骨` archive string into `state` (hydrate). WHOLESALE: same-key cels
 *  are replaced. Returns the segment names installed. Caller enforces the
 *  boot-set-name guard (origin task) — this is the raw materialiser. */
export const loadArchive = async (state: State, json: string): Promise<Key[]> => {
  const arch = JSON.parse(json) as { segments?: Array<{ name: Key }>; manifests?: unknown[]; formatVersion?: number };
  const hydrate = resolveFn(state, "hydrate") as (s: State, seg: unknown, man: unknown, v?: number) => Promise<unknown>;
  await hydrate(state, arch.segments ?? [], arch.manifests ?? [], arch.formatVersion);
  return (arch.segments ?? []).map((s) => s.name);
};
