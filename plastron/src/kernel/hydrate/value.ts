import type { Cel, State } from "../../types/index.js";
import { resolveFn } from "../resolve-fn.js";
import { isSealedMarker } from "../seal.js";

// ============================================================================
// Schema hydration of cel values — call the schema's `hydrate` protocol
// fn on cel.v to inflate JSON-shaped values into their live form (e.g.
// JSON string → RegExp, JSON base64 → Uint8Array). Symmetric with
// dehydrateValue (../dehydrate/schema.ts).
//
// Falls through on miss — cel without a schema, schema without the
// hydrate protocol, or protocol cel not yet installed. The kernel
// treats hydrate as best-effort; whatever was on dc.metadata.v lives
// on cel.v unchanged.
//
// Runs after resolveSchemas (so cel.schema is set) and after
// compileFireable (so the protocol fns are reachable via resolveFn).
// ============================================================================

export const hydrateValue = (cel: Cel, state: State): unknown => {
  if (cel.v === null || cel.v === undefined) return cel.v;
  // Layer-2 at-rest SEAL (inverse of deflateCel's cipher). A sealed cel
  // arrives as a { __sealed: "ivB64.cipherB64" } marker. If state.sealDecipher
  // is installed (seal.lock with the right password), decrypt it back to its
  // value, then fall through to schema hydrate on the recovered value. With NO
  // decipher (locked), LEAVE the marker — the value is unreadable until unlock.
  if (isSealedMarker(cel.v)) {
    if (!state.sealDecipher) return cel.v;
    cel = { ...cel, v: state.sealDecipher(cel.v) } as Cel;
    if (cel.v === null || cel.v === undefined) return cel.v;
  }
  const fnKey = cel.schema?.protocols.hydrate;
  if (!fnKey) return cel.v;
  const fn = resolveFn(state, fnKey);
  if (!fn) return cel.v;
  return fn(cel.v);
};

export const applySchemaHydrate = (state: State): void => {
  for (const cel of state.cels.values()) {
    cel.v = hydrateValue(cel, state);
  }
};
