// ============================================================================
// Layer-2 at-rest SEAL marker — the kernel's zero-dep half.
//
// A SEALED segment's cel value is never written to an archive in plaintext.
// When `state.sealCipher` is installed (by the seal LIBRARY), dehydrate
// replaces the cel's dehydrated value with a SealedMarker carrying the
// ciphertext envelope ("ivB64.cipherB64"); hydrate, when `state.sealDecipher`
// is installed, decrypts it back. With no decipher (locked), the marker is
// left intact and the value stays unreadable.
//
// The kernel defines only the MARKER SHAPE + its guard here — it holds no
// cipher and imports nothing crypto. The seal library supplies the hooks
// (segment-access-capabilities.md, Layer 2).
// ============================================================================

/** The graph-safe at-rest form of a sealed value: the AES-GCM envelope
 *  ("ivB64.cipherB64"), no plaintext. Round-trips through JSON as-is. */
export interface SealedMarker {
  readonly __sealed: string;
}

export const isSealedMarker = (v: unknown): v is SealedMarker =>
  !!v && typeof v === "object"
  && typeof (v as { __sealed?: unknown }).__sealed === "string";

/** Build the marker from a ciphertext envelope. */
export const sealedMarker = (envelope: string): SealedMarker => ({ __sealed: envelope });
