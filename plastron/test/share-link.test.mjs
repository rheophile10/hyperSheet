import { test } from "bun:test";
import assert from "node:assert/strict";
// pure codec — import the TS source directly (bun runs it); no kernel boot needed.
import { encodePayload, decodePayload, encodeLink, decodeLink,
  encryptPayload, decryptPayload, encodeEncLink, decodeEncLink, ENC_METHOD,
  otpEncryptPayload, otpDecryptPayload, encodeOtpLink, parseOtpUrl, OTP_METHOD, OTP_OVERHEAD }
  from "../src/甲骨坑/application/origin/share-link.ts";

const te = new TextEncoder();
const randomPadFor = (formula, slack = 64) => crypto.getRandomValues(new Uint8Array(te.encode(formula).length + OTP_OVERHEAD + slack));

// ============================================================================
// share-link — a formula IS the whole app, so a link carries a whole plastron.
// encode → URL → decode must round-trip EXACTLY, the codec must auto-pick the
// smaller of plain/deflate, and decode must accept a full URL / bare #f= / payload.
// ============================================================================

test("round-trips an arbitrary formula exactly (auto codec)", async () => {
  const f = `=dom("div",{"class":"card"},dom("h1",{},"Hello 🐢"),count)`;
  const back = await decodePayload(await encodePayload(f));
  assert.equal(back, f, "auto round-trip must be lossless (incl. unicode)");
});

test("plain and deflate codecs each round-trip", async () => {
  const f = "=cels(3,3)";
  for (const codec of ["plain", "deflate"]) {
    const p = await encodePayload(f, codec);
    assert.equal(p[0], codec === "plain" ? "0" : "1", `tag marks the ${codec} codec`);
    assert.equal(await decodePayload(p), f, `${codec} round-trips`);
  }
});

test("auto picks PLAIN for a tiny formula (deflate overhead) and DEFLATE for a big repetitive one", async () => {
  const tiny = "=cels(3,3)";
  assert.equal((await encodePayload(tiny, "auto"))[0], "0", "tiny → plain is smaller");

  // a big, repetitive formula: deflate should win decisively
  const big = "=dom(" + Array.from({ length: 400 }, (_, i) => `"row-${i % 7}"`).join(",") + ")";
  const auto = await encodePayload(big, "auto");
  assert.equal(auto[0], "1", "big repetitive → deflate is smaller");
  assert.ok(auto.length < big.length, "deflated payload is shorter than the source");
  assert.equal(await decodePayload(auto), big, "big round-trips");
});

