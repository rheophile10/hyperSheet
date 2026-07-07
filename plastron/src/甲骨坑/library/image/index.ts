import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns, makeCelError } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// image — a browser-API *effect* segment (idiom-mate of `sound` = Web Audio):
// PNG ⇆ RGBA plus a max-dimension downscale. The no-Python replacement for the
// PIL I/O the Pyodide sibling (chaosedgesteg) leans on.
//
//   image.decode(png)        → { w, h, rgba }   PNG bytes/base64 → RGBA8 buffer
//   image.encode(rgba, w, h) → base64 PNG        RGBA8 buffer → lossless PNG
//   image.fit(png, maxDim)   → base64 PNG        downscale so max(w,h) ≤ maxDim
//
// Two interchangeable back ends behind the SAME one-sentence contracts:
//   • the browser canvas (OffscreenCanvas + createImageBitmap) when present —
//     it handles every PNG flavour a user might upload (palette, interlaced,
//     grayscale) and resamples with the platform's filter; and
//   • a dependency-free pure-JS PNG codec (zlib via the WHATWG
//     Compression/DecompressionStream, filter 0, 8-bit truecolor) as the
//     fallback for headless runtimes (bun/node CI) — lossless, so LSBs survive.
// Encoding always goes through the pure-JS codec so the produced bytes are
// deterministic and lossless across environments (a canvas re-encode is also
// lossless PNG, but the codec keeps embed → download → decode byte-stable).
// No steg policy lives here; `maxDim` is an argument (R2). Reusable by any
// future image app.

// ── base64 (chunked, btoa/atob when present; RFC-4648 fallback) ──────────────
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const _btoa = (globalThis as { btoa?: (s: string) => string }).btoa;
const _atob = (globalThis as { atob?: (s: string) => string }).atob;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  if (_btoa) return _btoa(bin);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1], b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += b1 === undefined ? "=" : B64[(n >> 6) & 63]!;
    out += b2 === undefined ? "=" : B64[n & 63]!;
  }
  return out;
};

const base64ToBytes = (b64: string): Uint8Array => {
  const s = b64.replace(/[^A-Za-z0-9+/]/g, "");
  if (_atob) {
    const bin = _atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const lut = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) lut[B64.charCodeAt(i)] = i;
  const out = new Uint8Array((s.length * 3) >> 2);
  let o = 0, buf = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = lut[s.charCodeAt(i)]!;
    if (v < 0) continue;
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xFF; }
  }
  return out.subarray(0, o);
};

// Normalize an image argument (Uint8Array | number[] | base64 | data:URL) to bytes.
const toBytes = (input: unknown): Uint8Array => {
  if (input instanceof Uint8Array) return input;
  if (Array.isArray(input)) return Uint8Array.from(input as number[]);
  if (typeof input === "string") {
    const s = input.startsWith("data:") ? input.slice(input.indexOf(",") + 1) : input;
    return base64ToBytes(s);
  }
  throw new Error(`image: expected PNG bytes or a base64 string, got ${typeof input}.`);
};

// ── zlib (WHATWG streams — present in browsers, bun, node ≥18) ────────────────
const streamPipe = async (data: Uint8Array, kind: "CompressionStream" | "DecompressionStream"): Promise<Uint8Array> => {
  const Ctor = (globalThis as Record<string, unknown>)[kind] as { new (fmt: string): unknown } | undefined;
  if (!Ctor) throw new Error(`image: ${kind} unavailable in this runtime.`);
  const body = (new Response(data as never).body) as { pipeThrough(x: unknown): unknown } | null;
  if (!body) throw new Error("image: no stream body");
  const piped = body.pipeThrough(new Ctor("deflate"));                 // "deflate" = zlib-wrapped (PNG's IDAT format)
  return new Uint8Array(await new Response(piped as never).arrayBuffer());
};
const zlibDeflate = (d: Uint8Array): Promise<Uint8Array> => streamPipe(d, "CompressionStream");
const zlibInflate = (d: Uint8Array): Promise<Uint8Array> => streamPipe(d, "DecompressionStream");

// ── pure-JS PNG codec (8-bit truecolor RGB/RGBA, non-interlaced) ─────────────
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b: Uint8Array): number => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]!) & 0xFF]! ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

const pngEncode = async (rgba: Uint8Array, w: number, h: number): Promise<Uint8Array> => {
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit, RGBA, deflate, filter 0, no interlace
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1); }
  const idat = await zlibDeflate(raw);
  const parts = [PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

interface Decoded { w: number; h: number; rgba: Uint8Array }

const pngDecode = async (bytes: Uint8Array): Promise<Decoded> => {
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) throw new Error("image: not a PNG (bad signature).");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat: Uint8Array[] = [];
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
    if (type === "IHDR") { w = dv.getUint32(off + 8); h = dv.getUint32(off + 12); bitDepth = bytes[off + 16]!; colorType = bytes[off + 17]!; }
    else if (type === "IDAT") idat.push(bytes.subarray(off + 8, off + 8 + len));
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`image: unsupported PNG (bit depth ${bitDepth}, color type ${colorType}); the pure-JS codec handles 8-bit RGB/RGBA only.`);
  }
  const ch = colorType === 6 ? 4 : 3;
  const comp = new Uint8Array(idat.reduce((n, p) => n + p.length, 0));
  let c = 0; for (const p of idat) { comp.set(p, c); c += p.length; }
  const raw = await zlibInflate(comp);
  const stride = w * ch;
  const out = new Uint8Array(w * h * 4);
  const line = new Uint8Array(stride), prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++]!;
    for (let x = 0; x < stride; x++) {
      const rawB = raw[p++]!;
      const a = x >= ch ? line[x - ch]! : 0;
      const b = prev[x]!;
      const cc = x >= ch ? prev[x - ch]! : 0;
      let val: number;
      if (filter === 0) val = rawB;
      else if (filter === 1) val = rawB + a;
      else if (filter === 2) val = rawB + b;
      else if (filter === 3) val = rawB + ((a + b) >> 1);
      else if (filter === 4) val = rawB + paeth(a, b, cc);
      else throw new Error(`image: bad PNG filter ${filter}.`);
      line[x] = val & 0xFF;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * ch;
      out[o] = line[s]!; out[o + 1] = line[s + 1]!; out[o + 2] = line[s + 2]!;
      out[o + 3] = ch === 4 ? line[s + 3]! : 255;
    }
    prev.set(line);
  }
  return { w, h, rgba: out };
};

