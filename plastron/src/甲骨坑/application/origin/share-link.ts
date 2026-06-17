// share-link — encode a plastron formula into a compact, URL-safe `#f=` payload
// and back. A formula IS the whole app, so a link carries a whole plastron.
//
// Payload format:  <tag><body>
//   tag "0" = base64url(utf8 source)              — plain; smallest for tiny formulas
//   tag "1" = base64url(deflate-raw(utf8 source)) — compressed; smallest for big ones
// "auto" emits whichever is SHORTER (deflate adds a few bytes of overhead on tiny
// inputs) and tags it, so decode is unambiguous. deflate-raw + base64url are pure
// platform APIs (CompressionStream + btoa) — zero-dep and identical in Bun and every
// browser, so a link round-trips on plastron.ca AND a file:// index.html alike.
//
// Measured: the 48k 元 landing doc → ~5.9k URL chars (8.2x); fits the browser URL
// limit and tweets fine (t.co shortens any URL to ~23 chars regardless of length).

export type LinkCodec = "auto" | "plain" | "deflate";
export interface LinkOpts { codec?: LinkCodec; base?: string }

const PLAIN = "0";
const DEFLATE = "1";

const te = new TextEncoder();
const td = new TextDecoder();

const b64urlEnc = (u8: Uint8Array): string => {
  let s = "";
  for (const x of u8) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlDec = (s: string): Uint8Array => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4 === 0 ? "" : "=".repeat(4 - (t.length % 4));
  const raw = atob(t + pad);
  const o = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) o[i] = raw.charCodeAt(i);
  return o;
};

// Minimal deflate-raw / inflate-raw over the Compression Streams API. Self-
// contained (no segment-archive coupling) — the pump is ~15 lines.
interface StreamReader { read(): Promise<{ done: boolean; value?: Uint8Array }> }
interface StreamWriter { write(b: Uint8Array): Promise<void>; close(): Promise<void> }
interface XformStream { readable: { getReader(): StreamReader }; writable: { getWriter(): StreamWriter } }
type XformCtor = new (format: string) => XformStream;

const CS = (globalThis as { CompressionStream?: XformCtor }).CompressionStream;
const DS = (globalThis as { DecompressionStream?: XformCtor }).DecompressionStream;

const pump = async (ctor: XformCtor | undefined, bytes: Uint8Array): Promise<Uint8Array> => {
  if (!ctor) throw new Error("share-link: Compression Streams API unavailable in this runtime");
  const s = new ctor("deflate-raw");
  const w = s.writable.getWriter();
  // write + close concurrently with the read loop so a full buffer can't deadlock.
  const writeDone = (async () => { await w.write(bytes); await w.close(); })();
  const r = s.readable.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    if (value) { chunks.push(value); n += value.length; }
  }
  await writeDone;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
};

/** Encode formula source → `<tag><body>` payload (no URL framing). */
export const encodePayload = async (formula: string, codec: LinkCodec = "auto"): Promise<string> => {
  const raw = te.encode(formula);
  const plain = PLAIN + b64urlEnc(raw);
  if (codec === "plain") return plain;
  const deflated = DEFLATE + b64urlEnc(await pump(CS, raw));
  if (codec === "deflate") return deflated;
  return deflated.length < plain.length ? deflated : plain; // auto: pick the smaller
};

/** Decode a `<tag><body>` payload back to formula source. */
export const decodePayload = async (payload: string): Promise<string> => {
  const tag = payload[0];
  const bytes = b64urlDec(payload.slice(1));
  if (tag === PLAIN) return td.decode(bytes);
  if (tag === DEFLATE) return td.decode(await pump(DS, bytes));
  throw new Error(`share-link: unknown codec tag "${tag}"`);
};

/** Formula source → full shareable URL `${base}#f=<payload>`. base "" → bare `#f=…`
 *  (relative; works from a file:// index.html). */
export const encodeLink = async (formula: string, opts: LinkOpts = {}): Promise<string> => {
  const base = opts.base ?? "https://plastron.ca/";
  return `${base}#f=${await encodePayload(formula, opts.codec ?? "auto")}`;
};

