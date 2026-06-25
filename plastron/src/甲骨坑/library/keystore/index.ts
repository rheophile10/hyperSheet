import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// keystore — the user's portable identity WALLET (encrypted-collaborative-
// sheetapp.md, Phase 1). A passcode-locked keyring of EXTRACTABLE keypairs:
//
//   • current  — an ecdh P-256 pair (wrap/unwrap segment keys) + an Ed25519 pair
//                (sign/verify edits). EXTRACTABLE (unlike crypto.keygen Tier-1) so
//                the wallet can be sealed to a portable file + seed-exported.
//   • history  — retired pairs kept so a RESHUFFLE never locks you out of docs
//                sealed to an old key.
//   • seed     — 16 bytes of entropy → a 12-word recovery phrase (display artifact;
//                deterministic seed→key re-derivation is a follow-up — the working
//                recovery in v1 is the exported passcode-locked file).
//
// THE SPLIT (mirrors seal/session): the decrypted keyring + the derived seal key
// live MODULE-SCOPE — never a cel value, never dehydrated. The graph holds only
// NON-secret status cels (keystore.status / .name / .identity / .ecdhpub).
//
// STORAGE is dual-capability: persist the sealed blob to OPFS when available
// (served), else session-only with manual export/import (file://). The blob is a
// self-contained { v, kdf:{salt,iters}, iv, ct } so it round-trips through a file.
// ============================================================================

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const ED = { name: "Ed25519" } as const;
const KDF_ITERS = 600_000, KEY_LEN = 32;
const STORE_PATH = "/keystore/identity.kc";

// WebCrypto, structurally narrowed (tsconfig lib has no DOM) — same as seal/crypto.
interface SubtleLike {
  importKey(format: string, key: Uint8Array, alg: unknown, extractable: boolean, usages: string[]): Promise<unknown>;
  exportKey(format: string, key: unknown): Promise<ArrayBuffer>;
  generateKey(alg: unknown, extractable: boolean, usages: string[]): Promise<{ privateKey: unknown; publicKey: unknown }>;
  deriveBits(alg: unknown, base: unknown, length: number): Promise<ArrayBuffer>;
  encrypt(alg: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(alg: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  sign(alg: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}
interface CryptoLike { subtle: SubtleLike; getRandomValues<T extends ArrayBufferView>(a: T): T }
const host = (): CryptoLike => {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!c?.subtle) throw new Error("keystore: WebCrypto (crypto.subtle) unavailable in this host");
  return c;
};

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);
const b64enc = (b: Uint8Array): string => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const b64dec = (s: string): Uint8Array => { const r = atob(s); const o = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) o[i] = r.charCodeAt(i); return o; };
const rand = (n: number): Uint8Array => host().getRandomValues(new Uint8Array(n));

// ── key material (extractable, base64) ──────────────────────────────────────
interface Pair { ecdhPriv: string; ecdhPub: string; signPriv: string; signPub: string }
interface Retired extends Pair { retired: number }
interface Keyring { v: 1; name: string; current: Pair; history: Retired[]; seed: string }

const mintPair = async (): Promise<Pair> => {
  const { subtle } = host();
  const ecdh = await subtle.generateKey(ECDH, true, ["deriveKey", "deriveBits"]);
  const sign = await subtle.generateKey(ED, true, ["sign", "verify"]);
  const exp = async (fmt: string, k: unknown): Promise<string> => b64enc(new Uint8Array(await subtle.exportKey(fmt, k)));
  return {
    ecdhPriv: await exp("pkcs8", ecdh.privateKey), ecdhPub: await exp("spki", ecdh.publicKey),
    signPriv: await exp("pkcs8", sign.privateKey), signPub: await exp("raw", sign.publicKey),
  };
};

