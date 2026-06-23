import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import { fromXlsx } from "../xlsx/index.js";
import { zipBytes, unzipBytes } from "../segment-archive/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// sheet-io — worksheet save/open + serialization (CSV / XLSX / .甲), extracted
// from the gen-1 sheet-host segment so saveSheet/openAsSheet have an importable
// home independent of the windowing stack. A consumer (e.g. file-explorer) does
// `import { openAsSheet } from "../sheet-io/index.js"` and gets the new segment
// name back; the same fns also dispatch as the sheetio.save/sheetio.open verbs.
//
// Cross-segment runtime deps (resolved by key, not imported):
//   xlsxexport, fs.write, ensureSegments, genesis.drain, view.refresh,
//   explorer.refresh, runCycle, drain
// fromXlsx + zipBytes/unzipBytes ARE imported (pure helpers, no kernel state).
// ============================================================================

const A1RE = /^([A-Z]+)(\d+)$/;
const colNum = (letters: string): number => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
const colA = (n: number): string => { let s = "", x = n + 1; while (x > 0) { s = String.fromCharCode(65 + (x - 1) % 26) + s; x = Math.floor((x - 1) / 26); } return s; };

// re-paint helper: a value change must propagate through the cycle before paint.
const wrepaint = async (state: State): Promise<unknown> => {
  await Promise.resolve((resolveFn(state, "runCycle") as Fn)(state));
  return Promise.resolve((resolveFn(state, "drain") as Fn)(state, "dom.paint"));
};

// the grid cels of a worksheet segment as { addr, col, row, v, f }, plus extent.
// A grid cel is `<seg>.A1` (an A1-addressed Value/Formula cel).
const gridCells = (state: State, seg: string): { addr: string; col: number; row: number; v: unknown; f?: string }[] => {
  const out: { addr: string; col: number; row: number; v: unknown; f?: string }[] = [];
  const prefix = `${seg}.`;
  for (const [k, c] of state.cels) {
    if (!k.startsWith(prefix)) continue;
    if (c.celType !== "ValueCel" && c.celType !== "FormulaCel") continue;
    const addr = (c.metadata as { name?: string }).name ?? k.slice(prefix.length);
    const m = A1RE.exec(addr); if (!m) continue;
    out.push({ addr, col: colNum(m[1]!), row: Number(m[2]!), v: c.v, f: (c as { f?: string }).f });
  }
  return out;
};

// a blank N×N worksheet cels record.
const blankCells = (seg: string, rows: number, cols: number): Record<string, unknown> => {
  const cells: Record<string, unknown> = {};
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const addr = `${colA(c)}${r + 1}`;
    cells[`${seg}.${addr}`] = { celType: "ValueCel", v: "", metadata: { segment: seg, name: addr, parser: "infix" } };
  }
  return cells;
};

// ── CSV ──────────────────────────────────────────────────────────────────────
// a cell's VALUE per row×col (A1 order); a formula serializes its evaluated VALUE
// (CSV is values-only). RFC-4180 quoting.
const csvField = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (state: State, seg: string): string => {
  const cells = gridCells(state, seg);
  let maxR = 0, maxC = 0;
  const at = new Map<string, unknown>();
  for (const c of cells) { at.set(`${c.col},${c.row}`, c.v); maxR = Math.max(maxR, c.row); maxC = Math.max(maxC, c.col); }
  const lines: string[] = [];
  for (let r = 1; r <= maxR; r++) {
    const row: string[] = [];
    for (let c = 1; c <= maxC; c++) row.push(csvField(at.get(`${c},${r}`)));
    lines.push(row.join(","));
  }
  return lines.join("\n");
};
// CSV parse → rows of string fields (RFC-4180: quoted fields, "" escapes, CR/LF).
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = []; let row: string[] = [], field = "", inQ = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
};
// a CSV's rows → a worksheet cels record: numeric-looking fields become numbers.
const csvToCells = (seg: string, rows: string[][]): Record<string, unknown> => {
  const cells: Record<string, unknown> = {};
  rows.forEach((cols, r) => cols.forEach((field, c) => {
    if (field === "") return;
    const num = Number(field);
    const v = field.trim() !== "" && !Number.isNaN(num) ? num : field;
    const addr = `${colA(c)}${r + 1}`;
    cells[`${seg}.${addr}`] = { celType: "ValueCel", v, metadata: { segment: seg, name: addr, parser: "infix" } };
  }));
  return cells;
};

