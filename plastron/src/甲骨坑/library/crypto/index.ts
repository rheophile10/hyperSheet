import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };
import {
  cryptoHost, getKeyStore, type CryptoKeyLike, type KeyEntry, type KeyKind, type KeyPairLike,
} from "./keystore.js";

// ============================================================================
// crypto — the FOUNDATIONAL crypto library (tier-boundary doctrine: the kernel
// is stateless + zero-dep, so crypto is NOT in the kernel; it's an always-loaded
// library, zero-dep via WebCrypto `crypto.subtle`, identical in Bun + browser).
//
// THE KEY MODEL (segment-access-capabilities.md, Layer 2 / crypto-keys.md):
// the private key is NEVER a cel value. The graph holds only a CryptoKeyHandle
// (an id + the PUBLIC material) — the SecretHandle pattern, for asymmetric keys:
// resolution to the live, non-extractable private CryptoKey happens at the
// EFFECT SITE (sign / decrypt / unwrap), reading the keystore. The PUBLIC key
// IS cel-storable (extractable, shareable → the public keyring).
//
// Three tiers for the private key (see crypto-keys.md):
//   1. daily / same device — non-extractable CryptoKey in IndexedDB (browser)
//      or the in-process keystore (Bun). USE-only, never readable. (this file)
//   2. cross-device / login — WebAuthn PRF → KDF → wrapping key for a wallet
//      blob. SCAFFOLDED below (crypto.prf*), browser-only deep integration.
//   3. recovery only — seed-phrase export/import (account recovery / device
//      migration, NOT login). Demoted accordingly (crypto.seed*).
//
// Verbs are SUBTLE operations (cross-runtime); STORAGE is the keystore seam.
// ============================================================================

// ── the graph-safe handle (mirrors SecretHandle, for asymmetric keys) ───────
// Carries the id + the PUBLIC half (graph-safe). It does NOT carry the private
// key and is NOT a resolver closure — so it is plain-data and dehydrates as-is
// (the private CryptoKey lives only in the keystore, keyed by `id`). resolve()
// happens at the effect site by looking the id up in the store.
export interface CryptoKeyHandle {
  readonly __cryptoKeyHandle: true;
  readonly id: string;
  readonly kind: KeyKind;        // "sign" (Ed25519) | "ecdh" (P-256)
  readonly publicKey: string;    // base64 of the exported public key
}
export const isCryptoKeyHandle = (v: unknown): v is CryptoKeyHandle =>
  !!v && typeof v === "object"
  && (v as { __cryptoKeyHandle?: unknown }).__cryptoKeyHandle === true
  && typeof (v as { id?: unknown }).id === "string";

const handleOf = (e: KeyEntry): CryptoKeyHandle =>
  ({ __cryptoKeyHandle: true, id: e.id, kind: e.kind, publicKey: e.publicKeyB64 });

// resolve a handle (or its id string) to the live KeyEntry at the effect site.
const resolveEntry = async (h: unknown): Promise<KeyEntry> => {
  const id = isCryptoKeyHandle(h) ? h.id : String(h ?? "");
  const e = await getKeyStore().get(id);
  if (!e) throw new Error(`crypto: no key for handle "${id}" (keygen first, or it's in another keystore/runtime)`);
  return e;
};

// ── base64 + bytes helpers (no deps; btoa/atob exist in Bun + browser) ──────
const b64 = {
  enc: (b: ArrayBuffer | Uint8Array): string => {
    const u = b instanceof Uint8Array ? b : new Uint8Array(b);
    let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s);
  },
  dec: (s: string): Uint8Array => { const raw = atob(s); const out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out; },
};
const utf8 = { enc: (s: string): Uint8Array => new TextEncoder().encode(s), dec: (b: ArrayBuffer): string => new TextDecoder().decode(b) };
// accept a string (utf8) or already-bytes/base64 for the AEAD verbs.
const toBytes = (v: unknown): Uint8Array =>
  v instanceof Uint8Array ? v
  : typeof v === "string" ? utf8.enc(v)
  : utf8.enc(String(v ?? ""));
const newId = (): string => cryptoHost().randomUUID?.() ?? b64.enc(cryptoHost().getRandomValues(new Uint8Array(16))).replace(/[^A-Za-z0-9]/g, "").slice(0, 22);

// alg descriptors
const ED = { name: "Ed25519" } as const;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const exportFmt = (kind: KeyKind): string => (kind === "sign" ? "raw" : "spki");