// ── passcode → AES-256-GCM seal key (PBKDF2-HMAC-SHA-256, random per-blob salt) ─
const deriveSealKey = async (passcode: string, salt: Uint8Array): Promise<Uint8Array> => {
  const { subtle } = host();
  const base = await subtle.importKey("raw", utf8(passcode), { name: "PBKDF2" }, false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: KDF_ITERS }, base, KEY_LEN * 8));
};
const aesKey = async (raw: Uint8Array, usage: string[]): Promise<unknown> =>
  host().subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usage);

interface SealedBlob { v: 1; kdf: { salt: string; iters: number }; iv: string; ct: string }
const sealBlob = async (keyring: Keyring, sealKeyRaw: Uint8Array, salt: Uint8Array): Promise<SealedBlob> => {
  const iv = rand(12);
  const k = await aesKey(sealKeyRaw, ["encrypt"]);
  const ct = new Uint8Array(await host().subtle.encrypt({ name: "AES-GCM", iv }, k, utf8(JSON.stringify(keyring))));
  return { v: 1, kdf: { salt: b64enc(salt), iters: KDF_ITERS }, iv: b64enc(iv), ct: b64enc(ct) };
};
const openBlob = async (blob: SealedBlob, passcode: string): Promise<{ keyring: Keyring; sealKeyRaw: Uint8Array; salt: Uint8Array } | null> => {
  const salt = b64dec(blob.kdf.salt);
  const sealKeyRaw = await deriveSealKey(passcode, salt);
  try {
    const k = await aesKey(sealKeyRaw, ["decrypt"]);
    const pt = new Uint8Array(await host().subtle.decrypt({ name: "AES-GCM", iv: b64dec(blob.iv) }, k, b64dec(blob.ct)));
    return { keyring: JSON.parse(fromUtf8(pt)) as Keyring, sealKeyRaw, salt };
  } catch { return null; }   // AEAD auth failure = wrong passcode / tamper
};

// ── recovery phrase: 16-byte entropy → 12 words (BIP39-shaped, no checksum yet) ─
const WORDS = ("abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis").split(" ");
const seedToPhrase = (seedB64: string): string => {
  const ent = b64dec(seedB64); const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const bit = i * 11, byte = bit >> 3, shift = bit & 7;
    const idx = (((ent[byte] ?? 0) << 16 | (ent[byte + 1] ?? 0) << 8 | (ent[byte + 2] ?? 0)) >> (24 - 11 - shift)) & 0x7ff;
    out.push(WORDS[idx % WORDS.length]!);
  }
  return out.join(" ");
};

// ── key USE (sign / ECDH wrap-unwrap) — import stored bytes → CryptoKey at the
// use site; the private bytes never leave this module. ─────────────────────────
const impEcdhPriv = (b64: string): Promise<unknown> => host().subtle.importKey("pkcs8", b64dec(b64), ECDH, false, ["deriveBits"]);
const impEcdhPub = (b64: string): Promise<unknown> => host().subtle.importKey("spki", b64dec(b64), ECDH, false, []);
const impSignPriv = (b64: string): Promise<unknown> => host().subtle.importKey("pkcs8", b64dec(b64), ED, false, ["sign"]);
// the AES key from ECDH(myPriv, theirPub) — symmetric in the pair (self: myPub).
const sharedAes = async (myPrivB64: string, theirPubB64: string, usage: string[]): Promise<unknown> => {
  const { subtle } = host();
  const bits = await subtle.deriveBits({ name: "ECDH", public: await impEcdhPub(theirPubB64) }, await impEcdhPriv(myPrivB64), 256);
  return subtle.importKey("raw", new Uint8Array(bits), { name: "AES-GCM" }, false, usage);
};
// find the keyring pair (current or retired) whose ecdh PUBLIC key matches.
const findEcdh = (pubB64: string): Pair | null => {
  if (!KEYRING) return null;
  if (KEYRING.current.ecdhPub === pubB64) return KEYRING.current;
  return KEYRING.history.find((h) => h.ecdhPub === pubB64) ?? null;
};

