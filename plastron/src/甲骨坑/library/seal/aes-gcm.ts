// ============================================================================
// seal/aes-gcm — a compact, SYNCHRONOUS, zero-dep AES-256-GCM.
//
// Why hand-rolled here (vs the crypto library's WebCrypto): the kernel's seal
// HOOKS (state.sealCipher / sealDecipher) are called INLINE inside the
// synchronous dehydrate (deflateCel) and hydrate (hydrateValue) paths. WebCrypto
// `subtle.encrypt/decrypt` is async, so it cannot back a sync hook. This module
// supplies a synchronous AEAD so those hooks can run per-cel. It is pure
// data-in/data-out, identical in Bun + the browser, no imports. (Key DERIVATION
// stays on WebCrypto's native PBKDF2 — it runs once, async, at seal.lock time.)
//
// Correctness: standard AES (FIPS-197) + GCM (NIST SP 800-38D), verified
// interoperable with WebCrypto's AES-256-GCM in both directions (encrypt here →
// decrypt there and vice-versa; wrong key → auth failure). We are encrypting an
// at-rest archive value, not a live channel — see Layer-2's honest scope.
// ============================================================================

// ── AES-256 block cipher (key schedule + encryptBlock) ──────────────────────
const SBOX = new Uint8Array(256);
const RCON = new Uint8Array([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d]);
(() => {
  // build the AES S-box (multiplicative inverse in GF(2^8) + affine transform)
  let p = 1, q = 1;
  const inv = new Uint8Array(256);
  do {
    p = p ^ (p << 1) ^ (p & 0x80 ? 0x11b : 0);
    p &= 0xff;
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    q &= 0xff;
    inv[p] = q;
  } while (p !== 1);
  inv[0] = 0;
  for (let i = 0; i < 256; i++) {
    let x = inv[i]!;
    let s = x;
    for (let r = 0; r < 4; r++) { x = ((x << 1) | (x >> 7)) & 0xff; s ^= x; }
    SBOX[i] = (s ^ 0x63) & 0xff;
  }
})();

const xtime = (a: number): number => ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 0xff;

// expand a 32-byte key into 60 32-bit round-key words (AES-256: 14 rounds).
const expandKey = (key: Uint8Array): Uint32Array => {
  const Nk = 8, Nr = 14, total = 4 * (Nr + 1);
  const w = new Uint32Array(total);
  for (let i = 0; i < Nk; i++) {
    w[i] = (key[4 * i]! << 24) | (key[4 * i + 1]! << 16) | (key[4 * i + 2]! << 8) | key[4 * i + 3]!;
  }
  for (let i = Nk; i < total; i++) {
    let t = w[i - 1]!;
    if (i % Nk === 0) {
      t = (t << 8) | (t >>> 24);              // RotWord
      t = (SBOX[(t >>> 24) & 0xff]! << 24) | (SBOX[(t >>> 16) & 0xff]! << 16) | (SBOX[(t >>> 8) & 0xff]! << 8) | SBOX[t & 0xff]!;
      t ^= (RCON[i / Nk - 1]!) << 24;
    } else if (i % Nk === 4) {
      t = (SBOX[(t >>> 24) & 0xff]! << 24) | (SBOX[(t >>> 16) & 0xff]! << 16) | (SBOX[(t >>> 8) & 0xff]! << 8) | SBOX[t & 0xff]!;
    }
    w[i] = (w[i - Nk]! ^ t) >>> 0;
  }
  return w;
};

// encrypt one 16-byte block in place into `out`.
const encryptBlock = (input: Uint8Array, w: Uint32Array, out: Uint8Array): void => {
  const Nr = 14;
  const s = new Uint8Array(16);
  s.set(input.subarray(0, 16));
  const addRoundKey = (round: number): void => {
    for (let c = 0; c < 4; c++) {
      const k = w[round * 4 + c]!;
      s[c * 4]! ^= (k >>> 24) & 0xff;
      s[c * 4 + 1]! ^= (k >>> 16) & 0xff;
      s[c * 4 + 2]! ^= (k >>> 8) & 0xff;
      s[c * 4 + 3]! ^= k & 0xff;
    }
  };
  addRoundKey(0);
  for (let round = 1; round <= Nr; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]!]!;             // SubBytes
    // ShiftRows (state is column-major: byte index = col*4 + row)
    const t = s.slice();
    for (let row = 1; row < 4; row++) {
      for (let col = 0; col < 4; col++) s[col * 4 + row] = t[((col + row) % 4) * 4 + row]!;
    }
    if (round !== Nr) {                                            // MixColumns
      for (let col = 0; col < 4; col++) {
        const a0 = s[col * 4]!, a1 = s[col * 4 + 1]!, a2 = s[col * 4 + 2]!, a3 = s[col * 4 + 3]!;
        s[col * 4] = (xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3) & 0xff;
        s[col * 4 + 1] = (a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3) & 0xff;
        s[col * 4 + 2] = (a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3)) & 0xff;
        s[col * 4 + 3] = ((xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3)) & 0xff;
      }
    }
    addRoundKey(round);
  }
  out.set(s);
};