// box-average downscale so max(w,h) ≤ maxDim; a no-op when already within.
const boxFit = (rgba: Uint8Array, w: number, h: number, maxDim: number): Decoded => {
  const md = Math.max(w, h);
  if (md <= maxDim) return { rgba, w, h };
  const scale = maxDim / md;
  const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const sx0 = Math.floor(x * w / nw), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / nw));
    const sy0 = Math.floor(y * h / nh), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / nh));
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
      const i = (sy * w + sx) * 4; r += rgba[i]!; g += rgba[i + 1]!; b += rgba[i + 2]!; a += rgba[i + 3]!; n++;
    }
    const o = (y * nw + x) * 4;
    out[o] = (r / n) | 0; out[o + 1] = (g / n) | 0; out[o + 2] = (b / n) | 0; out[o + 3] = (a / n) | 0;
  }
  return { rgba: out, w: nw, h: nh };
};

// ── canvas back end (browser) ────────────────────────────────────────────────
type Canvas2D = { drawImage: (b: unknown, ...a: number[]) => void; getContext: (t: string) => { drawImage: Canvas2D["drawImage"]; getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray }; putImageData: (d: unknown, x: number, y: number) => void } | null; convertToBlob: (o?: { type?: string }) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }> };
const G = globalThis as Record<string, unknown>;
const hasCanvas = (): boolean =>
  typeof G.OffscreenCanvas === "function" && typeof G.createImageBitmap === "function";
const newCanvas = (w: number, h: number): Canvas2D => new (G.OffscreenCanvas as { new (w: number, h: number): Canvas2D })(w, h);

const canvasDecode = async (bytes: Uint8Array): Promise<Decoded> => {
  const bmp = await (G.createImageBitmap as (b: unknown) => Promise<{ width: number; height: number; close?: () => void }>)(
    new (G.Blob as { new (a: unknown[], o: { type: string }): unknown })([bytes], { type: "image/png" }),
  );
  const w = bmp.width, h = bmp.height;
  const cv = newCanvas(w, h);
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(bmp as unknown, 0, 0);
  bmp.close?.();
  const rgba = new Uint8Array(ctx.getImageData(0, 0, w, h).data);
  return { w, h, rgba };
};

// ── verbs ────────────────────────────────────────────────────────────────────
const decode: Fn = (async (png: unknown): Promise<Decoded | ReturnType<typeof makeCelError>> => {
  try {
    const bytes = toBytes(png);
    if (hasCanvas()) { try { return await canvasDecode(bytes); } catch { /* fall back to pure-JS */ } }
    return await pngDecode(bytes);
  } catch (e) { return makeCelError(["image.decode"], "ImageError", e); }
}) as Fn;

const encode: Fn = (async (rgba: unknown, w: unknown, h: unknown): Promise<string | ReturnType<typeof makeCelError>> => {
  try {
    const buf = rgba instanceof Uint8Array ? rgba
      : Array.isArray(rgba) ? Uint8Array.from(rgba as number[])
      : (rgba && ArrayBuffer.isView(rgba as ArrayBufferView)) ? new Uint8Array((rgba as ArrayBufferView).buffer, (rgba as ArrayBufferView).byteOffset, (rgba as ArrayBufferView).byteLength)
      : null;
    const W = Number(w), H = Number(h);
    if (!buf) throw new Error("image.encode: rgba must be a byte buffer.");
    if (!Number.isInteger(W) || !Number.isInteger(H) || W <= 0 || H <= 0) throw new Error("image.encode: w and h must be positive integers.");
    if (buf.length < 4 * W * H) throw new Error(`image.encode: rgba too small (${buf.length} bytes for ${W}×${H}, need ${4 * W * H}).`);
    return bytesToBase64(await pngEncode(buf.subarray(0, 4 * W * H), W, H));
  } catch (e) { return makeCelError(["image.encode"], "ImageError", e); }
}) as Fn;

const fit: Fn = (async (png: unknown, maxDim: unknown): Promise<string | ReturnType<typeof makeCelError>> => {
  try {
    const m = Number(maxDim);
    if (!Number.isFinite(m) || m <= 0) throw new Error("image.fit: maxDim must be a positive number.");
    const bytes = toBytes(png);
    const dec = hasCanvas() ? await canvasDecode(bytes).catch(() => pngDecode(bytes)) : await pngDecode(bytes);
    if (Math.max(dec.w, dec.h) <= m) return bytesToBase64(bytes);            // no-op when already within bounds
    const f = boxFit(dec.rgba, dec.w, dec.h, m);
    return bytesToBase64(await pngEncode(f.rgba, f.w, f.h));
  } catch (e) { return makeCelError(["image.fit"], "ImageError", e); }
}) as Fn;

export const name = "image" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["image.decode", decode],
  ["image.encode", encode],
  ["image.fit",    fit],
]));