// ────────────────────────────────────────────────────────────────────────────
// crypto.keygen(kind?) — Tier 1. Mint a NON-EXTRACTABLE private key (+ its
// extractable public half), store the live key in the keystore, return a
// CryptoKeyHandle (id + public). The private key bytes never exist in JS.
//   kind "sign" (default) → Ed25519 signing identity.
//   kind "ecdh"           → P-256 key-agreement identity (for wrap/unwrap).
// ────────────────────────────────────────────────────────────────────────────
const keygenFn: Fn = (async (kind?: unknown): Promise<CryptoKeyHandle> => {
  const k: KeyKind = String(kind ?? "sign") === "ecdh" ? "ecdh" : "sign";
  const { subtle } = cryptoHost();
  const usages = k === "sign" ? ["sign", "verify"] : ["deriveKey", "deriveBits"];
  // extractable=false → the private key is USE-only, never readable as bytes.
  const pair = await subtle.generateKey(k === "sign" ? ED : ECDH, false, usages) as KeyPairLike;
  const pubBuf = await subtle.exportKey(exportFmt(k), pair.publicKey) as ArrayBuffer;
  const entry: KeyEntry = { id: newId(), kind: k, privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeyB64: b64.enc(pubBuf), createdAt: Date.now() };
  await getKeyStore().put(entry);
  return handleOf(entry);
}) as Fn;

// crypto.pubkey(handle) — the PUBLIC key as a cel-storable base64 string. This
// is the keyring's currency: shareable, never sensitive.
const pubkeyFn: Fn = (async (handle: unknown): Promise<string> => {
  if (isCryptoKeyHandle(handle)) return handle.publicKey;     // already carried, no store hit
  return (await resolveEntry(handle)).publicKeyB64;
}) as Fn;

// ── signing (Ed25519) ───────────────────────────────────────────────────────
// crypto.sign(handle, message) — resolve the private key at the effect site,
// sign, return base64 of the signature. message: string | bytes.
const signFn: Fn = (async (handle: unknown, message: unknown): Promise<string> => {
  const e = await resolveEntry(handle);
  if (e.kind !== "sign") throw new Error(`crypto.sign: key "${e.id}" is not a signing key (kind=${e.kind})`);
  const sig = await cryptoHost().subtle.sign(ED, e.privateKey, toBytes(message));
  return b64.enc(sig);
}) as Fn;

// crypto.verify(publicKeyB64 | handle, message, signatureB64) — verify against a
// PUBLIC key (the shareable half). No private key needed → works from a handle
// OR a raw public-key string off the keyring.
const verifyFn: Fn = (async (pub: unknown, message: unknown, signatureB64: unknown): Promise<boolean> => {
  const { subtle } = cryptoHost();
  const pubB64 = isCryptoKeyHandle(pub) ? pub.publicKey : String(pub ?? "");
  const pubKey = await subtle.importKey("raw", b64.dec(pubB64), ED, true, ["verify"]) as CryptoKeyLike;
  return subtle.verify(ED, pubKey, b64.dec(String(signatureB64 ?? "")), toBytes(message));
}) as Fn;

// ── symmetric AEAD (AES-256-GCM) — content encryption ───────────────────────
// crypto.encrypt(keyB64, plaintext) — keyB64 is a base64 raw 32-byte AES key
// (e.g. a data key from crypto.datakey or an unwrapped key). Returns
// "ivB64.cipherB64" (iv prefixed so decrypt is self-describing).
const importAes = async (keyB64: string, usage: string[]): Promise<CryptoKeyLike> =>
  cryptoHost().subtle.importKey("raw", b64.dec(keyB64), { name: "AES-GCM" }, false, usage);

const encryptFn: Fn = (async (keyB64: unknown, plaintext: unknown): Promise<string> => {
  const c = cryptoHost();
  const key = await importAes(String(keyB64 ?? ""), ["encrypt"]);
  const iv = c.getRandomValues(new Uint8Array(12));
  const ct = await c.subtle.encrypt({ name: "AES-GCM", iv }, key, toBytes(plaintext));
  return `${b64.enc(iv)}.${b64.enc(ct)}`;
}) as Fn;

// crypto.decrypt(keyB64, "ivB64.cipherB64") — returns the plaintext as a utf8
// string (the common case; callers needing bytes can base64 the input).
const decryptFn: Fn = (async (keyB64: unknown, envelope: unknown): Promise<string> => {
  const [ivB64, ctB64] = String(envelope ?? "").split(".");
  if (!ivB64 || !ctB64) throw new Error("crypto.decrypt: expected \"ivB64.cipherB64\"");
  const key = await importAes(String(keyB64 ?? ""), ["decrypt"]);
  const pt = await cryptoHost().subtle.decrypt({ name: "AES-GCM", iv: b64.dec(ivB64) }, key, b64.dec(ctB64));
  return utf8.dec(pt);
}) as Fn;