test("encodeLink frames a URL; default base is plastron.ca, base:'' is relative", async () => {
  const f = "=1";
  assert.match(await encodeLink(f), /^https:\/\/plastron\.ca\/#f=./, "default base = plastron.ca");
  assert.match(await encodeLink(f, { base: "" }), /^#f=./, "base:'' → bare relative #f=");
});

test("decodeLink accepts a full URL, a bare #f= fragment, or a raw payload", async () => {
  const f = `=claude("hi")`;
  const payload = await encodePayload(f);
  assert.equal(await decodeLink(`https://plastron.ca/#f=${payload}`), f, "full URL");
  assert.equal(await decodeLink(`#f=${payload}`), f, "bare fragment");
  assert.equal(await decodeLink(payload), f, "raw payload");
});

test("payload is URL-safe (base64url alphabet only: A-Za-z0-9-_ plus the 1-char tag)", async () => {
  const f = `=dom("a",{"href":"x?y&z=1"},"~weird/+chars=")`;
  const p = await encodePayload(f);
  assert.match(p, /^[01][A-Za-z0-9\-_]*$/, "no +, /, =, or other URL-unsafe chars");
});

// ── encrypted links (AES-256-GCM) ───────────────────────────────────────────

test("encryptPayload → decryptPayload round-trips (incl. unicode)", async () => {
  const f = `=dom("h1",{},"secret 🐢 sheet")`;
  const pw = "correct horse battery staple";
  const p = await encryptPayload(f, pw);
  assert.match(p, /^[A-Za-z0-9\-_]+$/, "encrypted payload is base64url (no +, /, =)");
  assert.equal(await decryptPayload(p, pw), f, "round-trips with the right passphrase");
});

test("encodeEncLink names the method in the URL param (#aes256gcm=)", async () => {
  assert.equal(ENC_METHOD, "aes256gcm");
  const url = await encodeEncLink("=1", "pw");
  assert.match(url, /^https:\/\/plastron\.ca\/#aes256gcm=./, "default base + method param");
  assert.match(await encodeEncLink("=1", "pw", ""), /^#aes256gcm=./, "base:'' → bare relative");
});

test("decodeEncLink accepts a full URL, a bare fragment, or a raw payload", async () => {
  const f = `=cels(2,2)`, pw = "hunter2";
  const payload = await encryptPayload(f, pw);
  assert.equal(await decodeEncLink(`https://plastron.ca/#${ENC_METHOD}=${payload}`, pw), f, "full URL");
  assert.equal(await decodeEncLink(`#${ENC_METHOD}=${payload}`, pw), f, "bare fragment");
  assert.equal(await decodeEncLink(payload, pw), f, "raw payload");
});

test("a wrong passphrase or tampered ciphertext fails (GCM authenticates)", async () => {
  const f = `=1+1`, pw = "right";
  const p = await encryptPayload(f, pw);
  await assert.rejects(() => decryptPayload(p, "wrong"), /wrong passphrase or corrupted/, "wrong passphrase rejects");
  const tampered = p.slice(0, -4) + (p.endsWith("AAAA") ? "BBBB" : "AAAA");
  await assert.rejects(() => decryptPayload(tampered, pw), /wrong passphrase or corrupted/, "tampered payload rejects");
});

test("each encryption uses fresh salt+iv (ciphertexts differ; both decrypt)", async () => {
  const f = `=42`, pw = "k";
  const a = await encryptPayload(f, pw), b = await encryptPayload(f, pw);
  assert.notEqual(a, b, "two encryptions of the same input differ");
  assert.equal(await decryptPayload(a, pw), f);
  assert.equal(await decryptPayload(b, pw), f);
});

test("encryption requires a passphrase", async () => {
  await assert.rejects(() => encryptPayload("=1", ""), /needs a passphrase/);
  await assert.rejects(() => decryptPayload("x", ""), /needs a passphrase/);
});

// ── one-time pad (unconditional secrecy) ─────────────────────────────────────

test("otp round-trips with the matching pad", async () => {
  const f = `=dom("h1",{},"perfectly secret 🐢")`;
  const pad = randomPadFor(f);
  const { payload } = await otpEncryptPayload(f, pad);
  assert.match(payload, /^[A-Za-z0-9\-_]+$/, "payload is base64url");
  assert.equal(await otpDecryptPayload(payload, pad), f, "round-trips");
});

test("otp ciphertext is pure XOR of plaintext and pad (perfect secrecy, no compression)", async () => {
  const f = "=1+1";
  const pad = randomPadFor(f);
  const { payload } = await otpEncryptPayload(f, pad);
  // base64url-decode the payload (ciphertext || 16-byte tag) and check the XOR
  const t = payload.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + (t.length % 4 ? "=".repeat(4 - (t.length % 4)) : ""));
  const all = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const plain = te.encode(f), L = all.length - 16;
  assert.equal(L, plain.length, "ciphertext length == plaintext length (no compression)");
  for (let i = 0; i < L; i++) assert.equal(all[i] ^ pad[i], plain[i], `byte ${i} is plaintext XOR pad`);
});

test("otp is deterministic given the pad (no random IV)", async () => {
  const f = "=42", pad = randomPadFor(f);
  const a = await otpEncryptPayload(f, pad), b = await otpEncryptPayload(f, pad);
  assert.equal(a.payload, b.payload, "same pad + formula → same payload");
  assert.equal(a.used, te.encode(f).length + OTP_OVERHEAD, "used = message bytes + 32");
});

test("otp one-time MAC catches a tampered ciphertext (malleability defeated)", async () => {
  const f = "=cels(2,2)", pad = randomPadFor(f);
  const { payload } = await otpEncryptPayload(f, pad);
  const flip = (i) => payload.slice(0, i) + (payload[i] === "A" ? "B" : "A") + payload.slice(i + 1);
  await assert.rejects(() => otpDecryptPayload(flip(0), pad), /authentication failed/, "flipped ciphertext byte rejects");
});

test("otp rejects the wrong pad", async () => {
  const f = "=1", pad = randomPadFor(f), wrong = randomPadFor(f);
  const { payload } = await otpEncryptPayload(f, pad);
  await assert.rejects(() => otpDecryptPayload(payload, wrong), /authentication failed/);
});

test("otp never wraps a short pad — it throws (a reused pad would break secrecy)", async () => {
  const f = "=dom('div', 'x')";
  await assert.rejects(() => otpEncryptPayload(f, new Uint8Array(8)), /pad too short/, "encrypt refuses a short pad");
  const { payload } = await otpEncryptPayload(f, randomPadFor(f));
  await assert.rejects(() => otpDecryptPayload(payload, new Uint8Array(8)), /pad too short/, "decrypt refuses a short pad");
});

test("encodeOtpLink names the method + pad id; parseOtpUrl splits them back", async () => {
  const f = "=99", pad = randomPadFor(f);
  const { url } = await encodeOtpLink(f, pad, "card.png");
  assert.match(url, new RegExp(`^https://plastron\\.ca/#${OTP_METHOD}=card\\.png\\.`), "method + padId with its real filename (dots kept)");
  const { padId, payload } = parseOtpUrl(url);
  assert.equal(padId, "card.png", "padId (incl. dot) parses out via last-dot split");
  assert.equal(await otpDecryptPayload(payload, pad), f, "payload from the url decrypts");
  // base:'' → bare relative
  assert.match((await encodeOtpLink(f, pad, "p")).url, /^https/, "default base");
  assert.match((await encodeOtpLink(f, pad, "p", "")).url, new RegExp(`^#${OTP_METHOD}=`), "base:'' → bare relative");
});
