import type { Cel, JsonValue, State } from "../../types/index.js";
import { resolveFn } from "../resolve-fn.js";
import { isSecretHandleRef, sanitizeSecretHandle } from "../secret.js";

// ============================================================================
// Schema dehydration — produce the JSON-shaped form of a live cel
// value via its schema's `dehydrate` protocol. Falls back to
// pass-through when the cel has no schema or no dehydrate protocol
// (assumes the value is already JSON-shaped; lossy if it isn't).
//
// The schema's protocol field is a Key; the fn is resolved from the
// cel registry via resolveFn at call time.
// ============================================================================

export const dehydrateValue = (cel: Cel, state: State): JsonValue | undefined => {
  if (cel.v === null || cel.v === undefined) return undefined;
  // INVARIANT (tier-boundary doctrine): a secret never enters an archive. A
  // SecretHandle persists as its NAME only — the resolver, and thus any
  // secret it could reach, is dropped. This is the kernel's secret guarantee;
  // the crypto/storage that back the secret live in a library segment.
  if (isSecretHandleRef(cel.v)) return sanitizeSecretHandle(cel.v) as unknown as JsonValue;
  const fnKey = cel.schema?.protocols.dehydrate;
  if (fnKey) {
    const fn = resolveFn(state, fnKey);
    if (fn) return fn(cel.v) as JsonValue;
  }
  return cel.v as JsonValue;
};
