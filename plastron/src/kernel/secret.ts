import type { SecretHandle, SecretHandleRef } from "../types/index.js";

// Runtime side of SecretHandle (the type lives in types/secret.ts). These are
// kernel exports so any segment can MINT a handle (the wallet does) and the
// dehydrate path can SANITIZE one — without a parallel registry and without
// the secret ever touching a cel value. See types/secret.ts for the why.

/** Mint a handle: a graph-safe reference carrying the name + a resolver the
 *  caller closes over. The resolver is invoked only at the effect site. */
export const secretHandle = (name: string, resolve: () => string | undefined): SecretHandle =>
  ({ __secretHandle: true, name, resolve });

export const isSecretHandle = (v: unknown): v is SecretHandle =>
  !!v && typeof v === "object"
  && (v as { __secretHandle?: unknown }).__secretHandle === true
  && typeof (v as { resolve?: unknown }).resolve === "function";

/** The ONLY shape a handle may persist as — name, no resolver, no secret.
 *  Also matches an already-sanitized ref rehydrated from an archive. */
export const sanitizeSecretHandle = (h: { name: string }): SecretHandleRef =>
  ({ __secretHandle: true, name: h.name });

/** A persisted/rehydrated handle ref (name only) — has the marker but no
 *  live resolver. displayCell renders it as 🔑 name; it cannot resolve. */
export const isSecretHandleRef = (v: unknown): v is SecretHandleRef =>
  !!v && typeof v === "object"
  && (v as { __secretHandle?: unknown }).__secretHandle === true;
