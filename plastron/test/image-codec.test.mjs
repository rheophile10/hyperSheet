import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// The `image` segment: PNG ⇆ RGBA + downscale. bun has no OffscreenCanvas /
// createImageBitmap, so these exercise the pure-JS PNG codec fallback (which
// also runs in any browser lacking canvas). Encode is lossless, so the round
// trip is byte-identical — the property NanoSteg's LSB payload depends on.

const isCelError = (v) => v && typeof v === "object" && v.kind === "error";

// deterministic pseudo-random RGBA of a given size
const makeRGBA = (w, h, seed = 1) => {
  const a = new Uint8Array(w * h * 4);
  let s = seed >>> 0;
  for (let i = 0; i < a.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    a[i] = i % 4 === 3 ? 255 : (s & 0xff);
  }
  return a;
};

test("image.encode → image.decode round-trips RGBA + dims byte-identically", async () => {
  const state = createInitialState();
  const encode = resolveFn(state, "image.encode");
  const decode = resolveFn(state, "image.decode");

  const w = 40, h = 30, rgba = makeRGBA(w, h, 7);
  const png = await encode(rgba, w, h);
  assert.equal(typeof png, "string", "encode returns a base64 PNG string");

  const out = await decode(png);
  assert.ok(!isCelError(out), `decode should succeed: ${JSON.stringify(out)}`);
  assert.equal(out.w, w);
  assert.equal(out.h, h);
  assert.equal(out.rgba.length, rgba.length);
  for (let i = 0; i < rgba.length; i++) {
    if (out.rgba[i] !== rgba[i]) { assert.fail(`byte ${i} differs: ${rgba[i]} → ${out.rgba[i]}`); }
  }
});

test("an LSB-tweaked buffer survives an encode → decode (lossless-PNG) round trip", async () => {
  const state = createInitialState();
  const encode = resolveFn(state, "image.encode");
  const decode = resolveFn(state, "image.decode");

  const w = 48, h = 48, rgba = makeRGBA(w, h, 11);
  // flip some R/G/B LSBs (mimicking a steg write); alpha untouched
  for (let i = 0; i < rgba.length; i++) if (i % 4 !== 3 && i % 5 === 0) rgba[i] ^= 1;
  const back = await decode(await encode(rgba, w, h));
  for (let i = 0; i < rgba.length; i++) {
    if (back.rgba[i] !== rgba[i]) { assert.fail(`LSB byte ${i} did not survive PNG round trip`); }
  }
});

test("image.fit downscales a >maxDim image to ≤maxDim, and is a no-op under the bound", async () => {
  const state = createInitialState();
  const encode = resolveFn(state, "image.encode");
  const decode = resolveFn(state, "image.decode");
  const fit = resolveFn(state, "image.fit");

  // oversized synthetic PNG (800×600) → fit to 680
  const big = await encode(makeRGBA(800, 600, 3), 800, 600);
  const fitted = await fit(big, 680);
  assert.equal(typeof fitted, "string");
  const fdec = await decode(fitted);
  assert.ok(Math.max(fdec.w, fdec.h) <= 680, `max dim should be ≤680, got ${fdec.w}×${fdec.h}`);
  assert.equal(fdec.w, 680, "800 → 680 on the long edge");
  assert.equal(fdec.h, 510, "aspect ratio preserved (600·680/800)");

  // already within bounds → byte-preserving no-op (same base64 back)
  const small = await encode(makeRGBA(200, 200, 4), 200, 200);
  const noop = await fit(small, 680);
  assert.equal(noop, small, "fit under the bound returns the input bytes unchanged");
});

test("image.decode returns a CelError on non-PNG input (readable, not a crash)", async () => {
  const state = createInitialState();
  const decode = resolveFn(state, "image.decode");
  const out = await decode("bm90IGEgcG5n"); // base64("not a png")
  assert.ok(isCelError(out), "garbage input should yield a CelError, not throw");
});
