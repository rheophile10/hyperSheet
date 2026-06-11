import type { Cel, CelMetadata, DehydratedCel, State, ValueCel } from "../../types/index.js";
import { isFireable } from "../cels.js";
import { resolveFn } from "../resolve-fn.js";
import { accessPolicyKeyOf, accessPolicyOf } from "../segments/access.js";
import { dehydrateValue } from "./schema.js";

// Run cel.schema?.protocols.sourceDehydrate on a fireable cel's `f`
// string. Symmetric with dehydrateValue (which acts on cel.v). Used by
// the built-in `lambda-source` schema to split multi-line source back
// into a string[] for readable .json output. Falls through on miss:
// no schema, no sourceDehydrate protocol, or the protocol fn cel
// hasn't been hydrated yet.
const dehydrateSource = (
  cel: Cel,
  f: string,
  state: State,
): string | string[] => {
  const fnKey = cel.schema?.protocols.sourceDehydrate;
  if (!fnKey) return f;
  const fn = resolveFn(state, fnKey);
  if (!fn) return f;
  return fn(f) as string | string[];
};

// Cel → DehydratedCel. Narrows on celType to pick up kind-specific
// fields (wave, dynamic, f). Locked is on BaseCel so it's always
// readable.
export const deflateCel = (c: Cel, state: State): DehydratedCel => {
  const metadata: CelMetadata = { ...c.metadata };
  let v = dehydrateValue(c, state);
  // Layer-2 at-rest SEAL. A SEALED segment's value never enters the archive
  // in plaintext: when the seal LIBRARY has installed state.sealCipher, swap
  // the dehydrated value for a { __sealed: "ivB64.cipherB64" } marker. The
  // kernel stays zero-dep — it calls the hook, never a cipher. No hook (the
  // default), or a non-sealed segment, or no value → unchanged.
  const seg = c.metadata.segment;
  // Never seal the segment's OWN access-policy cel (访.<seg>) — it must stay
  // readable so hydrate (and any re-dehydrate) can tell the segment is sealed.
  if (v !== undefined && state.sealCipher && seg && c.metadata.key !== accessPolicyKeyOf(seg)
      && accessPolicyOf(state, seg).getSealed) {
    v = state.sealCipher(seg, v) as typeof v;
  }
  if (v !== undefined) metadata.v = v;
  const dc: DehydratedCel = { key: metadata.key, celType: c.celType, metadata };
  if (c.locked !== undefined) dc.locked = c.locked;
  if (isFireable(c)) {
    if (c.wave    !== undefined) dc.wave    = c.wave;
    if (c.dynamic !== undefined) dc.dynamic = c.dynamic;
    if (c.f       !== undefined) dc.f       = dehydrateSource(c, c.f, state);
  } else if (c.celType === "ValueCel") {
    const wave = (c as ValueCel).wave;
    if (wave !== undefined) dc.wave = wave;
  } else if (c.celType === "CompilerCel") {
    const f = c.f;
    if (f !== undefined) dc.f = f;
  }
  return dc;
};