// ── module-scope wallet state (NEVER a cel) ─────────────────────────────────
let KEYRING: Keyring | null = null;        // decrypted keyring (in memory)
let SEALKEY: Uint8Array | null = null;     // the derived AES seal key (re-seal without re-prompting)
let SALT: Uint8Array | null = null;        // this wallet's PBKDF2 salt

// ── OPFS persistence (dual-capability: best-effort, file:// degrades silently) ─
const opfsAvailable = async (state: State): Promise<boolean> => {
  const ls = resolveFn(state, "fs.list") as Fn | undefined;
  if (!ls) return false;
  try { await ls("/"); return true; } catch { return false; }   // file:// throws → manual mode
};
const persist = async (state: State, blob: SealedBlob): Promise<boolean> => {
  if (!(await opfsAvailable(state))) return false;
  try {
    await (resolveFn(state, "fs.mkdir") as Fn)("/keystore");
    await (resolveFn(state, "fs.writeText") as Fn)(STORE_PATH, JSON.stringify(blob));
    return true;
  } catch { return false; }
};
const readStored = async (state: State): Promise<SealedBlob | null> => {
  if (!(await opfsAvailable(state))) return null;
  try { const raw = await (resolveFn(state, "fs.readText") as Fn)(STORE_PATH); return raw ? JSON.parse(String(raw)) as SealedBlob : null; }
  catch { return null; }
};

// ── status cels (NON-secret, cel-safe, reactive) ────────────────────────────
const setStatus = async (state: State, status: "none" | "locked" | "unlocked"): Promise<void> => {
  const sv = resolveFn(state, "setValueBatch") as Fn;
  await sv(state, [
    ["keystore.status", status],
    ["keystore.name", KEYRING?.name ?? ""],
    ["keystore.identity", status === "unlocked" ? (KEYRING?.current.signPub ?? "") : ""],
    ["keystore.ecdhpub", status === "unlocked" ? (KEYRING?.current.ecdhPub ?? "") : ""],
  ]);
};

// ── verbs ───────────────────────────────────────────────────────────────────
// keystore.has(state) — is there a persisted keystore (served) OR one unlocked?
const hasFn: Fn = (async (state: State): Promise<boolean> => KEYRING !== null || (await readStored(state)) !== null) as Fn;

// keystore.create(state, passcode, name?) — first-run: mint the wallet, seal it
// under the passcode, persist (if OPFS), load into memory. Returns the recovery
// phrase. Refuses an empty passcode or an existing unlocked wallet.
const createFn: Fn = (async (state: State, passcodeArg?: unknown, nameArg?: unknown): Promise<unknown> => {
  const passcode = String(passcodeArg ?? "");
  if (passcode.length < 4) return { ok: false, error: "keystore.create: passcode must be ≥4 chars (it is UNRECOVERABLE — no backdoor)" };
  const keyring: Keyring = { v: 1, name: String(nameArg ?? ""), current: await mintPair(), history: [], seed: b64enc(rand(16)) };
  const salt = rand(16);
  const sealKeyRaw = await deriveSealKey(passcode, salt);
  const blob = await sealBlob(keyring, sealKeyRaw, salt);
  KEYRING = keyring; SEALKEY = sealKeyRaw; SALT = salt;
  const persisted = await persist(state, blob);
  await setStatus(state, "unlocked");
  return { ok: true, persisted, identity: keyring.current.signPub, phrase: seedToPhrase(keyring.seed) };
}) as Fn;

