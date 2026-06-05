import type { Cel, CompilerCel, DehydratedCel, FireableCel, Key, SegmentCel, State, 甲骨, 冊 } from "../../types/index.js";
import { isFireable } from "../cels.js";
import { kernelClosureOf } from "../segments/graph.js";
import { segmentEntries } from "../segments/cels.js";
import { deflateCel } from "./cel.js";

/** A native-bodied cel carries its behavior as a JS function with no
 *  serializable `f` source — a code seed re-seeded from the host bundle
 *  on every boot. Dehydrating it would emit a husk (no `f`, no `_fn`),
 *  carrying no information and risking a re-hydrate that finds no body.
 *  Skip them: fireable cels whose `_fn` is bound but have no `f`, and
 *  CompilerCels whose `v` is the compiler fn with no `f` source. */
const isNativeBodied = (cel: Cel): boolean => {
  if (isFireable(cel)) {
    const fc = cel as FireableCel;
    return fc._fn !== undefined && fc.f === undefined;
  }
  if (cel.celType === "CompilerCel") {
    const cc = cel as CompilerCel;
    return typeof cc.v === "function" && cc.f === undefined;
  }
  return false;
};

// ============================================================================
// Segment dehydration — two responsibilities:
//
//   • groupCelsBySegment: walk state.cels, deflate each one, group by
//     cel.metadata.segment into 甲骨 records. Segments in the boot
//     kernel-closure are excluded (role:"kernel" + transitive deps).
//     Cels with no segment fall into "default".
//
//   • collectManifests: copy every loaded 冊 from the SegmentCels
//     (except kernel-closure members), then synthesize stub manifests
//     for any segment that has cels in state but no 冊 entry (e.g.,
//     runtime-registered lambdas that landed in "default").
//
// Both accept an optional `only` set to filter to specific segment
// names — used by dehydrate(state, { onlySegments }) so apps can
// emit just their own segment without dumping the entire boot-loaded
// kernel surface.
//
// Kernel-closure exclusion replaces the legacy magic-string check on
// `cel.metadata.segment === "kernel"`. See
// docs/1-design/3-accepted/00-ontology/segment-classification.md
// "Kernel never dehydrated" + "Multi-segment kernel".
// ============================================================================

const observedNonKernelSegments = (
  state: State,
  kernelSet: ReadonlySet<Key>,
  only?: Set<Key>,
): Set<Key> => {
  const observed = new Set<Key>();
  for (const cel of state.cels.values()) {
    if (cel.celType === "SegmentCel") continue; // manifests emit via collectManifests
    const seg = cel.metadata.segment;
    if (!seg || kernelSet.has(seg)) continue;
    if (only && !only.has(seg)) continue;
    observed.add(seg);
  }
  return observed;
};

export const groupCelsBySegment = (
  state: State,
  only?: Set<Key>,
): 甲骨[] => {
  const kernelSet = kernelClosureOf(state);
  const bySegment = new Map<Key, DehydratedCel[]>();
  for (const cel of state.cels.values()) {
    // SegmentCels are not segment PAYLOAD — manifests dehydrate via the
    // `manifests` half (collectManifests). But a DORMANT SegmentCel
    // carries its segment's already-dehydrated cels on `_dormant`: pass
    // them through verbatim (sleep already deflated them; re-deflating
    // is impossible — the live cels are gone). Cost is proportional to
    // what's awake; dormant payloads are free.
    if (cel.celType === "SegmentCel") {
      const payload = (cel as SegmentCel)._dormant;
      if (!payload) continue;
      if (kernelSet.has(payload.name)) continue;
      if (only && !only.has(payload.name)) continue;
      let bucket = bySegment.get(payload.name);
      if (!bucket) { bucket = []; bySegment.set(payload.name, bucket); }
      bucket.push(...payload.cels);
      continue;
    }
    const segKey = cel.metadata.segment ?? "default";
    if (kernelSet.has(segKey)) continue;
    if (only && !only.has(segKey)) continue;
    // Code-seed husk skip: a native-bodied cel re-seeds from the host
    // bundle, so a dehydrated husk carries no information.
    if (isNativeBodied(cel)) continue;
    let bucket = bySegment.get(segKey);
    if (!bucket) { bucket = []; bySegment.set(segKey, bucket); }
    bucket.push(deflateCel(cel, state));
  }
  const segments: 甲骨[] = [];
  for (const [name, cels] of bySegment) segments.push({ name, cels });
  return segments;
};

export const collectManifests = (
  state: State,
  only?: Set<Key>,
): 冊[] => {
  const kernelSet = kernelClosureOf(state);
  const out: 冊[] = [];
  const emitted = new Set<Key>();
  for (const [name, m] of segmentEntries(state)) {
    if (kernelSet.has(name)) continue;
    if (only && !only.has(name)) continue;
    out.push(m);
    emitted.add(name);
  }
  for (const seg of observedNonKernelSegments(state, kernelSet, only)) {
    if (emitted.has(seg)) continue;
    out.push({ name: seg, version: "0.0.0", dependencies: [], role: "library" });
  }
  return out;
};