// ── .甲 (single-sheet plastron archive) ──────────────────────────────────────
// a zip carrying the RICH form: every grid cel's celType + value + formula, so
// formulas + types round-trip (unlike CSV/XLSX). Reuses the zero-dep zip core
// from segment-archive. Layout: sheet.json = { format, cells: [{addr, …}] }.
const toJia = async (state: State, seg: string): Promise<Uint8Array> => {
  const cells = gridCells(state, seg).map((c) => ({ addr: c.addr, celType: c.f !== undefined ? "FormulaCel" : "ValueCel", v: c.v, f: c.f }));
  const body = JSON.stringify({ format: "plastron-sheet/1", segment: seg, cells }, null, 2);
  return zipBytes([{ path: "sheet.json", bytes: new TextEncoder().encode(body) }]);
};
const jiaToCells = async (seg: string, bytes: Uint8Array): Promise<Record<string, unknown>> => {
  const entries = await unzipBytes(bytes);
  const sheet = entries.find((e) => e.path === "sheet.json" || e.path.endsWith("/sheet.json"));
  if (!sheet) throw new Error("甲: no sheet.json in archive");
  const doc = JSON.parse(new TextDecoder().decode(sheet.bytes)) as { cells?: { addr: string; celType?: string; v?: unknown; f?: string }[] };
  const cells: Record<string, unknown> = {};
  for (const c of doc.cells ?? []) {
    if (!A1RE.test(c.addr)) continue;
    const isF = c.celType === "FormulaCel" && typeof c.f === "string";
    cells[`${seg}.${c.addr}`] = isF
      ? { celType: "FormulaCel", f: c.f, metadata: { segment: seg, name: c.addr, parser: "infix" } }
      : { celType: "ValueCel", v: c.v, metadata: { segment: seg, name: c.addr, parser: "infix" } };
  }
  return cells;
};

// ── materialize a worksheet segment from a cels record ────────────────────────
// a fresh, unused sheet segment name with the given prefix (sheet1, sheet2, …).
const freshSeg = (state: State, prefix: string): string => {
  let n = 1; while (state.cels.get(`${prefix}${n}.maker`)) n++;
  return `${prefix}${n}`;
};
// build a maker cel holding the genesis request, feed it to genesis.drain (which
// stamps each cell generatedBy=<maker>, materializes the grid); the maker stays
// off the grid.
const materializeSheet = async (state: State, seg: string, cells: Record<string, unknown>): Promise<void> => {
  const maker = `${seg}.maker`;
  const makerCel = {
    celType: "ValueCel" as const,
    v: { genesis: true, layer: seg, access: { get: ["origin"], set: "private" }, cels: cells },
    metadata: { key: maker, segment: seg, name: "maker" },
    locked: false,
  };
  state.cels.set(maker, makerCel);
  const gd = resolveFn(state, "genesis.drain") as Fn | undefined;
  if (gd) await gd([{ cel: makerCel, state }], state);
};
// place a freshly-materialized sheet as a STANDALONE window (untabbed), staggered
// via win.geom, then refresh the view + repaint so its cells render.
type WGeom = { x?: number; y?: number; z?: number; min?: number; closed?: number; host?: string };
const geomMap = (state: State): Record<string, WGeom> => { const v = state.cels.get("win.geom")?.v; return (v && typeof v === "object" && !Array.isArray(v)) ? { ...(v as Record<string, WGeom>) } : {}; };
const nextZ = async (state: State): Promise<number> => {
  const z = (Number(state.cels.get("win.topz")?.v) || 100) + 1;
  if (state.cels.get("win.topz")) await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, "win.topz", z));
  else await Promise.resolve((resolveFn(state, "setCel") as Fn)(state, "win.topz", { celType: "ValueCel", v: z, metadata: { key: "win.topz", segment: "win" } }));
  return z;
};
const placeStandalone = async (state: State, seg: string): Promise<void> => {
  const m = geomMap(state);
  const i = Object.keys(m).length;
  m[seg] = { ...(m[seg] ?? {}), host: undefined, x: 60 + (i % 6) * 34, y: 60 + (i % 6) * 34, z: await nextZ(state), min: 0, closed: 0 };
  await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, "win.geom", m));
  if (state.cels.get("view.refresh")) await Promise.resolve((resolveFn(state, "view.refresh") as Fn)(state));
  await wrepaint(state);
};