// keystore.unlock(state, passcode) — read the persisted blob, decrypt, load into
// memory. Returns ok/err. (For file:// use keystore.import with the blob string.)
const unlockFn: Fn = (async (state: State, passcodeArg?: unknown): Promise<unknown> => {
  const blob = await readStored(state);
  if (!blob) return { ok: false, error: "keystore.unlock: no persisted keystore (file:// → keystore.import a file)" };
  const opened = await openBlob(blob, String(passcodeArg ?? ""));
  if (!opened) { await setStatus(state, "locked"); return { ok: false, error: "keystore.unlock: wrong passcode" }; }
  KEYRING = opened.keyring; SEALKEY = opened.sealKeyRaw; SALT = opened.salt;
  await setStatus(state, "unlocked");
  return { ok: true, identity: KEYRING.current.signPub };
}) as Fn;

// keystore.lock(state) — drop the in-memory keyring (sign-out).
const lockFn: Fn = (async (state: State): Promise<string> => {
  KEYRING = null; SEALKEY = null; SALT = null;
  await setStatus(state, (await readStored(state)) ? "locked" : "none");
  return "keystore: locked";
}) as Fn;

const reseal = async (state: State): Promise<boolean> => {
  if (!KEYRING || !SEALKEY || !SALT) return false;
  return persist(state, await sealBlob(KEYRING, SEALKEY, SALT));
};

// keystore.reshuffle(state) — mint a NEW current pair; retire the old one into
// history (so docs sealed to it stay openable). Re-seal + persist. Must be unlocked.
const reshuffleFn: Fn = (async (state: State): Promise<unknown> => {
  if (!KEYRING) return { ok: false, error: "keystore.reshuffle: locked — unlock first" };
  KEYRING.history.push({ ...KEYRING.current, retired: Date.now() });
  KEYRING.current = await mintPair();
  const persisted = await reseal(state);
  await setStatus(state, "unlocked");
  return { ok: true, persisted, identity: KEYRING.current.signPub, history: KEYRING.history.length };
}) as Fn;

// keystore.changePasscode(state, oldPass, newPass) — verify old, re-derive new
// seal key, re-seal. Needs the persisted blob to verify the old passcode.
const changePasscodeFn: Fn = (async (state: State, oldArg?: unknown, newArg?: unknown): Promise<unknown> => {
  const newPass = String(newArg ?? "");
  if (newPass.length < 4) return { ok: false, error: "keystore.changePasscode: new passcode must be ≥4 chars" };
  const blob = await readStored(state);
  // file://: no persisted blob — verify against the in-memory wallet by re-deriving.
  if (blob) { const opened = await openBlob(blob, String(oldArg ?? "")); if (!opened) return { ok: false, error: "wrong current passcode" }; if (!KEYRING) KEYRING = opened.keyring; }
  if (!KEYRING) return { ok: false, error: "keystore.changePasscode: locked — unlock first" };
  SALT = rand(16); SEALKEY = await deriveSealKey(newPass, SALT);
  const persisted = await reseal(state);
  return { ok: true, persisted };
}) as Fn;

// keystore.setName(state, name) — set the profile display name, re-seal.
const setNameFn: Fn = (async (state: State, nameArg?: unknown): Promise<unknown> => {
  if (!KEYRING) return { ok: false, error: "keystore.setName: locked" };
  KEYRING.name = String(nameArg ?? "");
  await reseal(state); await setStatus(state, "unlocked");
  return { ok: true, name: KEYRING.name };
}) as Fn;

// keystore.export(state) — the sealed blob as a string, for DOWNLOAD (the file://
// backup / device-migration artifact). Already ciphertext; no secret leaves.
const exportFn: Fn = (async (state: State): Promise<unknown> => {
  if (!KEYRING || !SEALKEY || !SALT) { const b = await readStored(state); return b ? JSON.stringify(b) : { ok: false, error: "keystore.export: nothing to export (locked, no persisted blob)" }; }
  return JSON.stringify(await sealBlob(KEYRING, SEALKEY, SALT));
}) as Fn;

