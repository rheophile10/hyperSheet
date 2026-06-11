import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// xlsx — read/write .xlsx into/out of cels (the Excel on-ramp; the ~30 excel
// formulas already ship, this is the I/O half). A LIBRARY capability. .xlsx is
// a ZIP of XML; we hand-roll a minimal ZIP (no deps) and use the cross-runtime
// CompressionStream / DecompressionStream ("deflate-raw" = ZIP method 8) so the
// same code runs in Bun (CLI) and the browser. MVP: one sheet, number/string/
// formula-as-text values, shared OR inline strings on read. The verbs route
// import → genesis(cels) and export → a download.
// ============================================================================

export interface XCell { ref: string; value: unknown }

// ── A1 <-> {col,row} (1-based row, 0-based col) ──────────────────────────────
const parseRef = (ref: string): { col: number; row: number } | null => {
  const m = /^([A-Z]+)(\d+)$/.exec(ref); if (!m) return null;
  let col = 0; for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2]!, 10) };
};

// ── crc32 + deflate (raw) ────────────────────────────────────────────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Uint8Array): number => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 0xFF]! ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const pipe = async (data: Uint8Array, t: "CompressionStream" | "DecompressionStream"): Promise<Uint8Array> => {
  const Ctor = (globalThis as Record<string, unknown>)[t] as { new (f: string): unknown };
  const body = (new Response(data as never).body) as { pipeThrough(x: unknown): unknown } | null;
  if (!body) throw new Error("xlsx: no stream body");
  const piped = body.pipeThrough(new Ctor("deflate-raw"));
  return new Uint8Array(await new Response(piped as never).arrayBuffer());
};
const deflateRaw = (d: Uint8Array): Promise<Uint8Array> => pipe(d, "CompressionStream");
const inflateRaw = (d: Uint8Array): Promise<Uint8Array> => pipe(d, "DecompressionStream");

// ── ZIP (DEFLATE, method 8) ──────────────────────────────────────────────────
interface ZEntry { name: string; data: Uint8Array }
const zipWrite = async (entries: ZEntry[]): Promise<Uint8Array> => {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameB = enc.encode(e.name);
    const crc = crc32(e.data);
    const comp = await deflateRaw(e.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true);
    lh.setUint16(8, 8, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, comp.length, true); lh.setUint32(22, e.data.length, true);
    lh.setUint16(26, nameB.length, true); lh.setUint16(28, 0, true);
    const local = new Uint8Array(30 + nameB.length + comp.length);
    local.set(new Uint8Array(lh.buffer), 0); local.set(nameB, 30); local.set(comp, 30 + nameB.length);
    locals.push(local);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0, true); ch.setUint16(10, 8, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, comp.length, true); ch.setUint32(24, e.data.length, true);
    ch.setUint16(28, nameB.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    const central = new Uint8Array(46 + nameB.length);
    central.set(new Uint8Array(ch.buffer), 0); central.set(nameB, 46);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true); eocd.setUint16(20, 0, true);
  const total = offset + cdSize + 22;
  const out = new Uint8Array(total); let p = 0;
  for (const l of locals) { out.set(l, p); p += l.length; }
  for (const c of centrals) { out.set(c, p); p += c.length; }
  out.set(new Uint8Array(eocd.buffer), p);
  return out;
};

const zipRead = async (bytes: Uint8Array): Promise<Map<string, Uint8Array>> => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // find EOCD (scan back for 0x06054b50)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error("xlsx: not a zip (no EOCD)");
  const count = dv.getUint16(eocd + 10, true);
  let cd = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(cd, true) !== 0x02014b50) break;
    const method = dv.getUint16(cd + 10, true);
    const compSize = dv.getUint32(cd + 20, true);
    const nameLen = dv.getUint16(cd + 28, true);
    const extraLen = dv.getUint16(cd + 30, true);
    const commentLen = dv.getUint16(cd + 32, true);
    const lho = dv.getUint32(cd + 42, true);
    const name = dec.decode(bytes.subarray(cd + 46, cd + 46 + nameLen));
    // local header: data starts after its own name + extra
    const lNameLen = dv.getUint16(lho + 26, true);
    const lExtraLen = dv.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 0 ? raw.slice() : await inflateRaw(raw));
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return out;
};