// ── saveSheet / openAsSheet — the importable surface ──────────────────────────
// saveSheet(state, seg, fmt) — serialize a worksheet segment to bytes + a name.
// fmt ∈ {csv, xlsx, 甲}. Returns { bytes, filename, text? }. xlsx reuses the xlsx
// segment's exporter (resolved by key — a runtime cross-segment dep).
type SaveOut = { bytes: Uint8Array; filename: string; text?: string };
const saveSheet = async (state: State, seg: string, fmt: string): Promise<SaveOut> => {
  if (fmt === "csv") { const text = toCsv(state, seg); return { bytes: new TextEncoder().encode(text), filename: `${seg}.csv`, text }; }
  if (fmt === "甲" || fmt === "jia") { const bytes = await toJia(state, seg); return { bytes, filename: `${seg}.甲` }; }
  // xlsx — reuse the xlsx exporter (base64) → bytes.
  const b64 = String(await Promise.resolve((resolveFn(state, "xlsxexport") as Fn)(state, seg)));
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, filename: `${seg}.xlsx` };
};

// openAsSheet(state, bytes, name) — detect format by extension, build a worksheet
// cels record, materialize it as a NEW standalone sheet window. csv → values
// grid; xlsx → fromXlsx; 甲 → the rich archive reader. Returns the new segment.
const extOf = (name: string): string => { const b = (name.split("/").pop() || name); const i = b.lastIndexOf("."); return i < 0 ? "" : b.slice(i + 1).toLowerCase(); };
const openAsSheet = async (state: State, bytes: Uint8Array, name: string): Promise<string> => {
  const ext = extOf(name);
  const seg = freshSeg(state, "sheet");
  let cells: Record<string, unknown>;
  if (ext === "csv") cells = csvToCells(seg, parseCsv(new TextDecoder().decode(bytes)));
  else if (ext === "甲" || ext === "jia") cells = await jiaToCells(seg, bytes);
  else { // xlsx (default for spreadsheet-y bytes)
    const xcells = await fromXlsx(bytes);
    cells = {};
    for (const c of xcells) if (A1RE.test(c.ref)) cells[`${seg}.${c.ref}`] = { celType: "ValueCel", v: c.value, metadata: { segment: seg, name: c.ref, parser: "infix" } };
  }
  if (Object.keys(cells).length === 0) cells = blankCells(seg, 10, 10);   // an empty file still opens a usable sheet
  await materializeSheet(state, seg, cells);
  await placeStandalone(state, seg);
  return seg;
};

// ── verb surface ──────────────────────────────────────────────────────────────
// sheetio.save({ seg, fmt }) — serialize, write to OPFS (best-effort) + return the
// SaveOut so a host can offer a download. sheetio.open({ bytes, name }) → seg.
const sheetioSave: Fn = (async (state: State, payload: unknown): Promise<SaveOut | null> => {
  const p = payload as { seg?: string; fmt?: string } | undefined;
  const seg = String(p?.seg ?? ""), fmt = String(p?.fmt ?? "");
  if (!seg || !fmt) return null;
  const out = await saveSheet(state, seg, fmt);
  const fsWrite = resolveFn(state, "fs.write") as Fn | undefined;
  const ensure = resolveFn(state, "ensureSegments") as Fn | undefined;
  if (fsWrite) { try { if (ensure) await ensure(state, ["file-store"]); await fsWrite(`/${out.filename}`, out.bytes); } catch { /* no fs here */ } }
  return out;
}) as Fn;
const sheetioOpen: Fn = (async (state: State, payload: unknown): Promise<string | null> => {
  const p = payload as { bytes?: Uint8Array; name?: string } | undefined;
  if (!p?.bytes || !p?.name) return null;
  return openAsSheet(state, p.bytes, String(p.name));
}) as Fn;

export const name = "sheet-io" as const;

// direct surface for hosts (e.g. the explorer double-click) + tests, skipping cel
// dispatch — they already hold the bytes / want the new segment name back.
export { saveSheet, openAsSheet, toCsv, parseCsv, csvToCells, toJia, jiaToCells, gridCells };

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sheetio.save", sheetioSave],
  ["sheetio.open", sheetioOpen],
]));