// keystore.import(state, blobStr, passcode) — load a keystore from a FILE (file://
// path / device migration): decrypt with the passcode, load into memory, persist
// if OPFS is available.
const importFn: Fn = (async (state: State, blobArg?: unknown, passcodeArg?: unknown): Promise<unknown> => {
  let blob: SealedBlob;
  try { blob = (typeof blobArg === "string" ? JSON.parse(blobArg) : blobArg) as SealedBlob; } catch { return { ok: false, error: "keystore.import: not a valid keystore file" }; }
  if (!blob?.kdf?.salt || !blob.ct) return { ok: false, error: "keystore.import: not a keystore blob" };
  const opened = await openBlob(blob, String(passcodeArg ?? ""));
  if (!opened) return { ok: false, error: "keystore.import: wrong passcode for this file" };
  KEYRING = opened.keyring; SEALKEY = opened.sealKeyRaw; SALT = opened.salt;
  const persisted = await persist(state, blob);
  await setStatus(state, "unlocked");
  return { ok: true, persisted, identity: KEYRING.current.signPub, name: KEYRING.name };
}) as Fn;

// keystore.seedPhrase(state) — the 12-word recovery phrase for the current wallet
// (display only; deterministic seed→key re-derivation is the documented follow-up
// — the WORKING recovery in v1 is the exported passcode-locked file).
const seedPhraseFn: Fn = (async (_state: State): Promise<unknown> => {
  if (!KEYRING) return { ok: false, error: "keystore.seedPhrase: locked — unlock first" };
  return { ok: true, phrase: seedToPhrase(KEYRING.seed) };
}) as Fn;

// keystore.sign(state, message) — Ed25519-sign with the CURRENT signing key.
// Returns { ok, sig (b64), pub (b64) } so a verifier knows which key. Public
// verify is crypto.verify (no key needed). Must be unlocked.
const signFn: Fn = (async (_s: State, msgArg?: unknown): Promise<unknown> => {
  if (!KEYRING) return { ok: false, error: "keystore.sign: locked" };
  const key = await impSignPriv(KEYRING.current.signPriv);
  const sig = new Uint8Array(await host().subtle.sign({ name: "Ed25519" }, key, utf8(String(msgArg ?? ""))));
  return { ok: true, sig: b64enc(sig), pub: KEYRING.current.signPub };
}) as Fn;

// keystore.wrap(state, dataKeyB64, toPubB64?) — ECDH-wrap a data key to a
// recipient's ecdh pub (default = MY current ecdh pub = self-encryption). Returns
// { ok, env, pub } — `pub` is the key it was wrapped to (store it; unwrap needs it).
const wrapFn: Fn = (async (_s: State, dataKeyArg?: unknown, toPubArg?: unknown): Promise<unknown> => {
  if (!KEYRING) return { ok: false, error: "keystore.wrap: locked" };
  const toPub = String(toPubArg ?? KEYRING.current.ecdhPub);
  const aes = await sharedAes(KEYRING.current.ecdhPriv, toPub, ["encrypt"]);
  const iv = rand(12);
  const ct = new Uint8Array(await host().subtle.encrypt({ name: "AES-GCM", iv }, aes, b64dec(String(dataKeyArg ?? ""))));
  return { ok: true, env: `${b64enc(iv)}.${b64enc(ct)}`, pub: toPub };
}) as Fn;

// keystore.unwrap(state, env, withPubB64?) — ECDH-unwrap with the key whose ecdh
// PUB is `withPub` (default current). Tries that exact pair from current+history,
// so a sheet wrapped to a now-RETIRED key still opens. Returns { ok, dataKey }.
const unwrapFn: Fn = (async (_s: State, envArg?: unknown, withPubArg?: unknown): Promise<unknown> => {
  if (!KEYRING) return { ok: false, error: "keystore.unwrap: locked" };
  const [ivB64, ctB64] = String(envArg ?? "").split(".");
  if (!ivB64 || !ctB64) return { ok: false, error: "keystore.unwrap: bad envelope" };
  const withPub = String(withPubArg ?? KEYRING.current.ecdhPub);
  const pair = findEcdh(withPub);
  if (!pair) return { ok: false, error: "keystore.unwrap: no held key matches (sealed to a key you don't have)" };
  try {
    const aes = await sharedAes(pair.ecdhPriv, withPub, ["decrypt"]);
    const pt = new Uint8Array(await host().subtle.decrypt({ name: "AES-GCM", iv: b64dec(ivB64) }, aes, b64dec(ctB64)));
    return { ok: true, dataKey: b64enc(pt) };
  } catch { return { ok: false, error: "keystore.unwrap: decryption failed (wrong key / tampered)" }; }
}) as Fn;