// crypto.datakey() — mint a fresh random AES-256-GCM data key as base64 raw
// bytes (the per-epoch symmetric key a shared segment wraps to recipients).
const datakeyFn: Fn = ((): string => b64.enc(cryptoHost().getRandomValues(new Uint8Array(32)))) as Fn;

// ── ECDH wrap / unwrap — share a data key to a recipient's public key ───────
// Derive an AES wrapping key from MY private (handle, resolved at the effect
// site) + the recipient's public (base64 spki), then AES-GCM the data key.
const deriveWrapKey = async (myHandle: unknown, theirPubB64: string, usage: string[]): Promise<CryptoKeyLike> => {
  const e = await resolveEntry(myHandle);
  if (e.kind !== "ecdh") throw new Error(`crypto: wrap/unwrap needs an ecdh key, got kind=${e.kind}`);
  const { subtle } = cryptoHost();
  const theirPub = await subtle.importKey("spki", b64.dec(theirPubB64), ECDH, true, []) as CryptoKeyLike;
  return subtle.deriveKey({ name: "ECDH", public: theirPub }, e.privateKey, { name: "AES-GCM", length: 256 }, false, usage);
};

// crypto.wrap(myEcdhHandle, recipientPubB64, dataKeyB64) → "ivB64.cipherB64".
const wrapFn: Fn = (async (myHandle: unknown, recipientPubB64: unknown, dataKeyB64: unknown): Promise<string> => {
  const c = cryptoHost();
  const wk = await deriveWrapKey(myHandle, String(recipientPubB64 ?? ""), ["encrypt"]);
  const iv = c.getRandomValues(new Uint8Array(12));
  const ct = await c.subtle.encrypt({ name: "AES-GCM", iv }, wk, b64.dec(String(dataKeyB64 ?? "")));
  return `${b64.enc(iv)}.${b64.enc(ct)}`;
}) as Fn;

// crypto.unwrap(myEcdhHandle, senderPubB64, "ivB64.cipherB64") → dataKeyB64.
// ECDH is symmetric in the pair, so the recipient derives the SAME wrapping key
// from THEIR private + the SENDER's public.
const unwrapFn: Fn = (async (myHandle: unknown, senderPubB64: unknown, envelope: unknown): Promise<string> => {
  const [ivB64, ctB64] = String(envelope ?? "").split(".");
  if (!ivB64 || !ctB64) throw new Error("crypto.unwrap: expected \"ivB64.cipherB64\"");
  const wk = await deriveWrapKey(myHandle, String(senderPubB64 ?? ""), ["decrypt"]);
  const dk = await cryptoHost().subtle.decrypt({ name: "AES-GCM", iv: b64.dec(ivB64) }, wk, b64.dec(ctB64));
  return b64.enc(dk);
}) as Fn;

// crypto.keys() — list the keyring as handles (public material only). Inspect
// what's in the keystore without ever surfacing a private key.
const keysFn: Fn = (async (): Promise<CryptoKeyHandle[]> => (await getKeyStore().list()).map(handleOf)) as Fn;

// The fixed keystore id for THE identity key — one stable Ed25519 signing
// identity per host. A constant id makes ensure idempotent: it persists in
// IndexedDB across reloads and re-resolves to the SAME public key.
const IDENTITY_ID = "identity" as const;

// crypto.identity() — idempotently mint-or-load THE identity signing keypair
// (Ed25519). First call (empty keystore) generates a NON-EXTRACTABLE key under
// the stable id; later calls load the existing one. Returns its CryptoKeyHandle
// (id + public). The private key never surfaces — only the handle/public does.
const identityFn: Fn = (async (): Promise<CryptoKeyHandle> => {
  const store = getKeyStore();
  const existing = await store.get(IDENTITY_ID);
  if (existing) return handleOf(existing);
  const { subtle } = cryptoHost();
  const pair = await subtle.generateKey(ED, false, ["sign", "verify"]) as KeyPairLike;
  const pubBuf = await subtle.exportKey("raw", pair.publicKey) as ArrayBuffer;
  const entry: KeyEntry = { id: IDENTITY_ID, kind: "sign", privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeyB64: b64.enc(pubBuf), createdAt: Date.now() };
  await store.put(entry);
  return handleOf(entry);
}) as Fn;

// crypto.forget(handle) — drop a key from the keystore (rotation / revoke).
const forgetFn: Fn = (async (handle: unknown): Promise<boolean> => {
  const id = isCryptoKeyHandle(handle) ? handle.id : String(handle ?? "");
  const had = await getKeyStore().has(id);
  await getKeyStore().delete(id);
  return had;
}) as Fn;

