import { test } from "bun:test";
import assert from "node:assert/strict";
// pure codec — import the TS source directly (bun runs it); no kernel boot needed.
import { encodePayload, decodePayload, encodeLink, decodeLink }
  from "../src/甲骨坑/application/origin/share-link.ts";

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