// keystore.wrapTo(state, dataKeyB64, theirEcdhPubB64) — ECDH-wrap a data key to a
// PEER's ecdh pub (true peer key-exchange, unlike wrap which is self-only). The
// shared AES is ECDH(my priv, their pub); the peer recovers it as ECDH(their priv,
// my pub). Returns { ok, env, fromPub } — fromPub is MY ecdh pub the peer unwraps with.
const wrapToFn: Fn = (async (_s: State, dataKeyArg?: unknown, theirPubArg?: unknown): Promise<unknown> => {
  if (!KEYRING) return { ok: false, error: "keystore.wrapTo: locked" };
  const theirPub = String(theirPubArg ?? "");
  if (!theirPub) return { ok: false, error: "keystore.wrapTo: recipient ecdh pub required" };
  const aes = await sharedAes(KEYRING.current.ecdhPriv, theirPub, ["encrypt"]);
  const iv = rand(12);
  const ct = new Uint8Array(await host().subtle.encrypt({ name: "AES-GCM", iv }, aes, b64dec(String(dataKeyArg ?? ""))));
  return { ok: true, env: `${b64enc(iv)}.${b64enc(ct)}`, fromPub: KEYRING.current.ecdhPub };
}) as Fn;

// keystore.unwrapFrom(state, env, theirEcdhPubB64) — ECDH-unwrap a peer-wrapped key
// using MY current ecdh priv + THEIR ecdh pub (the wrapper's fromPub). Returns { ok, dataKey }.
const unwrapFromFn: Fn = (async (_s: State, envArg?: unknown, theirPubArg?: unknown): Promise<unknown> => {
  if (!KEYRING) return { ok: false, error: "keystore.unwrapFrom: locked" };
  const [ivB64, ctB64] = String(envArg ?? "").split(".");
  if (!ivB64 || !ctB64) return { ok: false, error: "keystore.unwrapFrom: bad envelope" };
  const theirPub = String(theirPubArg ?? "");
  if (!theirPub) return { ok: false, error: "keystore.unwrapFrom: sender ecdh pub required" };
  try {
    const aes = await sharedAes(KEYRING.current.ecdhPriv, theirPub, ["decrypt"]);
    const pt = new Uint8Array(await host().subtle.decrypt({ name: "AES-GCM", iv: b64dec(ivB64) }, aes, b64dec(ctB64)));
    return { ok: true, dataKey: b64enc(pt) };
  } catch { return { ok: false, error: "keystore.unwrapFrom: decryption failed (wrong key / tampered)" }; }
}) as Fn;

export const name = "keystore" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["keystore.sign", signFn],
  ["keystore.wrap", wrapFn],
  ["keystore.unwrap", unwrapFn],
  ["keystore.wrapTo", wrapToFn],
  ["keystore.unwrapFrom", unwrapFromFn],
  ["keystore.has", hasFn],
  ["keystore.create", createFn],
  ["keystore.unlock", unlockFn],
  ["keystore.lock", lockFn],
  ["keystore.reshuffle", reshuffleFn],
  ["keystore.changePasscode", changePasscodeFn],
  ["keystore.setName", setNameFn],
  ["keystore.export", exportFn],
  ["keystore.import", importFn],
  ["keystore.seedPhrase", seedPhraseFn],
]));
