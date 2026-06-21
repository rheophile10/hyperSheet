// ============================================================================
// SecretHandle — a kernel-level reference to a secret that NEVER enters the
// cel graph as a value. A handle carries only the NAME; the secret itself is
// resolved at the effect site through `resolve()` (a closure a capability —
// e.g. the vault segment — provides). The kernel guarantees a handle
// can never persist more than its name: `dehydrateValue` sanitizes it, so a
// .甲 archive or a seed can hold "🔑 anthropic" but never the key.
//
// This is the one secret-related thing that IS kernel-shaped (tier-boundary
// doctrine): it protects graph integrity and needs zero outside capability.
// The crypto and storage that BACK a secret live in a library segment.
// ============================================================================

export interface SecretHandle {
  readonly __secretHandle: true;
  /** the secret's name — the only part that may ever be seen or persisted. */
  readonly name: string;
  /** resolve the secret at the effect site; undefined when locked/absent.
   *  A closure — NEVER serialized (dehydrate drops it). */
  readonly resolve: () => string | undefined;
}

/** The sanitized, persistable shape of a handle: name only, no resolver. */
export interface SecretHandleRef {
  readonly __secretHandle: true;
  readonly name: string;
}