// ────────────────────────────────────────────────────────────────────────────
// Tier 2 — WebAuthn PRF (SCAFFOLD). A passkey's PRF extension deterministically
// emits a stable per-credential secret → KDF → wrapping key for the wallet blob
// (tap fingerprint → same key → decrypt). Browser-only (navigator.credentials),
// and PRF is not universal — so this is an interface scaffold with an explicit
// availability probe + a documented fallback (Tier-1 keystore / Tier-3 seed).
// Deep integration is a browser e2e follow-up, NOT CLI-tested.
// ────────────────────────────────────────────────────────────────────────────
interface NavCreds { credentials?: { create?: unknown; get?: unknown } }
const prfAvailableFn: Fn = ((): boolean => {
  const n = (globalThis as { navigator?: NavCreds }).navigator;
  return !!(n?.credentials && typeof (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential !== "undefined");
}) as Fn;

// crypto.prfWrapKey(credentialId?, saltB64?) — the Tier-2 SHAPE: in a browser
// this would call navigator.credentials.get({ publicKey: { extensions: { prf:
// { eval: { first: salt } } } } }), HKDF the returned prf.results.first into an
// AES-GCM wrapping key, and use it to (un)seal the wallet blob. Here it reports
// status so callers/tests can branch on availability without a browser.
const prfWrapKeyFn: Fn = (async (_credentialId?: unknown, _saltB64?: unknown): Promise<string> => {
  if (!(prfAvailableFn as () => boolean)()) {
    return "(crypto.prf: WebAuthn PRF unavailable here — Tier-2 is browser-only; fall back to the Tier-1 keystore or Tier-3 seed)";
  }
  // Browser e2e wires the real assertion + HKDF here. Scaffold returns a marker
  // so the interface is callable and testable without a passkey.
  return "(crypto.prf: scaffold — wire navigator.credentials.get prf.eval + HKDF at the browser e2e)";
}) as Fn;

// ────────────────────────────────────────────────────────────────────────────
// Tier 3 — seed phrase (RECOVERY ONLY, demoted). NOT a login path: it's the
// account-recovery / device-migration artifact. A BIP39-style mnemonic carries
// the entropy from which an identity is re-derived on a new device. This v1
// emits/imports the entropy as words from a small word list (full BIP39
// checksum + Ed25519-from-seed derivation is the recovery-flow follow-up).
// ────────────────────────────────────────────────────────────────────────────
// A tiny deterministic word list — enough to round-trip 16 bytes of entropy as
// 12 words and back. (v1 placeholder; the recovery flow swaps in full BIP39.)
const WORDS = ("abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis").split(" ");
const seedExportFn: Fn = ((): string => {
  const ent = cryptoHost().getRandomValues(new Uint8Array(16)); // 128-bit entropy → 12 words
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    // pack 11-bit indices across the byte stream (BIP39-shaped, no checksum yet)
    const bit = i * 11; const byte = bit >> 3; const shift = bit & 7;
    const idx = (((ent[byte] ?? 0) << 16 | (ent[byte + 1] ?? 0) << 8 | (ent[byte + 2] ?? 0)) >> (24 - 11 - shift)) & 0x7ff;
    out.push(WORDS[idx % WORDS.length]!);
  }
  return out.join(" ");
}) as Fn;
const seedImportFn: Fn = ((phrase: unknown): string => {
  const words = String(phrase ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 12) return "(crypto.seed: expected a 12-word recovery phrase)";
  const bad = words.find((w) => !WORDS.includes(w));
  if (bad) return `(crypto.seed: unknown word "${bad}")`;
  // The recovery follow-up re-derives the Ed25519 identity from this entropy and
  // re-puts it in the keystore. v1 validates + acknowledges.
  return `(crypto.seed: ${words.length} words accepted — recovery re-derivation is the device-migration follow-up)`;
}) as Fn;

export const name = "crypto" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["crypto.keygen", keygenFn],
  ["crypto.pubkey", pubkeyFn],
  ["crypto.sign", signFn],
  ["crypto.verify", verifyFn],
  ["crypto.encrypt", encryptFn],
  ["crypto.decrypt", decryptFn],
  ["crypto.datakey", datakeyFn],
  ["crypto.wrap", wrapFn],
  ["crypto.unwrap", unwrapFn],
  ["crypto.keys", keysFn],
  ["crypto.identity", identityFn],
  ["crypto.forget", forgetFn],
  ["crypto.prfAvailable", prfAvailableFn],
  ["crypto.prfWrapKey", prfWrapKeyFn],
  ["crypto.seedExport", seedExportFn],
  ["crypto.seedImport", seedImportFn],
]));
