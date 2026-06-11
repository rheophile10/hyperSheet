import type { 甲骨, Cel, Fn, Key, State } from "../../../types/index.js";
import { bindNativeFns, sealedMarker, isSealedMarker } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };
import { aesGcmEncrypt, aesGcmDecrypt } from "./aes-gcm.js";

// ============================================================================
// seal — the LIBRARY half of Layer-2 at-rest encryption of SEALED segments
// (segment-access-capabilities.md, Layer 2). The kernel is stateless + zero-dep
// and only KNOWS the marker shape ({ __sealed: "ivB64.cipherB64" }) + calls two
// hooks on state. This library SUPPLIES those hooks:
//
//   seal.lock(password)  → derive a data key (PBKDF2-HMAC-SHA-256) held
//                          module-scope, install state.sealCipher (AES-256-GCM
//                          encrypt → marker) + state.sealDecipher (marker →
//                          value). Dehydrate of a get-SEALED cel now writes
//                          ciphertext; hydrate decrypts it back.
//   seal.lock() / "")    → CLEAR the hooks (re-lock). A subsequent dehydrate
//                          leaves plaintext markers alone; hydrate of an
//                          existing marker LEAVES it sealed (unreadable).
//
// THE SPLIT: key derivation (PBKDF2) happens ONCE at seal.lock time and may be
// async, so it uses WebCrypto's native, fast PBKDF2. The seal HOOKS themselves
// must be SYNCHRONOUS (the kernel calls them inline inside the synchronous
// deflateCel / hydrateValue paths, where WebCrypto's async subtle can't reach),
// so the AEAD that runs per-cel is the synchronous, zero-dep, pure-JS AES-256-
// GCM in aes-gcm.ts (verified interoperable with WebCrypto). The password / data
// key never become cel values and never enter an archive — only the ciphertext
// marker does.
// ============================================================================

// Module-scope derived key (32 raw AES-256 bytes), or null when locked. Never a
// cel value, never dehydrated — exactly the wallet/net module-state pattern.
let dataKey: Uint8Array | null = null;

// PBKDF2 parameters. Fixed (module-constant) salt so the SAME password derives
// the SAME data key across fresh States — an at-rest archive sealed with "pw"
// must decrypt with "pw" on a brand-new state. (A per-archive random salt would
// have to travel in the archive header; v1 keeps it simple — the password is
// the only secret.)
const KDF_ITERS = 600_000;
const KDF_SALT = utf8("plastron.seal.v1");
const KEY_LEN = 32;

function utf8(s: string): Uint8Array { return new TextEncoder().encode(s); }
function fromUtf8(b: Uint8Array): string { return new TextDecoder().decode(b); }

// base64 (btoa/atob exist in Bun + browser)
function b64enc(b: Uint8Array): string { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); }
function b64dec(s: string): Uint8Array { const raw = atob(s); const o = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) o[i] = raw.charCodeAt(i); return o; }

// WebCrypto, structurally narrowed (tsconfig lib has no DOM) — same approach as
// the crypto library. We use it ONLY for the one-shot PBKDF2 at lock time.
interface SubtleLike {
  importKey(format: string, key: Uint8Array, alg: unknown, extractable: boolean, usages: string[]): Promise<unknown>;
  deriveBits(alg: unknown, base: unknown, length: number): Promise<ArrayBuffer>;
}
interface CryptoLike { subtle: SubtleLike; getRandomValues<T extends ArrayBufferView>(a: T): T }
const cryptoHost = (): CryptoLike => {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!c?.subtle) throw new Error("seal: WebCrypto (crypto.subtle) unavailable in this host");
  return c;
};

const randomBytes = (n: number): Uint8Array => cryptoHost().getRandomValues(new Uint8Array(n));

// Derive the 32-byte AES-256 data key from the password (PBKDF2-HMAC-SHA-256).
// WebCrypto's native PBKDF2 — fast + async, run once at lock time.
const deriveDataKey = async (pw: string): Promise<Uint8Array> => {
  const { subtle } = cryptoHost();
  const base = await subtle.importKey("raw", utf8(pw), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: KDF_SALT, iterations: KDF_ITERS }, base, KEY_LEN * 8);
  return new Uint8Array(bits);
};

// ── the cipher hook: value → { __sealed: "ivB64.cipherB64" } ────────────────
// The value is JSON-encoded (it has already been schema-dehydrated to a
// JSON-shaped form by the time deflateCel calls us), then AEAD-encrypted.
const cipher = (_segment: Key, v: unknown): unknown => {
  if (!dataKey) return v;                                   // defensive: locked → no-op
  if (isSealedMarker(v)) return v;                          // already sealed
  const iv = randomBytes(12);
  const plain = utf8(JSON.stringify(v ?? null));
  const { ct, tag } = aesGcmEncrypt(dataKey, iv, plain);
  // store iv.(cipher||tag) — tag appended so decrypt is self-describing.
  const body = new Uint8Array(ct.length + tag.length);
  body.set(ct); body.set(tag, ct.length);
  return sealedMarker(`${b64enc(iv)}.${b64enc(body)}`);
};

// ── the decipher hook: { __sealed } → value (or throw on wrong key) ─────────
const decipher = (v: unknown): unknown => {
  if (!dataKey) return v;                                   // defensive: locked → leave sealed
  if (!isSealedMarker(v)) return v;
  const [ivB64, bodyB64] = v.__sealed.split(".");
  if (!ivB64 || !bodyB64) return v;
  const iv = b64dec(ivB64);
  const body = b64dec(bodyB64);
  const ct = body.subarray(0, body.length - 16);
  const tag = body.subarray(body.length - 16);
  const pt = aesGcmDecrypt(dataKey, iv, ct, tag);
  if (pt === null) {
    // wrong password / tamper: AEAD auth failed. LEAVE it sealed (unreadable)
    // rather than throw — a state locked with the wrong key behaves like a
    // locked one for this value.
    return v;
  }
  return JSON.parse(fromUtf8(pt)) as unknown;
};

// ── seal.lock(password?) — install (password) or clear (none) the hooks ─────
const lockFn: Fn = (async (state: State, password?: unknown): Promise<string> => {
  const pw = typeof password === "string" ? password : "";
  if (pw === "") {
    dataKey = null;
    state.sealCipher = undefined;
    state.sealDecipher = undefined;
    return "seal: locked (hooks cleared — sealed values stay encrypted at rest and unreadable on load)";
  }
  dataKey = await deriveDataKey(pw);
  state.sealCipher = cipher;
  state.sealDecipher = decipher;
  return "seal: unlocked (sealed segments encrypt on dehydrate, decrypt on hydrate)";
}) as Fn;

// seal.locked() — is this state currently locked? (introspection)
const lockedFn: Fn = ((state: State): boolean => !state.sealCipher) as Fn;

export const name = "seal" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["seal.lock", lockFn],
  ["seal.locked", lockedFn],
]));
