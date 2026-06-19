import type { State, Key, Cel } from "../../../types/index.js";

// segment-io — consolidated serialize/transport for SEGMENTS (segment-kinds-and-io.md,
// accepted). Scope is keyed on BOOT-SET MEMBERSHIP, not role: the boot substrate
// (the bundled manifests woken at boot, registered in state.segments) is never
// exported; everything minted since — the document stack — is.
//
// This first slice is the discriminator the export scope + import name-guard both
// need. dump/load (formula + archive) land next (see the roadmap task).

/** SUBSTRATE (boot set): a known/active segment in state.segments — the bundled
 *  manifests. A minted document segment (cels()/winapp()/… genesis) is never
 *  registered there, so this is the boot-set test. Boot-set names are RESERVED:
 *  import/define MUST refuse a name for which this is true. */
export const isSubstrateSegment = (state: State, name: Key): boolean =>
  !!(state as { segments?: Set<Key> }).segments?.has?.(name);

/** The DOCUMENT segments — what segment-io exports: segments minted at runtime by
 *  a generator (their cels carry metadata.generatedBy), excluding the boot
 *  substrate. `generatedBy` also filters runtime infra (e.g. win.geom / win.topz,
 *  set directly with no generator owner) out of the export set.
 *
 *  Interim discriminator until `kind` lands on the 冊 manifest (the one open
 *  question in segment-kinds-and-io.md); `kind`-present will subsume it. */
export const documentSegments = (state: State): Key[] => {
  const owned = new Set<Key>();
  for (const [, c] of state.cels as Map<Key, Cel>) {
    const md = c.metadata as { segment?: Key; generatedBy?: unknown } | undefined;
    const seg = md?.segment;
    if (seg && md?.generatedBy != null && !isSubstrateSegment(state, seg)) owned.add(seg);
  }
  return [...owned].sort();
};
