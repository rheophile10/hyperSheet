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