// Accept a full URL, a bare `#f=…` / `?f=…` fragment, or a bare payload.
const PAYLOAD_RE = /[#?&]f=([^#?&]+)/;
/** A =link() URL (or bare payload) → its formula source. Does NOT execute it. */
export const decodeLink = async (input: string): Promise<string> => {
  const m = PAYLOAD_RE.exec(input);
  return decodePayload(m ? decodeURIComponent(m[1]!) : input);
};

// ── encrypted links ─────────────────────────────────────────────────────────
// A `#f=` link carries the formula in the clear (anyone with the URL reads it).
// An ENCRYPTED link carries ciphertext + a passphrase held out-of-band, so the
// URL alone is opaque. The URL PARAMETER NAMES THE METHOD (`#aes256gcm=…`) so
// the booter is self-describing and future methods (argon2/pqc) get their own
// param without a tag-byte scheme.
//
// Pipeline:  formula → deflate-raw → AES-256-GCM → base64url
//   key  = PBKDF2-HMAC-SHA256(passphrase, salt, 600k iters) → AES-256 key
//   body = salt[16] || iv[12] || GCM(ciphertext+tag)
// Compress BEFORE encrypt (ciphertext is incompressible, so the order keeps the
// URL short). AES-256 is symmetric → quantum-resistant (Grover-only). All via
// WebCrypto `crypto.subtle` — zero-dep, identical in Bun and every browser.

export const ENC_METHOD = "aes256gcm";       // the #<method>= URL parameter name
const PBKDF2_ITERS = 600_000;                 // OWASP-current floor for PBKDF2-SHA256
const SALT_LEN = 16;
const IV_LEN = 12;

// Minimal structural types for the WebCrypto surface we touch — the TS lib here
// excludes the DOM/WebCrypto globals, so (like CompressionStream above) we shape
// them locally rather than depend on `lib.dom`.
type KeyLike = unknown;
interface SubtleLike {
  importKey(format: string, keyData: Uint8Array, algorithm: string, extractable: boolean, usages: string[]): Promise<KeyLike>;
  deriveKey(algorithm: object, baseKey: KeyLike, derived: object, extractable: boolean, usages: string[]): Promise<KeyLike>;
  encrypt(algorithm: object, key: KeyLike, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(algorithm: object, key: KeyLike, data: Uint8Array): Promise<ArrayBuffer>;
}
interface CryptoLike { subtle?: SubtleLike; getRandomValues?<T>(a: T): T }

const webcrypto = (): SubtleLike => {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!c?.subtle) throw new Error("share-link: WebCrypto (crypto.subtle) unavailable in this runtime");
  return c.subtle;
};
const randomBytes = (n: number): Uint8Array => {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!c?.getRandomValues) throw new Error("share-link: crypto.getRandomValues unavailable in this runtime");
  return c.getRandomValues(new Uint8Array(n));
};
const deriveKey = async (passphrase: string, salt: Uint8Array): Promise<KeyLike> => {
  const s = webcrypto();
  const base = await s.importKey("raw", te.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return s.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

/** formula source → encrypted payload (no URL framing): base64url(salt|iv|ciphertext). */
export const encryptPayload = async (formula: string, passphrase: string): Promise<string> => {
  if (!passphrase) throw new Error("share-link: encryption needs a passphrase");
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = await deriveKey(passphrase, salt);
  const compressed = await pump(CS, te.encode(formula));
  const ct = new Uint8Array(await webcrypto().encrypt({ name: "AES-GCM", iv }, key, compressed));
  const out = new Uint8Array(SALT_LEN + IV_LEN + ct.length);
  out.set(salt, 0);
  out.set(iv, SALT_LEN);
  out.set(ct, SALT_LEN + IV_LEN);
  return b64urlEnc(out);
};

/** encrypted payload + passphrase → formula source. Throws on a wrong passphrase
 *  or tampered payload (GCM authenticates; a bad key fails the tag check). */
export const decryptPayload = async (payload: string, passphrase: string): Promise<string> => {
  if (!passphrase) throw new Error("share-link: decryption needs a passphrase");
  const all = b64urlDec(payload);
  const salt = all.slice(0, SALT_LEN);
  const iv = all.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ct = all.slice(SALT_LEN + IV_LEN);
  const key = await deriveKey(passphrase, salt);
  let plain: ArrayBuffer;
  try { plain = await webcrypto().decrypt({ name: "AES-GCM", iv }, key, ct); }
  catch { throw new Error("decryption failed — wrong passphrase or corrupted link"); }
  return td.decode(await pump(DS, new Uint8Array(plain)));
};

const ENC_RE = new RegExp(`[#?&]${ENC_METHOD}=([^#?&]+)`);

/** formula source → full encrypted URL `${base}#aes256gcm=<payload>`. base "" →
 *  a bare relative `#aes256gcm=…` (works from a file:// index.html). */
export const encodeEncLink = async (formula: string, passphrase: string, base = "https://plastron.ca/"): Promise<string> =>
  `${base}#${ENC_METHOD}=${await encryptPayload(formula, passphrase)}`;

/** an encrypted URL (or bare payload) + passphrase → formula source. Does NOT
 *  execute it. Inverse of encodeEncLink. */
export const decodeEncLink = async (input: string, passphrase: string): Promise<string> => {
  const m = ENC_RE.exec(input);
  return decryptPayload(m ? decodeURIComponent(m[1]!) : input, passphrase);
};

// ── one-time pad (UNCONDITIONAL secrecy) ────────────────────────────────────
// A one-time pad gives PERFECT secrecy: ciphertext = plaintext XOR pad, where the
// pad is TRUE-RANDOM, AS LONG AS the message, and used EXACTLY ONCE. There is no
// computational assumption — unbreakable by any amount of compute, quantum
// included. The price: you and your peer hold the SAME stack of pad files (one
// file = one pad = one message), each used once and deleted; reuse a pad, or
// reuse one shorter than the message, and secrecy collapses.
//
// Two deliberate choices keep the "unconditional" claim honest:
//  • NO COMPRESSION. Compressing first would leak the plaintext's compressibility
//    through the ciphertext length — so OTP ciphertext is the same length as the
//    plaintext (length is the one thing a pad inherently reveals, nothing more).
//  • A ONE-TIME Carter–Wegman MAC (also information-theoretic) for integrity —
//    raw XOR is malleable (bit-flips pass through), so without this an attacker
//    could tamper undetectably. The MAC keys (r, s) are fresh pad bytes per
//    message, so authentication is unconditional too.
//
// Pad bytes consumed per message:  L (keystream) + 16 (r) + 16 (s)  =  L + 32.
// payload = base64url( ciphertext[L] || tag[16] ).  URL: #otp=<padId>.<payload>
// padId is a non-secret label (the pad FILE's name) telling the peer which pad to
// load; the bytes never travel — only the ciphertext does.

export const OTP_METHOD = "otp";
const MAC_KEY_LEN = 16;                  // pad bytes read for each of r, s
const OTP_TAG_LEN = 16;                  // serialized MAC tag length
export const OTP_OVERHEAD = MAC_KEY_LEN * 2;  // pad bytes used beyond the message
const M127 = (1n << 127n) - 1n;          // Mersenne prime 2^127-1 — the MAC field

const beToBig = (b: Uint8Array): bigint => { let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n; };
const bigToBe = (n: bigint, len: number): Uint8Array => { const o = new Uint8Array(len); let x = n; for (let i = len - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };

// one-time Carter–Wegman polynomial MAC over GF(2^127-1). 15-byte message blocks
// (each < 2^120 < p); a leading length coefficient makes it injective on size.
// tag = (s + Σ_i m_i · r^i) mod p, with (r, s) used ONCE → info-theoretic.
const otpMac = (ct: Uint8Array, r: bigint, s: bigint): Uint8Array => {
  const rr = r % M127, ss = s % M127;
  let acc = 0n, pow = rr;
  const block = (m: bigint): void => { acc = (acc + (m % M127) * pow) % M127; pow = (pow * rr) % M127; };
  block(BigInt(ct.length));                                    // length first → injective
  for (let i = 0; i < ct.length; i += 15) block(beToBig(ct.subarray(i, i + 15)));
  return bigToBe((acc + ss) % M127, OTP_TAG_LEN);
};
const ctEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
};

/** formula + pad → { payload, used }. THROWS if the pad is too short — it NEVER
 *  wraps (a repeated pad would destroy secrecy). `used` = message bytes + 32, so
 *  the caller knows how much of the pad to retire. */
export const otpEncryptPayload = async (formula: string, pad: Uint8Array): Promise<{ payload: string; used: number }> => {
  const plain = te.encode(formula);
  const L = plain.length;
  if (pad.length < L + OTP_OVERHEAD) throw new Error(`otp: pad too short — need ${L + OTP_OVERHEAD} bytes, have ${pad.length}`);
  const ct = new Uint8Array(L);
  for (let i = 0; i < L; i++) ct[i] = plain[i]! ^ pad[i]!;
  const r = beToBig(pad.subarray(L, L + MAC_KEY_LEN));
  const s = beToBig(pad.subarray(L + MAC_KEY_LEN, L + OTP_OVERHEAD));
  const out = new Uint8Array(L + OTP_TAG_LEN);
  out.set(ct, 0);
  out.set(otpMac(ct, r, s), L);
  return { payload: b64urlEnc(out), used: L + OTP_OVERHEAD };
};

/** payload + pad → formula. THROWS on a bad tag (tamper / wrong pad) or short pad.
 *  Does NOT execute the formula. */
export const otpDecryptPayload = async (payload: string, pad: Uint8Array): Promise<string> => {
  const all = b64urlDec(payload);
  if (all.length < OTP_TAG_LEN) throw new Error("otp: payload too short");
  const L = all.length - OTP_TAG_LEN;
  if (pad.length < L + OTP_OVERHEAD) throw new Error(`otp: pad too short — need ${L + OTP_OVERHEAD} bytes, have ${pad.length}`);
  const ct = all.subarray(0, L), tag = all.subarray(L);
  const r = beToBig(pad.subarray(L, L + MAC_KEY_LEN));
  const s = beToBig(pad.subarray(L + MAC_KEY_LEN, L + OTP_OVERHEAD));
  if (!ctEqual(otpMac(ct, r, s), tag)) throw new Error("otp: authentication failed — wrong pad or corrupted message");
  const plain = new Uint8Array(L);
  for (let i = 0; i < L; i++) plain[i] = ct[i]! ^ pad[i]!;
  return td.decode(plain);
};

const OTP_RE = new RegExp(`[#?&]${OTP_METHOD}=([^#?&]+)`);
/** Split a #otp=<padId>.<payload> URL/fragment/bare value into its parts. The
 *  padId names which pad FILE the peer must load; payload is the base64url body. */
export const parseOtpUrl = (input: string): { padId: string; payload: string } => {
  const m = OTP_RE.exec(input);
  const raw = m ? decodeURIComponent(m[1]!) : input;
  const dot = raw.indexOf(".");
  return dot < 0 ? { padId: "", payload: raw } : { padId: raw.slice(0, dot), payload: raw.slice(dot + 1) };
};
/** formula + pad + padId → { url, used }. base "" → bare relative #otp=…. padId
 *  must be a simple token (no ".") — it's the pad file's name. */
export const encodeOtpLink = async (formula: string, pad: Uint8Array, padId: string, base = "https://plastron.ca/"): Promise<{ url: string; used: number }> => {
  const { payload, used } = await otpEncryptPayload(formula, pad);
  const id = String(padId).replace(/\./g, "_");
  return { url: `${base}#${OTP_METHOD}=${id}.${payload}`, used };
};