// ── xlsx XML (minimal) ───────────────────────────────────────────────────────
const xmlEsc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sheetXml = (cells: XCell[]): string => {
  const byRow = new Map<number, XCell[]>();
  for (const c of cells) { const a = parseRef(c.ref); if (!a) continue; (byRow.get(a.row) ?? byRow.set(a.row, []).get(a.row)!).push(c); }
  const rows = [...byRow.keys()].sort((a, b) => a - b).map((r) => {
    const cs = byRow.get(r)!.sort((a, b) => parseRef(a.ref)!.col - parseRef(b.ref)!.col).map((c) => {
      const v = c.value;
      if (typeof v === "number" && Number.isFinite(v)) return `<c r="${c.ref}"><v>${v}</v></c>`;
      if (v == null || v === "") return "";
      return `<c r="${c.ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(String(v))}</t></is></c>`;
    }).join("");
    return `<row r="${r}">${cs}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
};

const FILES = (sheet: string): ZEntry[] => {
  const enc = new TextEncoder();
  const e = (name: string, body: string): ZEntry => ({ name, data: enc.encode(body) });
  return [
    e("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    e("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    e("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    e("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    e("xl/worksheets/sheet1.xml", sheet),
  ];
};

export const toXlsx = (cells: XCell[]): Promise<Uint8Array> => zipWrite(FILES(sheetXml(cells)));

export const fromXlsx = async (bytes: Uint8Array): Promise<XCell[]> => {
  const files = await zipRead(bytes);
  const dec = new TextDecoder();
  // shared strings (if present)
  const shared: string[] = [];
  const ss = files.get("xl/sharedStrings.xml");
  if (ss) for (const m of dec.decode(ss).matchAll(/<si>(.*?)<\/si>/gs)) shared.push([...m[1]!.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((t) => unesc(t[1]!)).join(""));
  // the (first) worksheet
  let sheetName = "xl/worksheets/sheet1.xml";
  if (!files.has(sheetName)) for (const k of files.keys()) if (/xl\/worksheets\/.*\.xml$/.test(k)) { sheetName = k; break; }
  const sheet = dec.decode(files.get(sheetName) ?? new Uint8Array());
  const out: XCell[] = [];
  for (const m of sheet.matchAll(/<c\b([^>]*)>(.*?)<\/c>/gs)) {
    const attrs = m[1]!, inner = m[2]!;
    const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1]; if (!ref) continue;
    const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
    let value: unknown;
    if (t === "inlineStr") value = unesc([...inner.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((x) => x[1]!).join(""));
    else if (t === "s") { const i = Number(/<v>(.*?)<\/v>/s.exec(inner)?.[1] ?? -1); value = shared[i] ?? ""; }
    else if (t === "str") value = unesc(/<v>(.*?)<\/v>/s.exec(inner)?.[1] ?? "");
    else { const raw = /<v>(.*?)<\/v>/s.exec(inner)?.[1]; if (raw == null) continue; value = Number(raw); }
    out.push({ ref, value });
  }
  return out;
};
const unesc = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

// ── verbs ────────────────────────────────────────────────────────────────────
// xlsximport(base64) — parse .xlsx bytes (base64) into a genesis worksheet of
// cels. Returns a {genesis} request the host's drain materializes.
const importFn: Fn = (async (_state: State, b64: unknown): Promise<unknown> => {
  const bin = atob(String(b64 ?? "")); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const cells = await fromXlsx(bytes);
  const layer = "xlsx";
  return { genesis: true, layer, cels: Object.fromEntries(cells.map((c) => [`${layer}.${c.ref}`, { celType: "ValueCel", v: c.value, metadata: { name: c.ref, segment: layer } }])) };
}) as Fn;

// xlsxexport(segment?) — serialize a grid segment's value cels to .xlsx, base64.
const exportFn: Fn = (async (state: State, segment?: unknown): Promise<string> => {
  const seg = String(segment ?? "元");
  const cells: XCell[] = [];
  for (const [k, c] of state.cels) {
    if (c.celType !== "ValueCel" && c.celType !== "FormulaCel") continue;
    const dot = k.indexOf("."); const sgn = dot === -1 ? "" : k.slice(0, dot);
    if (sgn !== seg) continue;
    const ref = (c.metadata as { name?: string }).name ?? (dot === -1 ? k : k.slice(dot + 1));
    if (!parseRef(ref)) continue;
    cells.push({ ref, value: c.v });
  }
  const bytes = await toXlsx(cells);
  let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}) as Fn;

export const name = "xlsx" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["xlsximport", importFn],
  ["xlsxexport", exportFn],
]));