// ── GHASH (GF(2^128) multiply) for GCM auth ─────────────────────────────────
const gfmul = (X: Uint8Array, Y: Uint8Array): Uint8Array => {
  const Z = new Uint8Array(16);
  const V = Y.slice();
  for (let i = 0; i < 128; i++) {
    const bit = (X[i >> 3]! >> (7 - (i & 7))) & 1;
    if (bit) for (let j = 0; j < 16; j++) Z[j]! ^= V[j]!;
    // V >>= 1, reduce by R = 0xe1 << 120 if LSB set
    let carry = 0;
    for (let j = 0; j < 16; j++) {
      const newCarry = V[j]! & 1;
      V[j] = (V[j]! >> 1) | (carry << 7);
      carry = newCarry;
    }
    if (carry) V[0]! ^= 0xe1;
  }
  return Z;
};

const ghash = (H: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array => {
  let Y: Uint8Array = new Uint8Array(16);
  const block = (data: Uint8Array): void => {
    for (let off = 0; off < data.length; off += 16) {
      const chunk = new Uint8Array(16);
      chunk.set(data.subarray(off, Math.min(off + 16, data.length)));
      for (let j = 0; j < 16; j++) Y[j]! ^= chunk[j]!;
      Y = gfmul(Y, H);
    }
  };
  block(aad);
  block(ct);
  // length block: aad bits (64) || ct bits (64)
  const lens = new Uint8Array(16);
  const aBits = aad.length * 8, cBits = ct.length * 8;
  const writeU64 = (off: number, n: number): void => {
    for (let i = 7; i >= 0; i--) { lens[off + i] = n & 0xff; n = Math.floor(n / 256); }
  };
  writeU64(0, aBits); writeU64(8, cBits);
  for (let j = 0; j < 16; j++) Y[j]! ^= lens[j]!;
  Y = gfmul(Y, H);
  return Y;
};

const incCounter = (ctr: Uint8Array): void => {
  for (let i = 15; i >= 12; i--) { ctr[i] = (ctr[i]! + 1) & 0xff; if (ctr[i] !== 0) break; }
};

export interface GcmResult { ct: Uint8Array; tag: Uint8Array }

export const aesGcmEncrypt = (key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, aad = new Uint8Array(0)): GcmResult => {
  const w = expandKey(key);
  const H = new Uint8Array(16); encryptBlock(new Uint8Array(16), w, H);
  // J0 for a 96-bit IV = IV || 0x00000001
  const J0 = new Uint8Array(16); J0.set(iv.subarray(0, 12)); J0[15] = 1;
  // CTR encryption starting at J0+1
  const ct = new Uint8Array(plaintext.length);
  const ctr = J0.slice();
  const ks = new Uint8Array(16);
  for (let off = 0; off < plaintext.length; off += 16) {
    incCounter(ctr);
    encryptBlock(ctr, w, ks);
    const n = Math.min(16, plaintext.length - off);
    for (let i = 0; i < n; i++) ct[off + i] = plaintext[off + i]! ^ ks[i]!;
  }
  const S = ghash(H, aad, ct);
  const ej0 = new Uint8Array(16); encryptBlock(J0, w, ej0);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) tag[i] = S[i]! ^ ej0[i]!;
  return { ct, tag };
};

export const aesGcmDecrypt = (key: Uint8Array, iv: Uint8Array, ct: Uint8Array, tag: Uint8Array, aad = new Uint8Array(0)): Uint8Array | null => {
  const w = expandKey(key);
  const H = new Uint8Array(16); encryptBlock(new Uint8Array(16), w, H);
  const J0 = new Uint8Array(16); J0.set(iv.subarray(0, 12)); J0[15] = 1;
  const S = ghash(H, aad, ct);
  const ej0 = new Uint8Array(16); encryptBlock(J0, w, ej0);
  const expect = new Uint8Array(16);
  for (let i = 0; i < 16; i++) expect[i] = S[i]! ^ ej0[i]!;
  // constant-time-ish tag compare
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= expect[i]! ^ tag[i]!;
  if (diff !== 0) return null;                                     // auth failure → wrong key / tamper
  const pt = new Uint8Array(ct.length);
  const ctr = J0.slice();
  const ks = new Uint8Array(16);
  for (let off = 0; off < ct.length; off += 16) {
    incCounter(ctr);
    encryptBlock(ctr, w, ks);
    const n = Math.min(16, ct.length - off);
    for (let i = 0; i < n; i++) pt[off + i] = ct[off + i]! ^ ks[i]!;
  }
  return pt;
};
