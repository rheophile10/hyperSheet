import type {
  甲骨, Cel, ChannelEnqueue, Fn, Key, State, VNode, AttrValue, EventBinding,
} from "../../../types/index.js";
import {
  bindNativeFns, resolveFn, ensureSegments, appendError, makeCelError, retireCel,
  dangerousUsage, setConsent, DANGEROUS, lockConsent,
  isSegmentPending,
} from "../../../kernel/index.js";
import {
  dumpArchive, dumpSegments, loadArchive, documentSegments, isSubstrateSegment, archiveSegmentNames,
} from "../../library/segment-io/index.js";
// Core rendering comes from the dom LIBRARY — the app doesn't re-roll
// vnode building, diffing, or the memo. `el`/`text` build the canonical VNode;
// `memo` attaches the diff's O(changed) short-circuit hint (see dom).
import { el as makeEl, text as T } from "../../library/dom/index.js";
import { BUILTIN_DOCS } from "../../library/sheet/utils/infix.js";
import { encodeLink, decodeLink, encodeEncLink, decodeEncLink, ENC_METHOD,
  encryptPayload, decryptPayload,
  encodeOtpLink, otpDecryptPayload, parseOtpUrl, OTP_METHOD, type LinkCodec } from "./share-link.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// origin — the starting point (origin-segment.md, accepted).
//
// The origin IS A SPREADSHEET and 元 is cell A1. Boot contract:
// createInitialState() + ensureSegments(["origin"]) + hydrate([],[])
// mounts 元.view at 元.mount ("#app"). Every cel in 元.cells is an
// editable spreadsheet cell: it shows its evaluated value; click the
// label to edit the source; Enter re-evaluates. 元 (A1) is seeded with
// the readme. The ONLY thing past an ordinary spreadsheet — a cell's
// formula may also build dom objects, more cels, worksheets, toolbars:
//   =1+1          → 2
//   =cels(3,3)    → a 3×3 worksheet of cels, each like 元
//   =dom("h2"…)   → a heading rendered in the cell
// 元.view is UNLOCKED — it renders through dom like any view,
// built to be reworked in place.
// ============================================================================

// loose view alias for ergonomic in-app access (.children / raw splicing); the
// canonical VNode the painter sees is built by the library `el`/`text` below.
type V = { type: "el" | "text"; tag?: string; key?: string; memo?: unknown; attrs?: Record<string, unknown>; events?: Record<string, unknown>; children?: V[]; text?: string };

const isVnode = (v: unknown): v is V =>
  !!v && typeof v === "object" && ((v as V).type === "el" || (v as V).type === "text");

// mount(selector, content) — PLACE a dom object UNDER another element the view
// renders, instead of inside the cell that holds the formula. Stays in origin
// (an application segment, parked by default) so the verb name doesn't collide
// with user cels named "mount" in other hosts. sheetView renders the {__mount}
// values this produces.
const mount: Fn = (target: unknown, content: unknown): unknown =>
  ({ __mount: String(target ?? ".origin"), vnode: isVnode(content) ? content : T(content) });

// loose-typed adapter over the LIBRARY builder — origin's call sites pass plain
// records; the painter stringifies, so the cast is safe.
const el = (tag: string, attrs: Record<string, unknown>, children: V[], events?: Record<string, unknown>): V =>
  makeEl(tag, attrs as Record<string, AttrValue>, children as VNode[], events as Record<string, EventBinding> | undefined) as V;


// dom/style/attr/on — the vnode-authoring vocabulary — moved to the `dom`
// LIBRARY segment (tier-boundary doctrine). origin depends on `dom`, so those
// verbs resolve from the registry; origin's TS uses the el/text builders
// directly (imported above) and no longer registers the formula verbs.


/** How a cell's VALUE shows when not being edited: a dom vnode renders
 *  live; a number/string shows as text; a structure request (genesis /
 *  defn) shows a ƒ marker (it made cels/functions elsewhere); errors
 *  show Excel-style. Empty shows nothing. */
// A genesis request's value, shown as a compact YAML-ish tree of what it
// built: one line per layer (rows×cols), and the seeded cells under it
// (address: source). The cell is resizable; long trees scroll. Beats the
// old "ƒ grid" glyph — the formula's OUTPUT becomes readable documentation.
const genesisSummary = (cels: Record<string, unknown> | undefined): string => {
  if (!cels) return "ƒ cels";
  const layers = new Map<string, { rows: number; cols: number; filled: [string, string][] }>();
  const colIdx = (a: string): number => { const m = a.match(/^([A-Z]+)/); if (!m) return 0; let n = 0; for (const ch of m[1]!) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
  const rowIdx = (a: string): number => Number((a.match(/(\d+)$/) ?? [])[1] ?? 0);
  for (const [k, spec] of Object.entries(cels)) {
    const dot = k.lastIndexOf("."); if (dot < 0) continue;
    const layer = k.slice(0, dot), addr = k.slice(dot + 1);
    const e = layers.get(layer) ?? { rows: 0, cols: 0, filled: [] };
    e.rows = Math.max(e.rows, rowIdx(addr)); e.cols = Math.max(e.cols, colIdx(addr));
    const s = spec as { f?: string; v?: unknown };
    const src = s.f ?? (s.v === "" || s.v == null ? "" : String(s.v));
    if (src !== "") e.filled.push([addr, src]);
    layers.set(layer, e);
  }
  const lines: string[] = [];
  for (const [layer, e] of layers) {
    lines.push(`${layer}: ${e.rows}×${e.cols}`);
    for (const [addr, src] of e.filled) lines.push(`  ${addr}: ${src.length > 48 ? src.slice(0, 47) + "…" : src}`);
  }
  return lines.length ? lines.join("\n") : "ƒ cels";
};






// Build the genesis request for ONE named grid (rows×cols of empty
// infix cels under `name.A1` …). Shared by grid() and sheets().
// a cell SOURCE → cel spec. Like sniff, but a bare `name(…)` call counts as a
// formula too (so a cell value like sum(a1,b1) becomes a formula, not text).
const sniffCel = (src: string): { celType: string; f?: string; v?: unknown; parser?: string } => {
  const t = String(src ?? "").trim();
  if (t === "") return { celType: "ValueCel", v: "" };
  if (t.startsWith("=")) return { celType: "FormulaCel", f: t, parser: "infix" };
  if (t.startsWith("(")) return { celType: "FormulaCel", f: t, parser: "f" };
  if (/^[a-zA-Z_][\w.-]*\s*\(/.test(t)) return { celType: "FormulaCel", f: "=" + t, parser: "infix" };
  const n = Number(t);
  return { celType: "ValueCel", v: t !== "" && !Number.isNaN(n) ? n : src };
};

const gridShape = (rows: unknown, cols: unknown, name: string, values?: Record<string, unknown>): { layer: string; cels: Record<string, unknown> } => {
  const r = Math.max(1, Math.min(100, Math.floor(Number(rows) || 1))); // capped — true million-scale needs virtualization (excel-scale roadmap)
  const c = Math.max(1, Math.min(50, Math.floor(Number(cols) || 1)));
  const colLetter = (n: number): string => { let s = "", x = n + 1; while (x > 0) { s = String.fromCharCode(65 + (x - 1) % 26) + s; x = Math.floor((x - 1) / 26); } return s; };
  const valAt = (addr: string): string => {
    if (!values) return "";
    const hit = values[addr] ?? values[addr.toLowerCase()] ?? values[addr.toUpperCase()];
    return hit === undefined || hit === null ? "" : String(hit);
  };
  const cels: Record<string, unknown> = {};
  for (let row = 0; row < r; row++) {
    for (let col = 0; col < c; col++) {
      const addr = `${colLetter(col)}${row + 1}`;
      const spec = sniffCel(valAt(addr));
      cels[`${name}.${addr}`] = { celType: spec.celType, f: spec.f, v: spec.v, metadata: { name: addr, parser: spec.parser ?? "infix" } };
    }
  }
  return { layer: name, cels };
};

type WGeom = { x?: number; y?: number; w?: number; h?: number; minW?: number; minH?: number };
const isAt = (x: unknown): x is { __at: string; content: unknown } => !!x && typeof x === "object" && typeof (x as { __at?: unknown }).__at === "string";
const isGeom = (x: unknown): x is { __geom: WGeom } => !!x && typeof x === "object" && !!(x as { __geom?: unknown }).__geom && typeof (x as { __geom?: unknown }).__geom === "object";
const isValues = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x) && !isAt(x) && !isGeom(x);

// at(addr, content) — one cell's initial content for a cels() grid. A plain
// function call (no new parser syntax). cels collects trailing at() markers.
const at: Fn = (addr?: unknown, content?: unknown) => ({ __at: String(addr ?? ""), content: content == null ? "" : String(content) });

// geom(x, y, w, h [, minW, minH]) — a cels() grid's WINDOW geometry, CSS-style:
// x/y = left/top, w/h = the (proportional) width/height, minW/minH = min-width/
// min-height FLOORS (the window never renders or resizes below them). A value in
// (0,1] is a PROPORTION of the viewport; >1 is absolute pixels (minW/minH are
// typically pixels, like CSS min-width:340px). cels collects it (like at()) and
// the genesis writes it into win.geom[name] the FIRST time the window
// materializes (a later user drag/resize is preserved). Each arg is optional.
const geomFn: Fn = (x?: unknown, y?: unknown, w?: unknown, h?: unknown, minW?: unknown, minH?: unknown): unknown => {
  const num = (v: unknown): number | undefined => { const n = Number(v); return v != null && v !== "" && !Number.isNaN(n) ? n : undefined; };
  const g: WGeom = {};
  if (num(x) !== undefined) g.x = num(x);
  if (num(y) !== undefined) g.y = num(y);
  if (num(w) !== undefined) g.w = num(w);
  if (num(h) !== undefined) g.h = num(h);
  if (num(minW) !== undefined) g.minW = num(minW);
  if (num(minH) !== undefined) g.minH = num(minH);
  return { __geom: g };
};

// gather a values map (+ an optional geom) from an optional {object} and trailing
// at()/geom() markers.
const collectValues = (args: unknown[], i: number): [Record<string, unknown> | undefined, WGeom | undefined, number] => {
  const values: Record<string, unknown> = {};
  let geom: WGeom | undefined;
  if (isValues(args[i])) { Object.assign(values, args[i]); i++; }
  while (isAt(args[i]) || isGeom(args[i])) {
    if (isGeom(args[i])) { geom = (args[i] as { __geom: WGeom }).__geom; i++; }
    else { const a = args[i] as { __at: string; content: unknown }; values[a.__at] = a.content; i++; }
  }
  return [Object.keys(values).length ? values : undefined, geom, i];
};

/** cels — a genesis vocabulary that adds worksheets of editable cels, each
 *  like 元. Shapes from ONE formula:
 *    cels(rows, cols)              → one sheet, auto-named g<r>x<c>
 *    cels(rows, cols, "name")      → one named sheet
 *    cels("in", 4, 3, "out", 4, 3) → a WORKBOOK of named sheets
 *    cels("in", 4, 3, at("a1","apple"), at("b2","=1+1"))  → a sheet
 *      with initial cell contents (a value, or a formula like =1+1).
 *  Delete the formula → swept. */
const celsGen: Fn = (...args: unknown[]): unknown => {
  if (typeof args[0] === "string") {
    // workbook: (name, rows, cols [, at()…])+ — at() markers belong to the
    // preceding grid; the next string starts the next grid. A workbook's sheets
    // all land in the generator's own segment (one closure), so they share memory.
    const cels: Record<string, unknown> = {};
    const geoms: Record<string, WGeom> = {};
    let i = 0, n = 0;
    while (i < args.length && typeof args[i] === "string") {
      const nm = String(args[i]).trim() || `s${++n}`;
      const [values, geom, ni] = collectValues(args, i + 3);
      Object.assign(cels, gridShape(args[i + 1], args[i + 2], nm, values).cels);
      if (geom) geoms[nm] = geom;
      i = ni;
    }
    return { genesis: true, cels, ...(Object.keys(geoms).length ? { geoms } : {}) };
  }
  // numbers → one sheet: (rows, cols [, name] [, geom()] [, at()…]).
  const [rows, cols] = args;
  const named = typeof args[2] === "string" && args[2] !== "";
  const name = named ? String(args[2])
    : `g${Math.max(1, Math.min(100, Math.floor(Number(rows) || 1)))}x${Math.max(1, Math.min(50, Math.floor(Number(cols) || 1)))}`;
  const [values, geom] = collectValues(args, named ? 3 : 2);
  return { genesis: true, kind: "workbook", ...gridShape(rows, cols, name, values), ...(geom ? { geoms: { [name]: geom } } : {}) };
};

/** doc(…parts) — compose an ENTIRE document from cels()/def() parts into
 *  ONE genesis batch. This is what `seed()` emits: paste a doc(…) into 元 and
 *  the whole app re-materializes (genesis seeds at creation, preserves edits). */
// segment(part1, part2, …) — compose a document from cels()/winapp()/chatapp()/
// def() parts. Each layer-bearing part MINTS ITS OWN SEGMENT: its cels are
// stamped metadata.segment = its layer (so they don't flatten into 元), and the
// part's policy is collected into `mints` (the genesis drain synthesizes each).
const doc: Fn = (...parts: unknown[]): unknown => {
  const cels: Record<string, unknown> = {};
  const mints: Record<string, unknown> = {};
  const geoms: Record<string, WGeom> = {};
  const stamp = (partCels: Record<string, unknown>, layer: string, access: unknown): void => {
    for (const spec of Object.values(partCels)) {
      const sp = spec as { metadata?: Record<string, unknown> };
      sp.metadata = { ...(sp.metadata ?? {}), segment: layer };   // this part's cels belong to ITS segment
    }
    mints[layer] = (access && typeof access === "object") ? access : {};
  };
  for (const p of parts) {
    // a bare string arg is ignored (legacy desktop-layout argument, removed —
    // windows are content-sized + cascade now, no auto-layout pass).
    if (typeof p === "string") continue;
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (o.genesis === true && o.cels) {                                                  // cels(…)/winapp(…)/chatapp(…)
      if (typeof o.layer === "string") stamp(o.cels as Record<string, unknown>, o.layer, o.access);
      Object.assign(cels, o.cels);
    } else if (o.cels && o.layer) {                                                       // gridShape direct
      stamp(o.cels as Record<string, unknown>, String(o.layer), o.access);
      Object.assign(cels, o.cels as Record<string, unknown>);
    } else if (o.originDef === true) cels[String(o.name)] = { celType: "EditableLambdaCel", f: String(o.source ?? ""), metadata: { kind: String(o.kind ?? "js"), name: String(o.name) } };
    if (o.geoms && typeof o.geoms === "object") Object.assign(geoms, o.geoms);            // per-window geometry (cels(…, geom(x,y,w,h)))
  }
  return { genesis: true, cels, mints, ...(Object.keys(geoms).length ? { geoms } : {}) };
};

// seed() — ask the drain (which has state) to serialize the whole document to a
// single recreating formula. Callable from ANY cel; its value becomes the source.
const seedFn: Fn = () => ({ originSeed: true });
// export(seg?) — dump a document segment (or, with no arg, the WHOLE document
// stack) to a lossless 甲骨 archive json STRING. The boot substrate is never
// included. Paste the string into =import() elsewhere. Formula form = =seed()/=link().
const exportFn: Fn = (seg?: unknown, form?: unknown, pass?: unknown) => ({ originExport: true, seg: seg == null ? "" : String(seg), form: form == null ? "archive" : String(form), pass: pass == null ? "" : String(pass) });
// import(src, pass?) — load an archive json string (or an aes256gcm:… blob with
// the passphrase) into the document stack: ADD or wholesale-REPLACE same-named
// segments. Refuses a boot-set name. A =formula is the entry gesture (paste it).
const importFn: Fn = (src?: unknown, pass?: unknown) => ({ originImport: true, src: String(src ?? ""), pass: pass == null ? "" : String(pass) });

// ── the entry gesture ────────────────────────────────────────────────────────

const sniff = (src: string): { celType: string; f?: string; v?: unknown; parser?: string } => {
  const t = src.trim();
  if (t.startsWith("=")) return { celType: "FormulaCel", f: t, parser: "infix" };
  if (t.startsWith("(")) return { celType: "FormulaCel", f: t, parser: "f" };
  const n = Number(t);
  return { celType: "ValueCel", v: t !== "" && !Number.isNaN(n) ? n : src };
};

const VIEW_KEY = "元.view";
// 元's default formula (the readme) — sourced from the seed, restored when 元
// is cleared so the readme is un-deletable.
const README = String((seed as { cels: { key: string; f?: string }[] }).cels.find((c) => c.key === "元")?.f ?? "");

/** The current spreadsheet cell list: 元 (A1) plus every genesis-created
 *  DATA cel (grid cells), sorted. Rebuilt after each commit so new grids
 *  show and swept ones vanish. */
const cellKeys = (state: State): string[] => {
  const out: string[] = ["元"];
  for (const [k, c] of state.cels) {
    if (k === "元") continue;
    if (c.celType !== "ValueCel" && c.celType !== "FormulaCel") continue;
    const md = c.metadata as { generatedBy?: Key; segment?: string };
    // grid cels (genesis-owned). win.* AND wasm.* layer cels (state/content/frame)
    // are first-class desktop cells even when handler-created (no generatedBy) —
    // e.g. the wiki window, and the wasm-window canvas frame (=doom()).
    if (md.generatedBy || /^(?:win|wasm)\.[\w-]+\.(state|content|frame)$/.test(k)) out.push(k);
  }
  return [out[0]!, ...out.slice(1).sort()];
};

// 元.view's `vals` is an ARRAY inputMap of the cell keys (→ array of
// values); `keys` is the same list as a value cel. Rewire both so the
// view re-fires against the live cell set.
const rewireView = async (state: State, keys: string[]): Promise<void> => {
  const im = { ...(state.cels.get(VIEW_KEY)?.metadata.inputMap as Record<string, Key | Key[]>) };
  im.vals = keys;
  await (resolveFn(state, "setValueBatch") as Fn)(state,
    [["元.cells", keys], ["元.srcs", keys.map((k) => cellSource(state, k))]]);
  await (resolveFn(state, "setCel") as Fn)(state, VIEW_KEY, { metadata: { inputMap: im } });
};

// view.refresh — the generic hook the kernel's settleStructural calls after
// OUT-OF-BAND structure materializes (a generator fired by a value change, not
// a user commit). Origin renders a fixed cell list (元.view's vals), so a
// structural change elsewhere must rebuild that list + repaint. commit still
// rewires for the user-edit path; this closes the gap for everything else
// (#17 render half — the abandoned vaultKeys worksheet, future windows).
const viewRefreshFn: Fn = (async (state: State): Promise<void> => {
  await rewireView(state, cellKeys(state));
  const sync = resolveFn(state, "winsheet.syncBundles") as Fn | undefined;
  if (sync) await sync(state);   // seeded tabs share memory (turtlecharts ← turtles)
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
}) as Fn;

// source text of a cell (formula `f`, else stringified value)
const cellSource = (state: State, key: string): string => {
  const c = state.cels.get(key);
  const f = (c as { f?: string } | undefined)?.f;
  return f ?? (c?.v === undefined || c?.v === null ? "" : String(c.v));
};

// formatFormula — pretty-print a formula for the bar: a newline + tab for every
// nested closure, the way you'd format JavaScript. Pure whitespace (the parsers
// ignore it), string-aware (never touches inside "…" / \" escapes), and a no-op
// for short or already-multi-line sources. Infix (=f(a, b, …)) breaks on commas;
// S-expression ((f a b …)) breaks on the spaces between args.
const matchParen = (s: string, open: number): number => {
  let d = 0;
  for (let j = open; j < s.length; j++) {
    const ch = s[j];
    if (ch === '"' || ch === "'") { const q = ch; j++; while (j < s.length && s[j] !== q) { if (s[j] === "\\") j++; j++; } continue; }
    if (ch === "(") d++; else if (ch === ")" && --d === 0) return j;
  }
  return s.length;
};
const formatFormula = (src: string): string => {
  const s = String(src ?? "");
  if (s.includes("\n") || !s.includes("(") || s.length < 40) return src; // already laid out / nothing to do
  const sexpr = s.trimStart().startsWith("(");
  const stack: boolean[] = []; // was each open group broken onto its own lines?
  const ind = (): string => "\t".repeat(stack.filter(Boolean).length);
  let out = "", i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"' || c === "'") { // copy a string literal verbatim (with \ escapes)
      const q = c; out += c; i++;
      while (i < s.length) { if (s[i] === "\\") { out += s[i]! + (s[i + 1] ?? ""); i += 2; continue; } out += s[i]; if (s[i] === q) { i++; break; } i++; }
      continue;
    }
    if (c === "(") {
      const inner = s.slice(i + 1, matchParen(s, i));
      const brk = inner.includes("(") || inner.length > 48; // break groups that nest or run long
      out += "("; stack.push(brk);
      if (brk && !sexpr) out += "\n" + ind();               // infix: args each on their own line
      i++; continue;
    }
    if (c === ")") { if (stack.pop()) out += "\n" + ind(); out += ")"; i++; continue; }
    if (!sexpr && c === "," && stack[stack.length - 1]) { out += ",\n" + ind(); i++; while (s[i] === " ") i++; continue; }
    if (sexpr && c === " " && stack[stack.length - 1]) {     // s-expr: break only BEFORE a nested closure
      let j = i; while (s[j] === " ") j++;
      if (s[j] === "(") { out += "\n" + ind(); i = j; continue; }
      out += " "; i++; continue;
    }
    out += c; i++;
  }
  return out;
};

// A click that lands on a form control a formula rendered INSIDE a cell (a
// password box from =unlockVault(), a file picker from =upload(), a button)
// must reach the control — not hijack into editing the cell's formula. The
// cell-value wrapper carries the click→edit binding, so without this guard
// every click on the input bubbles up and swaps the input out for the editor
// textarea before you can type. Editing such a cell: click its padding/label,
// or the ⤢ expand affordance.
const isFormControl = (event: unknown): boolean => {
  const target = (event as { target?: { tagName?: string; closest?: (s: string) => unknown } } | undefined)?.target;
  if (!target) return false;
  const SEL = "input,textarea,select,button,label,option";
  if (/^(INPUT|TEXTAREA|SELECT|BUTTON|LABEL|OPTION)$/.test(String(target.tagName ?? "").toUpperCase())) return true;
  return typeof target.closest === "function" && !!target.closest(SEL);
};

/** edit — start INLINE editing a cell (seed the draft with its source);
 *  clicking the active cell again closes it. A click on a form control the
 *  cell's formula rendered is left alone (so password/upload inputs work) —
 *  unless `force` is set ({ key, force: true }, dispatched by the explicit
 *  pencil ✎ affordance, which IS a button but a deliberate edit gesture). */
const edit: Fn = async (state: State, payload?: unknown, event?: unknown) => {
  const force = !!payload && typeof payload === "object" && (payload as { force?: unknown }).force === true;
  if (!force && isFormControl(event)) return state;
  const key = typeof payload === "string" ? payload
    : (force ? String((payload as { key?: unknown }).key ?? "") || null : null);
  const cur = state.cels.get("元.editing")?.v;
  const next = cur === key ? null : key;
  await (resolveFn(state, "setValueBatch") as Fn)(state,
    [["元.editing", next], ["元.draft", next ? formatFormula(cellSource(state, next)) : ""], ["元.error", null]]);
  // 元.editing is in 元.view's inputMap, so changing it re-fires the view — but
  // that re-fire must propagate through the cycle BEFORE we paint, or the first
  // drain repaints the stale vnode (editor not yet swapped in) and no second
  // paint is scheduled. runCycle first so the editor (or its dismissal) lands in
  // one gesture. Without this, clicking a windowed worksheet cell looked inert.
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
};

// select — Excel single-click: mark a cell SELECTED (元.selected) WITHOUT
// swapping it to the inline editor, so the grid keeps showing the value. The
// selected cell's source is seeded into 元.draft so the formula bar (the edit
// surface) shows it; the bar's textarea binds 元.draft and commits on Enter to
// 元.selected. A click on a form control a formula rendered is left alone.
const select: Fn = async (state: State, payload?: unknown, event?: unknown) => {
  if (isFormControl(event)) return state;
  const key = typeof payload === "string" ? payload : null;
  if (!key) return state;
  await (resolveFn(state, "setValueBatch") as Fn)(state,
    [["元.selected", key], ["元.draft", formatFormula(cellSource(state, key))], ["元.error", null]]);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
};

// fire — re-evaluate (recompute) the selected cell. A FormulaCel re-applies its
// source through setValue (which recompiles + re-cascades); a ValueCel re-writes
// its own value (a harmless re-cascade that repaints dependents). The 🔫 button
// on the formula bar dispatches this.
const fire: Fn = async (state: State, payload?: unknown) => {
  // ⚡ runs what's in the formula bar against the selected cell: commit the draft
  // (sniffs the type/parser, recompiles, re-cascades) — so editing the bar then
  // hitting ⚡ runs the NEW formula. With nothing edited the draft is the cell's
  // own source (seeded on select), so ⚡ just re-evaluates it. commit's own
  // settle loop re-materializes a GENESIS (e.g. firing 元 rebuilds the desktop).
  const key = typeof payload === "string" && payload ? payload
    : String(state.cels.get("元.selected")?.v ?? "");
  if (!key) return state;
  return commit(state, key);
};

// (ex / tryexample removed: the readme is now static copyable text — type an
//  example into a cell and press ⚡ — so there are no per-row "try it" buttons.)

// window geometry a genesis declared (cels(…, geom(x,y,w,h[,minW,minH]))) → win.geom.
// `key` holds the genesis result {…, geoms}. A value in (0,1] is a PROPORTION of the
// viewport (x/w of viewport.w, y/h of viewport.h); >1 is absolute pixels. Only set a
// window with NO geom yet, so a user's later drag/resize is preserved. Shared by
// origin.run AND the navOpen "=formula" launcher (both spawn geom-bearing windows).
const applyDeclaredGeom = async (state: State, key: string): Promise<void> => {
  const declared = (state.cels.get(key)?.v as { geoms?: Record<string, WGeom> } | undefined)?.geoms;
  if (!declared || !Object.keys(declared).length) return;
  const vw = Number(state.cels.get("viewport.w")?.v) || 1200, vh = Number(state.cels.get("viewport.h")?.v) || 800;
  const px = (v: number | undefined, dim: number): number | undefined => v == null ? undefined : (v > 0 && v <= 1 ? Math.round(v * dim) : v);
  const cur = { ...((state.cels.get("win.geom")?.v as Record<string, WGeom>) ?? {}) };
  let touched = false;
  for (const [seg, g] of Object.entries(declared)) {
    if (cur[seg]) continue;
    const r: WGeom = {};
    if (g.x != null) r.x = px(g.x, vw); if (g.y != null) r.y = px(g.y, vh);
    if (g.w != null) r.w = px(g.w, vw); if (g.h != null) r.h = px(g.h, vh);
    if (g.minW != null) r.minW = px(g.minW, vw); if (g.minH != null) r.minH = px(g.minH, vh);
    cur[seg] = r; touched = true;
  }
  if (touched) await (resolveFn(state, "setValue") as Fn)(state, "win.geom", cur);
};

/** commit (origin.run) — run a cell: set its content from the draft and
 *  re-evaluate. Every cell (元 included) executes its formula/value like A1. 元
 *  is un-deletable: clearing it restores the readme. A structure formula
 *  (=grid …) makes more cels; the post-drain rebuild adds them.
 *  Optional `source`: seed 元.draft with it first, so a caller can run a given
 *  formula into `key` in one call (subsumes the setValue(元.draft)+run pattern). */
const commit: Fn = async (state: State, payload?: unknown, source?: unknown) => {
  const key = typeof payload === "string" ? payload : "元";
  if (source !== undefined) await (resolveFn(state, "setValue") as Fn)(state, "元.draft", String(source));
  const draft = String(state.cels.get("元.draft")?.v ?? "").trim();
  const setCel = resolveFn(state, "setCel") as Fn;

  const src = key === "元" && draft === "" ? README : draft;
  const spec = src === "" ? { celType: "ValueCel", v: "" } : sniff(src);
  // Carry forward ownership/name stamps so editing a GRID cell keeps it
  // owned by its generator (else the sweep can't reclaim it, and the
  // grid never goes away). A1's own segment/name pass through too.
  const prior = state.cels.get(key)?.metadata as
    { segment?: string; name?: string; generatedBy?: Key; definedBy?: Key; origin?: Key } | undefined;
  const md: Record<string, unknown> = { segment: prior?.segment ?? "origin" };
  if (prior?.name) md.name = prior.name;
  if (prior?.generatedBy) md.generatedBy = prior.generatedBy;
  if (prior?.definedBy) md.definedBy = prior.definedBy;
  if (prior?.origin) md.origin = prior.origin;
  if (spec.parser) md.parser = spec.parser;
  try {
    await setCel(state, key, { celType: spec.celType, f: spec.f, v: spec.v, metadata: md });
  } catch (e) {
    // A parse/compile error (e.g. `=sheets("in" 4 3)` — infix wants commas)
    // throws OUT of setCel, which would abort the commit before any paint —
    // so the cell looked like it did nothing. Surface the message under the
    // editor and stay in the cell so it can be fixed.
    const msg = String((e as { message?: unknown })?.message ?? e).replace(/^setCel:\s*"[^"]*"\s*—\s*/, "");
    // keep the bad draft and force the cell into edit mode so the error
    // line is visible (it renders under the active editor).
    await (resolveFn(state, "setValueBatch") as Fn)(state, [["元.error", msg], ["元.editing", key]]);
    await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
    return state;
  }

  // keep the selection on the committed cell and refresh the bar's draft to its
  // (now re-evaluated) source; clear inline editing.
  await (resolveFn(state, "setValueBatch") as Fn)(state, [["元.editing", null], ["元.error", null], ["元.selected", key], ["元.draft", src]]);
  // fire generators so they enqueue, then commit structure + sweep. Loop until
  // quiescent: a genesis effect can in turn materialize cels whose own formulas
  // are requests (e.g. a seeded grid cell holding =db(…)) — keep draining until
  // a pass adds nothing new (capped, so a runaway can't spin forever).
  const drain = resolveFn(state, "drain") as Fn;
  const gd = resolveFn(state, "genesis.drain") as Fn | undefined;
  const dd = resolveFn(state, "defn.drain") as Fn | undefined;
  for (let pass = 0; pass < 8; pass++) {
    const before = state.cels.size;
    await (resolveFn(state, "runCycle") as Fn)(state);
    for (const ch of ["genesis.commit", "defn.commit", "checkpoint.commit", "origin.effects"]) {
      if (state.cels.get(ch)) await drain(state, ch);
    }
    if (gd) await gd([], state);
    if (dd) await dd([], state);
    if (state.cels.size === before) break; // no new cels this pass → settled
  }
  await applyDeclaredGeom(state, key as string);
  // …rebuild the cell list (new grids in, swept cels out), re-fire, paint.
  await rewireView(state, cellKeys(state));
  // a SEEDED tab (win.geom[seg].host) must grant shared memory like a runtime
  // drop — bundle each host clique so a tabbed private sheet reads its host
  // (turtlecharts reads turtles!). Idempotent; safe to call every commit.
  const sync = resolveFn(state, "winsheet.syncBundles") as Fn | undefined;
  if (sync) await sync(state);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await drain(state, "dom.paint");
  // keep the consent panel's usage list fresh while it's open (cheap-guarded so a
  // normal commit doesn't walk every cel unless the panel exists).
  if (state.cels.get("win.consent.state")) { await consentSync(state); await drain(state, "dom.paint"); }
  return state;
};

// Editor keys: Enter commits; Shift+Enter inserts a newline (default); Tab /
// Shift+Tab indent / outdent at the cursor (a tab char) instead of moving
// focus. Multi-line + tabs make hand-written formulas readable (the parser
// ignores whitespace).
const key: Fn = async (state: State, payload: unknown, event: unknown) => {
  const e = event as {
    key?: string; shiftKey?: boolean; preventDefault?: () => void;
    target?: { value: string; selectionStart: number; selectionEnd: number };
  } | undefined;
  if (!e) return state;
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault?.(); await commit(state, payload); return state; }
  if (e.key === "Tab") {
    e.preventDefault?.(); // don't move focus — indent in place
    const ta = e.target;
    if (ta && typeof ta.selectionStart === "number" && typeof ta.value === "string") {
      const s = ta.selectionStart, en = ta.selectionEnd, val = ta.value;
      let next = val, caret = s;
      if (e.shiftKey) { // outdent: drop a leading tab on the cursor's line
        const ls = val.lastIndexOf("\n", s - 1) + 1;
        if (val[ls] === "\t") { next = val.slice(0, ls) + val.slice(ls + 1); caret = Math.max(ls, s - 1); }
      } else { next = val.slice(0, s) + "\t" + val.slice(en); caret = s + 1; }
      ta.value = next; ta.selectionStart = ta.selectionEnd = caret;
      await (resolveFn(state, "setValue") as Fn)(state, "元.draft", next);
    }
  }
  // Shift+Enter falls through → the textarea inserts a newline itself.
  return state;
};

// ── persistence — save the sheet as a FILE in OPFS (no localStorage) ─────────
// A "sheet archive" is just the cell SOURCES (元.cells) + any def'd functions.
// Replaying them reconstructs the sheet (grids regenerate, values + formulas
// come back). =save()/=open() round-trip it through /plastron/sheets/<name>.json
// so saved sheets are real, discoverable files; =link() is the no-filesystem path.

const collectArchive = (state: State): { v: number; cells: [string, string][]; defs: [string, string, string][] } => {
  const keys = (state.cels.get("元.cells")?.v as string[] | undefined) ?? ["元"];
  const cells: [string, string][] = [];
  for (const k of keys) { const s = cellSource(state, k); if (s !== "" && s !== README) cells.push([k, s]); }
  const defs: [string, string, string][] = [];
  for (const [k, c] of state.cels) {
    if (c.celType === "EditableLambdaCel" && c.metadata.segment === "origin") {
      const f = (c as { f?: string }).f;
      if (f) defs.push([k, String((c.metadata as { kind?: unknown }).kind ?? "js"), f]);
    }
  }
  return { v: 1, cells, defs };
};

// serialize the whole document to a single recreating formula source. Grids →
// cels("seg", r, c, at(addr, src)…); defs → def(…). One grid alone stays a
// bare cels(…); anything composite wraps in segment(…).
// Quote a string for re-serialized formula source (=seed/=link/save). Prefer the
// delimiter that needs NO escaping: if the content has " but not ', wrap in ' (so
// a nested formula like =dom("h1","x") dehydrates clean). Else default to ".
const qstr = (s: string): string =>
  (s.includes('"') && !s.includes("'"))
    ? "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'"
    : '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const gridDims = (addrs: string[]): { r: number; c: number } => {
  let r = 1, c = 1;
  for (const a of addrs) {
    const m = /^([A-Za-z]+)(\d+)$/.exec(a);
    if (!m) continue;
    let col = 0; for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
    r = Math.max(r, parseInt(m[2]!, 10)); c = Math.max(c, col);
  }
  return { r, c };
};
const buildSeed = (state: State): string => {
  const arch = collectArchive(state);
  const grids = new Map<string, [string, string][]>();
  for (const [key, src] of arch.cells) {
    if (key === "元" || /^=?\s*seed\s*\(/.test(src)) continue;   // skip 元 + any =seed() cell (no self-capture)
    const dot = key.indexOf(".");
    if (dot < 0) continue;   // grid cels only (seg.addr); no base cels anymore
    const seg = key.slice(0, dot), addr = key.slice(dot + 1);
    (grids.get(seg) ?? grids.set(seg, []).get(seg)!).push([addr, src]);
  }
  const parts: string[] = [];
  for (const [seg, cells] of grids) {
    const { r, c } = gridDims(cells.map(([a]) => a));
    const ats = cells.filter(([, s]) => s !== "").map(([a, s]) => `at(${qstr(a)}, ${qstr(s)})`);
    parts.push(`cels(${qstr(seg)}, ${r}, ${c}${ats.length ? ", " + ats.join(", ") : ""})`);
  }
  for (const [name, kind, f] of arch.defs) parts.push(`def(${qstr(name)}, ${qstr(kind)}, ${qstr(f)})`);
  if (parts.length === 0) return "=cels(1, 1)";
  if (parts.length === 1 && parts[0]!.startsWith("cels(")) return "=" + parts[0];
  return "=segment(" + parts.join(", ") + ")";
};

// segmentFormula(seg) — the minting FORMULA for ONE segment (the per-segment twin
// of buildSeed). A workbook → =cels(seg, r, c, at(…)); a def → =def(…). Returns ""
// for a segment with no formula form (e.g. a winapp window — use its archive).
const segmentFormula = (state: State, seg: string): string => {
  const arch = collectArchive(state);
  const cells = arch.cells
    .filter(([k]) => k.startsWith(seg + ".") && !/^=?\s*seed\s*\(/.test(k))
    .map(([k, s]) => [k.slice(seg.length + 1), s] as [string, string]);
  if (cells.length) {
    const { r, c } = gridDims(cells.map(([a]) => a));
    const ats = cells.filter(([, s]) => s !== "").map(([a, s]) => `at(${qstr(a)}, ${qstr(s)})`);
    return `=cels(${qstr(seg)}, ${r}, ${c}${ats.length ? ", " + ats.join(", ") : ""})`;
  }
  const def = arch.defs.find(([name]) => name === seg);
  if (def) return `=def(${qstr(def[0])}, ${qstr(def[1])}, ${qstr(def[2])})`;
  return "";
};

const restoreArchive = async (state: State, arch: { cells?: [string, string][]; defs?: [string, string, string][] }): Promise<void> => {
  const setCel = resolveFn(state, "setCel") as Fn;
  for (const [k, kind, f] of (arch.defs ?? [])) {
    await setCel(state, k, { celType: "EditableLambdaCel", f, metadata: { kind, segment: "origin", name: k } });
  }
  const setValue = resolveFn(state, "setValue") as Fn;
  for (const [k, src] of (arch.cells ?? [])) { await setValue(state, "元.draft", src); await commit(state, k); }
};

const saveFn: Fn = (name?: unknown) => ({ originSave: true, name: name == null ? "" : String(name) });
const openFn: Fn = (name?: unknown) => ({ originOpen: true, name: name == null ? "" : String(name) });
// vaultsave(pass)/vaultload(pass) — persist the `secrets` segment as a standalone
// ENCRYPTED file /vault.env.enc in OPFS (discoverable in 📁 Files, opaque without
// the passphrase). Independent of =save — your keys survive without saving the
// sheet, and the vault is a portable file.
const vaultSaveFn: Fn = (pass?: unknown) => ({ originVaultSave: true, pass: pass == null ? "" : String(pass) });
const vaultLoadFn: Fn = (pass?: unknown) => ({ originVaultLoad: true, pass: pass == null ? "" : String(pass) });
// link(target?, base?, codec?) — a shareable URL that rebuilds a plastron from the
// page address. target "" → the whole sheet (buildSeed); a cell key → its source.
const linkFn: Fn = (target?: unknown, base?: unknown, codec?: unknown) =>
  ({ originLink: true, target: target == null ? "" : String(target),
     base: base == null ? "https://plastron.ca/" : String(base),
     codec: codec == null ? "auto" : String(codec) });
const unlinkFn: Fn = (url?: unknown) => ({ originUnlink: true, url: String(url ?? "") });
// encrypt(passphrase?, target?, base?) — like link, but AES-256-GCM the source
// behind a passphrase (the URL parameter names the method: #aes256gcm=). Omit the
// passphrase to be PROMPTED at drain time, so it never lives in the sheet/seed.
// decrypt(url, passphrase?) — the inverse: returns the formula source as text
// (does NOT run it). A wrong passphrase yields an error string.
const encryptFn: Fn = (passphrase?: unknown, target?: unknown, base?: unknown) =>
  ({ originEncrypt: true,
     passphrase: passphrase == null ? "" : String(passphrase),
     target: target == null ? "" : String(target),
     base: base == null ? "https://plastron.ca/" : String(base) });
const decryptFn: Fn = (url?: unknown, passphrase?: unknown) =>
  ({ originDecrypt: true, url: String(url ?? ""), passphrase: passphrase == null ? "" : String(passphrase) });
// A passphrase from the formula arg, else PROMPTED (browser/Bun) so secrets stay
// out of the saved sheet. Empty (cancel / headless) → "" → handler refuses.
const passOf = (given: unknown, why = "passphrase"): string => {
  const g = String(given ?? "");
  if (g) return g;
  const p = (globalThis as { prompt?: (m: string) => string | null }).prompt;
  return p ? String(p(why) ?? "") : "";
};

// ── one-time pad verbs (UNCONDITIONAL secrecy) ──────────────────────────────
// The OTP "key" is a PAD FILE of random bytes — too big to type — so these verbs
// render a FILE PICKER (gesture-correct, like =upload) rather than a passphrase
// prompt. The chosen pad is XOR'd with the formula; the URL carries only the
// ciphertext + the pad's NAME (padId), so the peer knows which pad file to load.
// One pad file = one message; delete it from BOTH stacks after use.

// read the picked file's bytes off a change event (browser only).
const fileBytes = async (event: unknown): Promise<{ name: string; bytes: Uint8Array } | null> => {
  const f = (event as { target?: { files?: ArrayLike<{ name: string; arrayBuffer(): Promise<ArrayBuffer> }> } })?.target?.files?.[0];
  return f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null;
};

// =otpEncrypt(target?) — pick a pad file → an #otp= URL (unconditionally secret).
const otpEncryptFn: Fn = (target?: unknown): V =>
  el("div", { class: "otp-tool" }, [
    T("🔐 one-time-pad encrypt — choose a pad file: ") as V,
    el("input", { class: "otp-pad", type: "file", title: "your next unused pad file" },
      [], { change: { dispatch: "origin.otpEncrypt", payload: String(target ?? "") } }),
  ]);
// =otpDecrypt(url) — pick the matching pad file → the formula source (does not run it).
const otpDecryptFn: Fn = (url?: unknown): V => {
  const { padId } = parseOtpUrl(String(url ?? ""));
  return el("div", { class: "otp-tool" }, [
    T(`🔓 one-time-pad decrypt — choose pad ${padId || "file"}: `) as V,
    el("input", { class: "otp-pad", type: "file", title: `the pad named "${padId}"` },
      [], { change: { dispatch: "origin.otpDecrypt", payload: String(url ?? "") } }),
  ]);
};
// otpLoader(padId, payload, err?) — the BOOT view a #otp= URL renders as 元: load
// the named pad to decrypt the shared plastron (kernel already LOCKED). On a wrong
// pad the unlock handler re-renders this with `err` set, so failure is NEVER
// silent. The dispatch carries padId|ciphertext so the handler can re-render the
// loader (with the error) without losing what it needs to retry.
const otpLoaderFn: Fn = (padId?: unknown, payload?: unknown, err?: unknown): V => {
  const e = String(err ?? "");
  const kids: V[] = [
    el("h2", {}, [T("🔑 one-time-pad encrypted plastron") as V]),
    el("p", {}, [T(`Load pad “${String(padId ?? "")}” from your vault to decrypt:`) as V]),
    el("input", { class: "otp-pad", type: "file", title: "select your matching pad file" },
      [], { change: { dispatch: "origin.otpUnlock", payload: `${String(padId ?? "")}|${String(payload ?? "")}` } }),
  ];
  if (e) kids.push(el("p", { class: "otp-err", style: "color:#c0392b;margin-top:.5rem;font-weight:600" }, [T(e) as V]));
  return el("div", { class: "otp-loader" }, kids);
};

// handlers (state, payload, event) — read the pad off the file event, do the
// info-theoretic crypto, surface the result. The pad bytes never leave the page.
const otpEncryptHandler: Fn = async (state: State, target: unknown, event: unknown) => {
  const picked = await fileBytes(event);
  if (!picked) return state;
  try {
    const t = String(target ?? "");
    const src = t ? cellSource(state, t) : buildSeed(state);
    const { url } = await encodeOtpLink(src, picked.bytes, picked.name);
    await (resolveFn(state, "setValueBatch") as Fn)(state, [
      ["元.draft", url],
      ["元.error", `🔐 OTP link is in the formula bar. Pad "${picked.name}" is now spent — DELETE it from BOTH stacks (one pad, one message).`],
    ]);
  } catch (e) {
    await (resolveFn(state, "setValue") as Fn)(state, "元.error", `#${String((e as { message?: unknown })?.message ?? e)}`);
  }
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
};
const otpDecryptHandler: Fn = async (state: State, url: unknown, event: unknown) => {
  const picked = await fileBytes(event);
  if (!picked) return state;
  const { payload } = parseOtpUrl(String(url ?? ""));
  try {
    const formula = await otpDecryptPayload(payload, picked.bytes);
    await (resolveFn(state, "setValueBatch") as Fn)(state, [
      ["元.draft", formula],
      ["元.error", "🔓 Decrypted — the source is in the formula bar. Paste it into a cell to run it."],
    ]);
  } catch (e) {
    await (resolveFn(state, "setValue") as Fn)(state, "元.error", `#${String((e as { message?: unknown })?.message ?? e)}`);
  }
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
};
// boot unlock: load the pad → decrypt → the shared formula BECOMES 元 (still
// jailed — bootFromHash locked the kernel before rendering this loader).
const otpUnlockHandler: Fn = async (state: State, payload: unknown, event: unknown) => {
  const picked = await fileBytes(event);
  if (!picked) return state;
  const s = String(payload ?? "");
  const bar = s.indexOf("|");                          // padId|ciphertext
  const padId = bar < 0 ? "" : s.slice(0, bar);
  const ct = bar < 0 ? s : s.slice(bar + 1);
  const setValue = resolveFn(state, "setValue") as Fn;
  try {
    const formula = await otpDecryptPayload(ct, picked.bytes);
    await setValue(state, "元.draft", formula);
    await commit(state, "元");                          // the decrypted formula BECOMES (and runs as) 元
  } catch (e) {
    // NEVER fail silently: re-render the loader WITH the error (and which file
    // was tried), so a wrong/old pad is obvious and the user can retry.
    const msg = `🔒 ${String((e as { message?: unknown })?.message ?? e)} — you loaded "${picked.name}" (${picked.bytes.length} bytes)`;
    await setValue(state, "元.draft", `=otpLoader(${JSON.stringify(padId)}, ${JSON.stringify(ct)}, ${JSON.stringify(msg)})`);
    await commit(state, "元");
  }
  return state;
};
// kernel(seed, preset?) — spawn a child plastron from a seed formula in a fresh
// segment. Under the consent model a spawned child runs under the SESSION's
// consent (dangerous verbs gated when the session is locked); the preset arg is
// kept for compatibility but no longer maps to a per-segment capability grant.
const kernelFn: Fn = (seed?: unknown, preset?: unknown) =>
  ({ originKernel: true, seed: String(seed ?? ""), preset: preset == null ? "locked" : String(preset) });
// Spawn a child: fresh `appN` segment, seed formula in <seg>.元. Returns the segment.
const spawnQuarantined = async (state: State, seed: string, _preset: string): Promise<string> => {
  let n = 1; while (state.cels.has(`app${n}.元`)) n++;
  const seg = `app${n}`;
  await (resolveFn(state, "setCel") as Fn)(state, `${seg}.元`,
    { celType: "FormulaCel", f: seed, metadata: { key: `${seg}.元`, segment: seg, parser: "infix" } });
  return seg;
};
// origin.bootFromHash — read a #f= / #raw= URL fragment. When present, the
// WHOLE instance is untrusted: LOCK THE KERNEL TIER and make the shared formula
// BE 元 (the main view), so a stranger's plastron renders jailed — no net /
// storage / code / secrets until the user grants them via the 🛡 badge. Returns
// the shared formula (truthy → the host skips the normal desktop boot), or null.
export const bootFromHash = async (state: State, hash: string): Promise<string | null> => {
  const h = String(hash || "");
  let formula: string | null = null;
  // ── self-service tools for LLMs/agents: render a PLAIN-TEXT answer, don't run
  // the formula as an app. #check=<urlenc formula> → is it valid?  #encode=<…> →
  // its compressed #f= share link (so a model that can't deflate can still get a
  // real link by handing the user this URL). Both boot locked + inert (just text).
  const checkM = /[#?&]check=([^#?&]+)/.exec(h);
  const encodeM = /[#?&]encode=([^#?&]+)/.exec(h);
  if (checkM) {
    const f = decodeURIComponent(checkM[1]!);
    let verdict: string;
    try {
      await (resolveFn(state, "setValue") as Fn)(state, "元.draft", f);
      await (resolveFn(state, "origin.run") as Fn)(state, "元");
      const err = String(state.cels.get("元.error")?.v ?? "").trim();
      const v = state.cels.get("元")?.v;
      if (err && err !== "null") verdict = "❌ INVALID\n\n" + err.replace(/^#/, "");
      else if (v === undefined || v === null || v === "") verdict = "⚠️ parsed, but produced an empty value";
      else verdict = "✅ VALID — parsed + evaluated";
    } catch (e) { verdict = "❌ INVALID\n\n" + String((e as { message?: unknown })?.message ?? e); }
    formula = `=dom("pre", ${JSON.stringify(verdict + "\n\nformula:\n" + f)})`;
  } else if (encodeM) {
    const f = decodeURIComponent(encodeM[1]!);
    let out: string;
    try { out = await encodeLink(f); } catch (e) { out = "encode failed: " + String((e as { message?: unknown })?.message ?? e); }
    formula = `=dom("pre", ${JSON.stringify("compressed share link for your formula:\n\n" + out + "\n\n(open it to run the formula; it boots locked)")})`;
  } else if (new RegExp(`[#?&]${ENC_METHOD}=`).test(h)) {
    // encrypted link: prompt for the passphrase, decrypt, then boot it LOCKED
    // like any shared formula. A wrong passphrase still boots (jailed) with a
    // legible error rather than a blank page.
    const pass = passOf("", `This plastron is encrypted (AES-256-GCM). Passphrase:`);
    try { formula = await decodeEncLink(h, pass); }
    catch (e) { formula = `=dom("pre", ${JSON.stringify("🔒 " + String((e as { message?: unknown })?.message ?? e))})`; }
  } else if (new RegExp(`[#?&]${OTP_METHOD}=`).test(h)) {
    // one-time-pad link: the key is a pad FILE (can't be prompted as text), so
    // render a loader that file-picks the pad and decrypts on a click gesture.
    const { padId, payload } = parseOtpUrl(h);
    formula = `=otpLoader(${JSON.stringify(padId)}, ${JSON.stringify(payload)})`;
  } else if (/[#?&]f=/.test(h)) formula = await decodeLink(h);
  else { const m = /[#?&]raw=([^#?&]+)/.exec(h); if (m) formula = decodeURIComponent(m[1]!); }
  if (!formula) return null;
  lockConsent(state);                                                   // provenance = url → CONSENT-lock (dangerous fns need Allow)
  await (resolveFn(state, "setValue") as Fn)(state, "元.draft", formula);
  await (resolveFn(state, "origin.run") as Fn)(state, "元");         // the shared formula IS the view, jailed
  return formula;
};
// jail(seed) renders a SANDBOXED iframe running seed as its own kernel (the
// browser's real Layer-A jail — the boundary for untrusted code).
const jailFn: Fn = (seed?: unknown) => ({ originJail: true, seed: String(seed ?? "") });

// jailask(payload) — JAIL side: round-trip a request to the PARENT over the
// postMessage bridge (origin-main installs globalThis.__plastronJailAsk in a jail
// iframe). Returns the parent's reply. Outside a jail it's a no-op string.
const jailAskFn: Fn = (async (payload: unknown): Promise<unknown> => {
  const ask = (globalThis as { __plastronJailAsk?: (p: unknown) => Promise<unknown> }).__plastronJailAsk;
  if (!ask) return "(jailask: not running inside a jail)";
  try { return await ask(payload); } catch (e) { return "⚠ " + String((e as { message?: unknown })?.message ?? e); }
}) as Fn;

// jail.serve(state, payload) — PARENT side: mediates a jail's ask. The ONLY thing
// it does is run an LLM call on the jail's behalf, with the parent's key (read from
// the vault — never crossed into the jail) and a system prompt = jail framing +
// llms.txt. The reply (the bot's text + `set A1 = …` cell commands) crosses back in;
// the jail applies them in its OWN sandboxed kernel.
const JAIL_FRAMING =
  "You are an LLM living INSIDE a plastron jail() — a sandboxed iframe that is its " +
  "OWN spreadsheet kernel. You cannot reach the parent page, its keys, its files, or " +
  "the network directly, so experiment freely and BE IMPRESSIVE. You talk to the human " +
  "through a 50×50 cel grid: write values or =formulas into cells and they render LIVE " +
  "in place (a cell holding =dom(…)/=canvas(…)/=barchart(…)/=sqlitedemo() becomes real " +
  "UI). To write a cell, put a line `set <ADDR> = <value-or-=formula>` (ADDR like B2 or " +
  "A1:C3); a body starting with ( or = is a formula. Reply in prose AND emit set-lines " +
  "for anything you want to build. The current grid is given below.";
let _llmsGuide: string | null = null;
const fetchGuide = async (): Promise<string> => {
  if (_llmsGuide !== null) return _llmsGuide;
  try {
    const href = (globalThis as { location?: { href?: string } }).location?.href ?? "";
    const url = href.split("#")[0]!.replace(/[^/]*$/, "") + "llms.txt";
    const res = await fetch(url);
    _llmsGuide = res.ok ? await res.text() : "";
  } catch { _llmsGuide = ""; }
  return _llmsGuide;
};
const jailServeFn: Fn = (async (state: State, payload: unknown): Promise<unknown> => {
  (globalThis as { __lastJailServe?: unknown }).__lastJailServe = payload;   // observability for tests
  const p = (payload && typeof payload === "object") ? payload as Record<string, unknown> : { message: String(payload ?? "") };
  const provider = String(p.provider ?? "grok");
  const message = String(p.grid ?? p.message ?? "");
  if (!message) return "(nothing to send)";
  const key = await (resolveFn(state, "apiKey") as Fn)(provider);            // parent vault, consent-gated
  const client = (resolveFn(state, "makeclient") as Fn)(provider, key, p.model);
  const guide = await fetchGuide();
  const system = JAIL_FRAMING + (guide ? "\n\n=== plastron vocabulary (llms.txt) ===\n" + guide : "") + (p.system ? "\n\n=== extra system ===\n" + String(p.system) : "");
  return String(await (resolveFn(state, "client.send") as Fn)(client, message, system));
}) as Fn;
// (winsize removed: a sheet declares its window geometry with cels(…, geom(x,y,w,h))
//  now — see geomFn — instead of side-effecting win.geom from a formula in a cell.
//  Maximize lives on the ⛶ titlebar button (winsheet.maximize).)
// origin.savepage — drop the running plastron out as a single self-contained
// 龜甲.html (the pristine served bundle; falls back to the live DOM). Wired to
// the ⬇ 龜甲 button in the desktop's upper-right.
const download: Fn = async (state: State): Promise<State> => {
  type A = { href: string; download: string; click: () => void; remove: () => void };
  const g = globalThis as { document?: { createElement?: (t: string) => A; body?: { appendChild: (n: A) => void }; documentElement?: { outerHTML?: string; appendChild?: (n: A) => void } }; fetch?: (u: string) => Promise<{ text: () => Promise<string> }>; location?: { href?: string }; URL?: { createObjectURL: (b: unknown) => string; revokeObjectURL: (u: string) => void }; Blob?: new (p: unknown[], o: unknown) => unknown };
  const doc = g.document;
  if (!doc?.createElement || !g.Blob || !g.URL) return state;
  let html = "";
  try { html = await (await g.fetch!((g.location?.href ?? "").split("#")[0]!)).text(); }
  catch { html = "<!doctype html>" + (doc.documentElement?.outerHTML ?? ""); }
  const url = g.URL.createObjectURL(new g.Blob([html], { type: "text/html" }));
  const a = doc.createElement("a"); a.href = url; a.download = "龜甲.html";
  // the anchor must be IN the document for the click to start a download in
  // some browsers — append, click, remove.
  (doc.body ?? doc.documentElement)?.appendChild?.(a);
  a.click();
  a.remove();
  g.URL.revokeObjectURL(url);
  return state;
};
// origin.tone — play ONE oscillator note (payload = frequency in Hz); ensures
// the Web Audio `sound` segment on first use. origin.music plays a short melody.
const tone: Fn = async (state: State, payload?: unknown): Promise<State> => {
  await ensureSegments(state, ["sound"]);
  await (resolveFn(state, "sound.play-tone") as Fn)(state, { freq: Number(payload) || 440, duration: 320, type: "triangle" });
  return state;
};
const music: Fn = async (state: State): Promise<State> => {
  await ensureSegments(state, ["sound"]);
  const play = resolveFn(state, "sound.play-tone") as Fn;
  const g = globalThis as { setTimeout?: (f: () => void, ms: number) => void };
  // "Ode to Joy" opening (freq, start-ms)
  const NOTES: [number, number][] = [[330,0],[330,300],[349,600],[392,900],[392,1200],[349,1500],[330,1800],[294,2100],[262,2400],[262,2700],[294,3000],[330,3300],[330,3600],[294,3900],[294,4200]];
  for (const [freq, at] of NOTES) g.setTimeout?.(() => play(state, { freq, duration: 280, type: "triangle", gain: 0.35 }), at);
  return state;
};
// origin.compose / origin.composeStop — "Symphony of Cels": an ORIGINAL
// generative minimalist piece. A steady pulse + pentatonic voices firing at
// INCOMMENSURATE periods (3/4/5/7 steps) so they phase against each other (LCM
// 420 steps ≈ a minute before they realign); the scale degree drifts every 32
// steps so the harmony evolves. Browser-audio is autoplay-gated → start on click.
let _composing = false;
// add/remove the `on` class on every .pl-viz so the visualizer dots only
// animate WHILE the piece is playing (CSS keys the animation on .pl-viz.on).
const setViz = (on: boolean): void => {
  const d = (globalThis as { document?: { querySelectorAll?: (s: string) => ArrayLike<{ classList: { add: (c: string) => void; remove: (c: string) => void } }> } }).document;
  const nodes = d?.querySelectorAll?.(".pl-viz");
  if (nodes) for (let i = 0; i < nodes.length; i++) nodes[i]!.classList[on ? "add" : "remove"]("on");
};
const compose: Fn = async (state: State): Promise<State> => {
  await ensureSegments(state, ["sound"]);
  setViz(true);
  if (_composing) return state;
  _composing = true;
  const play = resolveFn(state, "sound.play-tone") as Fn;
  const g = globalThis as { setTimeout?: (f: () => void, ms: number) => void };
  // The SCORE lives in a spreadsheet you can see + edit: a "score" grid where
  // each row is a voice — B=period(beats), C=note(Hz), D=gain. Read LIVE each
  // beat, so editing a cell changes the music. Falls back to a default phase
  // pattern when there is no score sheet (e.g. the full-screen visualizer).
  const DEFAULT: [number, number, number][] = [[8, 98, 0.22], [3, 196, 0.30], [4, 294, 0.26], [5, 392, 0.24], [7, 523, 0.20]];
  const score = (): [number, number, number][] => {
    const rows: [number, number, number][] = [];
    for (let r = 2; r <= 9; r++) {
      const p = Number(state.cels.get(`score.B${r}`)?.v);
      const n = Number(state.cels.get(`score.C${r}`)?.v);
      const gv = state.cels.get(`score.D${r}`)?.v;
      if (Number.isFinite(p) && p > 0 && Number.isFinite(n) && n > 0) rows.push([p, n, Number.isFinite(Number(gv)) ? Number(gv) : 0.25]);
    }
    return rows.length ? rows : DEFAULT;
  };
  let beat = 0;
  const tick = (): void => {
    if (!_composing) return;
    for (const [period, freq, gain] of score()) {
      if (beat % period === 0) play(state, { freq, duration: freq < 130 ? 460 : 300, type: freq < 130 ? "sine" : "triangle", gain });
    }
    beat++;
    g.setTimeout?.(tick, 165);
  };
  tick();
  return state;
};
const composeStop: Fn = async (state: State): Promise<State> => { _composing = false; setViz(false); return state; };
// origin.playmelody(seg) — read column A of a sheet as a RANGE of note
// frequencies (Hz) and play them in sequence. Empty cells stop the line; you
// write a tune by typing numbers down a column.
const playmelody: Fn = async (state: State, payload?: unknown): Promise<State> => {
  await ensureSegments(state, ["sound"]);
  const seg = String(payload ?? "melody");
  const play = resolveFn(state, "sound.play-tone") as Fn;
  const g = globalThis as { setTimeout?: (f: () => void, ms: number) => void };
  const notes: number[] = [];
  for (let r = 1; r <= 64; r++) { const v = Number(state.cels.get(`${seg}.A${r}`)?.v); if (Number.isFinite(v) && v > 0) notes.push(v); }
  notes.forEach((freq, i) => g.setTimeout?.(() => play(state, { freq, duration: 260, type: "triangle", gain: 0.32 }), i * 260));
  return state;
};
// ── consent panel — the UI for the consent model (will replace the 🛡 trust
// panel). Lists the dangerous fns the live graph references, each toggleable.
// origin.consentSync recomputes the usage cel the panel renders from.
const consentSync: Fn = (async (state: State): Promise<State> => {
  const usage = dangerousUsage(state);
  if (state.cels.has("consent.usage")) await (resolveFn(state, "setValue") as Fn)(state, "consent.usage", usage);
  else await (resolveFn(state, "setCel") as Fn)(state, "consent.usage", { celType: "ValueCel", v: usage, metadata: { key: "consent.usage", segment: "origin", name: "usage" } });
  return state;
}) as Fn;
const CAT_ICON: Record<string, string> = { net: "🌐", fs: "📁", storage: "💾", db: "🗄", code: "⚙", secrets: "🔑", control: "🛂" };
/** consentdom(usage) — render the consent list from the consent.usage value. */
const consentdomFn: Fn = ((usage: unknown): V => {
  const rows = (Array.isArray(usage) ? usage : []) as Array<{ fn: string; category: string; reason: string; consented: boolean; callCount: number; segments: string[] }>;
  if (!rows.length) return el("div", { style: "font:13px system-ui;padding:.6rem;opacity:.75" }, [T("No dangerous functions in use — everything here is safe (dom / cels / math / charts).")]);
  const row = (u: typeof rows[number]): V => el("div", { style: "display:flex;gap:.5rem;align-items:flex-start;padding:.5rem .35rem;border-bottom:1px solid #8882" }, [
    el("div", { style: "font-size:1.1rem;width:1.5rem;text-align:center;flex:0 0 auto" }, [T(CAT_ICON[u.category] ?? "⚠")]),
    el("div", { style: "flex:1 1 auto;min-width:0" }, [
      el("div", { style: "font:600 .85rem ui-monospace,monospace" }, [T(`${u.fn}  `), el("span", { style: `color:${u.consented ? "#1a9c4e" : "#b1442f"}` }, [T(u.consented ? "ALLOWED" : "blocked")])]),
      el("div", { style: "font:12px/1.4 system-ui;opacity:.8;margin-top:.1rem" }, [T(`${u.reason} · used ${u.callCount}× · ${u.segments.join(", ") || "—"}`)]),
    ]),
    el("button", { class: "consent-toggle", "data-fn": u.fn, style: `flex:0 0 auto;align-self:center;padding:.3rem .6rem;border:1px solid ${u.consented ? "#b1442f88" : "#1a9c4e88"};border-radius:.4rem;background:Canvas;color:CanvasText;cursor:pointer;font:600 .72rem ui-monospace,monospace` }, [T(u.consented ? "Revoke" : "Allow")], { click: { dispatch: "origin.consentToggle", payload: u.fn } }),
  ]);
  return el("div", { class: "consent-panel", style: "font:13px system-ui;padding:.1rem .25rem" }, [
    el("p", { style: "margin:.2rem;opacity:.85" }, [T("Consent — only these functions do I/O or run code. Allow only what you trust this page to do.")]),
    ...rows.map(row),
  ]);
}) as Fn;
// origin.consentToggle — flip one fn's consent (host/user only), re-sync, repaint.
const consentToggle: Fn = (async (state: State, payload?: unknown): Promise<State> => {
  const fn = String(payload ?? ""); if (!fn) return state;
  const consent = (state.cels.get("consent")?.v ?? {}) as Record<string, { allow?: boolean }>;
  const cur = !!consent[fn]?.allow;
  setConsent(state, fn, { allow: !cur, category: DANGEROUS[fn]?.category });
  await consentSync(state);
  await (resolveFn(state, "setValueBatch") as Fn)(state, [["元.error", `🛂 ${fn}: ${!cur ? "allowed" : "blocked"}`]]);
  return state;
}) as Fn;
// consentpanel() — open the consent list as a draggable window (reads consent.usage).
const consentpanelFn: Fn = (((): unknown => {
  const lay = "win.consent", sref = `${lay}.state`, cref = `${lay}.content`;
  return { genesis: true, layer: lay, cels: {
    [sref]: { celType: "ValueCel", v: { ref: sref, x: 110, y: 96, w: 470, h: 430, z: 1, min: 0, max: 0, closed: 0, title: "🛂 Consent" }, metadata: { name: "state" } },
    [cref]: { celType: "FormulaCel", f: "(consentdom consent.usage)", metadata: { name: "content", parser: "f" } },
    [`${lay}.frame`]: { celType: "FormulaCel", f: `(mount ".origin" (winframe ${sref} win.active ${cref}))`, metadata: { name: "frame", parser: "f" } },
  } };
})) as Fn;

// ── viewport — reactive page metrics. Formulas reference the cels (viewport.w /
// viewport.h / viewport.mobile / viewport.orient) and re-run on resize, so a
// sheet lays itself out responsively:
//   =IF(viewport.mobile, dom("h1","phone view"), win("app","App","body"))
//   =win("app", "App", body, viewport.w, viewport.h - 40)
// =viewport() returns the same metrics as a one-shot snapshot object.
const MOBILE_W = 720;
const vpRead = (): { w: number; h: number; mobile: boolean; orient: string } => {
  const g = globalThis as { innerWidth?: number; innerHeight?: number; matchMedia?: (q: string) => { matches: boolean } };
  const w = Number(g.innerWidth) || 1200, h = Number(g.innerHeight) || 800;
  const coarse = !!g.matchMedia?.("(pointer: coarse)").matches;
  return { w, h, mobile: w <= MOBILE_W || coarse, orient: w >= h ? "landscape" : "portrait" };
};
/** viewport() — current page metrics {w, h, mobile, orient} as a one-shot
 *  snapshot. For REACTIVE layout, reference the cels viewport.w / viewport.h /
 *  viewport.mobile / viewport.orient instead — they update on window resize. */
const viewportFn: Fn = () => vpRead();
/** origin.viewportSync — write live page metrics into the viewport.* cels so
 *  formulas that reference them re-run. The host calls it at boot and on resize. */
const viewportSync: Fn = (async (state: State): Promise<State> => {
  const m = vpRead();
  const setV = resolveFn(state, "setValue") as Fn, setC = resolveFn(state, "setCel") as Fn;
  for (const [k, v] of [["viewport.w", m.w], ["viewport.h", m.h], ["viewport.mobile", m.mobile], ["viewport.orient", m.orient]] as [string, unknown][]) {
    if (state.cels.has(k)) await setV(state, k, v);
    else await setC(state, k, { celType: "ValueCel", v, metadata: { key: k, segment: "origin", name: k.split(".")[1] } });
  }
  return state;
}) as Fn;

// ── clock — a host-ticked time cel (the Win-95 taskbar clock). NOW()/TODAY() are
// banned as inline builtins (a pure formula can't read the wall clock), so the
// sanctioned pattern is a host-ticked CEL formulas REFERENCE: clock (HH:MM) +
// clock.full (locale date+time). The host calls origin.clockSync on an interval;
// it only writes when the minute rolls, so it re-renders ~once a minute.
const clockSync: Fn = (async (state: State): Promise<State> => {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
  const hhmm = `${hh}:${mm}`;
  if (state.cels.get("clock")?.v === hhmm) return state; // unchanged → no re-fire
  const setV = resolveFn(state, "setValue") as Fn, setC = resolveFn(state, "setCel") as Fn;
  for (const [k, v] of [["clock", hhmm], ["clock.full", d.toLocaleString()]] as [string, unknown][]) {
    if (state.cels.has(k)) await setV(state, k, v);
    else await setC(state, k, { celType: "ValueCel", v, metadata: { key: k, segment: "origin", name: k.split(".").pop() } });
  }
  return state;
}) as Fn;

// ── navbar — a pasteable menu. item(label, action, …children) is a WordPress-
// style menu node (arbitrary nesting); nav(mobile, …items) renders ONE tree two
// ways, switched by viewport.mobile: a collapsible ☰ left sidebar on mobile,
// desktop icon-launchers otherwise. Nesting uses native <details> (no toggle
// state cel needed). Clicking a LEAF dispatches origin.navOpen with its action:
// a window KEY focuses that window; a "=formula" spawns a new window.
interface NavItem { __navitem: true; label: string; action: string; children: NavItem[] }
const isNavItem = (v: unknown): v is NavItem => !!v && typeof v === "object" && (v as { __navitem?: unknown }).__navitem === true;
const itemFn: Fn = ((label?: unknown, action?: unknown, ...children: unknown[]): NavItem =>
  ({ __navitem: true, label: String(label ?? ""), action: action == null ? "" : String(action), children: children.filter(isNavItem) })) as Fn;
const navNode = (it: NavItem, depth: number): VNode => {
  const pad = "padding:.4rem .6rem";
  if (it.children.length) return makeEl("details", { class: "pl-nav-group", ...(depth === 0 ? { open: "" } : {}) }, [
    makeEl("summary", { style: `${pad};cursor:pointer;font:600 .9rem ui-monospace,monospace` }, [T(it.label)]),
    makeEl("div", { style: `padding-left:.7rem;display:flex;flex-direction:column;gap:.1rem` }, it.children.map((c) => navNode(c, depth + 1))),
  ]);
  return makeEl("button", { class: "pl-nav-item", style: `${pad};display:flex;gap:.5rem;align-items:center;border:0;background:transparent;color:CanvasText;cursor:pointer;font:600 .9rem ui-monospace,monospace;text-align:left;width:100%;border-radius:.4rem` },
    [T(it.label)], { click: { dispatch: "origin.navOpen", payload: it.action } });
};
/** nav([mobile], item, …) — a navigation menu. Pass viewport.mobile as the first
 *  arg to auto-switch (mobile = collapsible ☰ sidebar; else desktop launchers).
 *  =nav(viewport.mobile, item("📁 Files","files"), item("📊 Charts", item("🥧 Pie", '=…'))). */
// a desktop ICON tile — the leaf's label split into a big glyph + a caption
// below, the way app icons sit on a desktop. Over the wallpaper, so the caption
// gets a shadow for legibility and the tile lifts on hover.
const navIcon = (it: NavItem): VNode => {
  const sp = it.label.indexOf(" ");
  const glyph = sp > 0 ? it.label.slice(0, sp) : it.label;
  const caption = sp > 0 ? it.label.slice(sp + 1) : "";
  return makeEl("button", { class: "pl-nav-icon", style: "display:flex;flex-direction:column;align-items:center;gap:.15rem;width:5.2rem;padding:.25rem .25rem;border:0;background:transparent;cursor:pointer;border-radius:.6rem;text-align:center" },
    // color:#fff so a MONOCHROME/text-presentation glyph (▦, a text-style 🖥) is
    // visible on the dark wallpaper; color emoji (🐢, 📁) ignore `color` and stay
    // colorful. The dark pill behind it gives any glyph contrast on a light wallpaper.
    [makeEl("div", { class: "pl-nav-glyph", style: "font-size:1.7rem;line-height:1;width:2.6rem;height:2.6rem;display:flex;align-items:center;justify-content:center;color:#fff;background:rgba(20,22,30,.45);border:1px solid #ffffff22;border-radius:.7rem;box-shadow:0 2px 6px #0006;filter:drop-shadow(0 1px 2px #0007)" }, [T(glyph)]),
     ...(caption ? [makeEl("div", { class: "pl-nav-cap", style: "font:600 .72rem ui-monospace,monospace;color:#fff;text-shadow:0 1px 3px #000c,0 0 2px #000a;white-space:nowrap" }, [T(caption)])] : [])],
    { click: { dispatch: "origin.navOpen", payload: it.action } });
};
const navFn: Fn = ((...args: unknown[]): VNode => {
  const mobile = typeof args[0] === "boolean" ? (args[0] as boolean) : false;
  const items = args.filter(isNavItem);
  if (mobile) {
    const list = makeEl("div", { class: "pl-nav-list", style: "display:flex;flex-direction:column;gap:.15rem;padding:.3rem;min-width:11rem" }, items.map((it) => navNode(it, 0)));
    return makeEl("details", { class: "pl-nav pl-nav-mobile", style: "position:fixed;left:0;top:0;z-index:90;background:Canvas;border:1px solid #8884;border-radius:0 0 .6rem 0;max-width:84vw;max-height:92vh;overflow:auto;box-shadow:2px 2px 14px #0004" },
      [makeEl("summary", { style: "padding:.45rem .7rem;cursor:pointer;font:600 1.4rem ui-monospace,monospace" }, [T("☰")]), list]);
  }
  // desktop: floating app icons down the left edge (no panel chrome).
  return makeEl("div", { class: "pl-nav pl-nav-desktop", style: "position:fixed;left:.5rem;top:.6rem;z-index:40;display:flex;flex-direction:column;gap:.35rem" }, items.map(navIcon));
}) as Fn;
/** origin.navOpen — a nav leaf was clicked. A "=formula" spawns a new window
 *  (trusted preset, capped by the kernel); anything else is a window key → focus it. */
const navOpenFn: Fn = (async (state: State, payload?: unknown): Promise<State> => {
  const action = String(payload ?? "").trim();
  if (!action) return state;
  if (action.startsWith("seg:")) {
    // SWITCH to a segment (segment-nav-and-memory): wake it if dormant (lazy load),
    // then raise its window if it has one. (Sleeping the others to a budget is the
    // LRU/pin layer — a follow-up.)
    const seg = action.slice(4);
    if (isSegmentPending(state, seg)) await (resolveFn(state, "wake") as Fn)(state, seg);
    try { await (resolveFn(state, "winsheet.raise") as Fn)(state, `${seg}.state`); } catch { /* not a windowed segment */ }
  } else if (action.startsWith("do:")) {
    // a HOST-VERB launcher (e.g. do:origin.savepage) — the verb materializes +
    // paints its own windows, so just dispatch it.
    const fn = resolveFn(state, action.slice(3)) as Fn | undefined;
    if (fn) await fn(state);
  } else if (action.startsWith("open:")) {
    // a FILE launcher (e.g. open:/readme.f) — read the formula-source file from
    // OPFS and run it into windows. One action for readme/keyboard/turtles/…
    await openFile(state, action.slice(5));
  } else if (/^[=(]/.test(action)) {
    // A "=formula" launcher (=winapp/=chatapp/=consentpanel/=doom/…). Spawn it into
    // a STABLE segment keyed by the action so re-clicking the icon reuses the SAME
    // generator rather than minting app1/app2/… — a fresh owner would trap on the
    // window's already-owned win.<id>.* cels. First click materializes the window;
    // a repeat is an idempotent genesis (geometry preserved), then winx.show below
    // un-hides it (genesis never resets a closed/min flag — that's a user edit, so
    // without this an icon couldn't reopen a window the ✕ had closed).
    let hsh = 0; for (const ch of action) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
    const seg = `nav${hsh.toString(36)}`;
    if (!state.cels.get(`${seg}.元`)) {
      const parser = action.trim().startsWith("=") ? "infix" : "f";
      await (resolveFn(state, "setCel") as Fn)(state, `${seg}.元`, { celType: "FormulaCel", f: action, metadata: { key: `${seg}.元`, segment: seg, parser } });
    }
    // materialize the spawned genesis — the dispatch path only drains dom.paint,
    // so a window-spawning leaf needs the commit/drain cycle the boot uses (else
    // the nav.元 formula cell is created but its genesis never opens a window).
    const drain = resolveFn(state, "drain") as Fn, runCycle = resolveFn(state, "runCycle") as Fn;
    for (let i = 0; i < 6; i++) { await runCycle(state); if (state.cels.get("genesis.commit")) await drain(state, "genesis.commit"); if (state.cels.get("origin.effects")) await drain(state, "origin.effects"); }
    // un-hide the window this genesis owns: a repeat click reopens a window the ✕
    // had closed (or the – had minimized). The state cel survived regeneration, so
    // reset closed/min + raise it via winx.show (a no-op for an already-open one).
    const req = state.cels.get(`${seg}.元`)?.v as { layer?: string } | undefined;
    const sref = req?.layer ? `${req.layer}.state` : undefined;
    if (sref && state.cels.get(sref)) await (resolveFn(state, "winx.show") as Fn)(state, sref);
    // if the consent app was just opened, populate its usage list FIRST (before the
    // view rewire) — running consentSync's cascade AFTER the rewire re-fired 元.view
    // against a stale cell list and dropped the just-mounted window.
    if (state.cels.get("win.consent.state")) await (resolveFn(state, "origin.consentSync") as Fn)(state);
    // apply any geom() the genesis declared (=cels("sheet",…,geom(…)) etc.) — this
    // branch has its own settle loop, so it needs the same geom-application run does.
    await applyDeclaredGeom(state, `${seg}.元`);
    // refresh the view's cell list so the new window's frame cel enters the scan
    // (cellKeys whitelists win.*.frame), then fire + paint so it actually renders.
    await (resolveFn(state, "view.refresh") as Fn)(state);
    await runCycle(state);
    await drain(state, "dom.paint");
  } else {
    // a window KEY (e.g. "元") — restore it (clears closed/min + raises + repaints),
    // so a launcher reopens a window the desktop boots hidden.
    await (resolveFn(state, "winsheet.restore") as Fn)(state, action);
  }
  return state;
}) as Fn;

// ── navpanel — a PERSISTENT app launcher pinned to the desktop (the "navpanel").
// Unlike =nav (a one-off vnode you paste) this is a genesis whose win.navbar.frame
// cel survives 元 re-renders (cellKeys whitelists win.*.frame) and re-fires on
// viewport.mobile (a ☰ sidebar on phones, corner launchers on desktop). The bar is
// built in TS by navpanelbar so each item's action can carry nested quotes
// (=chatapp("local","🖥 Local")) without formula-string escaping — the action is a
// plain string handed to origin.navOpen, parsed only when the leaf is clicked.
const NAV_ITEMS: [string, string][] = [
  ["🧮 Origin", "元"],                                                                       // restore the base 元 spreadsheet
  ["▦ Sheet", '=cels("sheet", 20, 12, geom(0.18, 0.12, 0.6, 0.66))'],                       // a fresh blank 20×12 worksheet
  ["🛂 Consent", "=consentpanel()"],
  ["🤖 Local LLM", '=chatapp("local","🤖 Local")'],
  ["📁 Files", "=explorerwin()"],
  ["📖 Readme", "open:/readme.f"],
  ["🎹 Keyboard", "open:/keyboard.f"],
  ["📊 Turtles", "open:/turtles.f"],
  ["🐢 DOOM", "=doom()"],
  ["🔑 Vault", '=winapp("secrets","🔑 Vault","(secrets (locked secretsNote) (apiKeys))")'],
];
const navpanelbarFn: Fn = ((mobile?: unknown): unknown =>
  (mount as Fn)(".origin", (navFn as Fn)(!!mobile, ...NAV_ITEMS.map(([l, a]) => (itemFn as Fn)(l, a))))) as Fn;
const navpanelFn: Fn = ((): unknown => ({
  genesis: true, layer: "win.navbar",
  cels: { "win.navbar.frame": { celType: "FormulaCel", f: "(navpanelbar viewport.mobile)", metadata: { name: "frame", parser: "f", segment: "win.navbar" } } },
})) as Fn;
// origin.opennav — host helper: materialize the navpanel on boot (set the
// draft, commit it to a holding cell, drain genesis + paint).
const opennav: Fn = async (state: State): Promise<State> => {
  const setValue = resolveFn(state, "setValue") as Fn, commit = resolveFn(state, "origin.run") as Fn, drain = resolveFn(state, "drain") as Fn, runCycle = resolveFn(state, "runCycle") as Fn;
  if (state.cels.get("win.navbar.frame")) return state;   // idempotent — already up
  await setValue(state, "元.draft", "=navpanel()");
  await commit(state, "navbar.run");
  for (let i = 0; i < 6; i++) { await runCycle(state); if (state.cels.get("genesis.commit")) await drain(state, "genesis.commit"); if (state.cels.get("origin.effects")) await drain(state, "origin.effects"); }
  // clean desktop: nothing opens by default. Hide the base 元 sheet + the wallpaper
  // worksheet windows (the wallpaper still paints — it's a .origin mount, not the
  // window). The 🧮 Origin launcher restores 元; the wallpaper has no launcher.
  const geom = (state.cels.get("win.geom")?.v ?? {}) as Record<string, { closed?: number }>;
  const hidden = { ...geom, ["元"]: { ...(geom["元"] ?? {}), closed: 1 }, desktop: { ...(geom.desktop ?? {}), closed: 1 } };
  await setValue(state, "win.geom", hidden);
  await runCycle(state);
  await drain(state, "dom.paint");
  return state;
};

// openFile(state, opfsPath) — read a stored formula-source FILE from OPFS and run
// it into windows (origin.run sniffs the parser, so an s-expr readme and an infix
// keyboard both work). Backs the navpanel's `open:/<path>.f` launchers (📖 Readme,
// 🎹 Keyboard, 📊 Turtles — one parameterized action, not a verb per file). The
// source is a REAL file (seedStarter materialized it from the bundle's starter/),
// so it's discoverable + editable in 📁 Files. Commits into a `launch.<file>`
// holding cell — UNIQUE per file (so opening readme doesn't sweep keyboard) and in
// the `launch` namespace (outside every worksheet, so the formula bar stays empty
// until a cell is clicked) — then RAISES the worksheet windows it created so the
// opened app comes to the top / active.
const openFile = async (state: State, opfsPath: string): Promise<State> => {
  await ensureSegments(state, ["file-store"]);
  const f = String(await ((resolveFn(state, "fs.readText") as Fn)(opfsPath) as Promise<string>).catch(() => ""));
  if (!f) return state;
  const base = (opfsPath.split("/").pop() || opfsPath).replace(/\.[^.]*$/, "");
  await (resolveFn(state, "origin.run") as Fn)(state, `launch.${base}`, f);   // source-arg form (commits + settles)
  // RESTORE each worksheet the formula created (clear closed/min + raise) so a
  // re-clicked launcher REOPENS a window the ✕ had closed. Its NAME is the first
  // quoted string after `cels` in BOTH the infix `cels("name", …)` and s-expr
  // `(cels R C "name" …)` forms. Last one restored wins focus.
  const restore = resolveFn(state, "winsheet.restore") as Fn | undefined;
  if (restore) for (const m of f.matchAll(/\bcels\b[^"]*?"([^"]+)"/g)) { try { await restore(state, m[1]); } catch { /* not windowed */ } }
  await (resolveFn(state, "view.refresh") as Fn)(state);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
};

// origin.seedStarter — first-run: read the inert #plastron-starter manifest the
// bundle baked into the page (a {opfsPath: source} map of the repo's starter/
// files: readme, keyboard) and write each MISSING file into OPFS, so they ship as
// real, discoverable files in 📁 Files instead of baked seed cells. Idempotent
// (skips files that already exist — a user edit is preserved). No-op off-DOM /
// without a filesystem (file://, sandbox); host-called once in the desktop boot.
const seedStarter: Fn = async (state: State): Promise<State> => {
  const backend = state.cels.get("file-store.backend")?.v;
  if (backend === "none" || backend === undefined) return state;
  const g = globalThis as { document?: { getElementById?: (id: string) => { textContent?: string | null } | null } };
  const raw = g.document?.getElementById?.("plastron-starter")?.textContent;
  if (!raw) return state;
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(raw) as Record<string, unknown>; } catch { return state; }
  await ensureSegments(state, ["file-store"]);
  const exists = resolveFn(state, "fs.exists") as Fn, writeText = resolveFn(state, "fs.writeText") as Fn;
  for (const [path, content] of Object.entries(manifest)) {
    const there = await (exists(path) as Promise<boolean>).catch(() => false);
    if (!there) await (writeText(path, String(content)) as Promise<unknown>).catch(() => {});
  }
  return state;
};

// origin.reseed — the dev/refresh twin of seedStarter: FORCE-overwrite the OPFS
// starter files (/readme.f, /keyboard.f, /turtles.f) from the embedded manifest,
// even if they exist, AND clear the win.geom of the worksheets they declare so a
// changed geom() re-applies on the next open. Backs the desktop's ↻ reseed button
// (in 元's formula). Reopen the apps to see the refreshed files.
const reseed: Fn = async (state: State): Promise<State> => {
  const backend = state.cels.get("file-store.backend")?.v;
  if (backend === "none" || backend === undefined) return state;
  const g = globalThis as { document?: { getElementById?: (id: string) => { textContent?: string | null } | null } };
  const raw = g.document?.getElementById?.("plastron-starter")?.textContent;
  if (!raw) return state;
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(raw) as Record<string, unknown>; } catch { return state; }
  await ensureSegments(state, ["file-store"]);
  const writeText = resolveFn(state, "fs.writeText") as Fn;
  const segs = new Set<string>();
  for (const [path, content] of Object.entries(manifest)) {
    await (writeText(path, String(content)) as Promise<unknown>).catch(() => {});          // OVERWRITE
    for (const m of String(content).matchAll(/\bcels\b[^"]*?"([^"]+)"/g)) segs.add(m[1]);  // worksheet names → clear their geom
  }
  const geom = { ...((state.cels.get("win.geom")?.v as Record<string, unknown>) ?? {}) };
  for (const s of segs) delete geom[s];
  await (resolveFn(state, "setValue") as Fn)(state, "win.geom", geom);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
};

// (origin.autoload removed: no boot auto-restore. =save() writes a real OPFS file;
//  reopen it from 📁 Files or with =open(). Reload = a clean desktop.)

// (origin.seedWallpaper removed: the desktop background is rendered by a FORMULA
//  — 元.f's `(img desktop.A2 windows.wallpaper …)` mount — straight from the
//  shipped windows.wallpaper data-URI, so no boot-time OPFS write is needed. Set
//  a custom background by editing the cell, e.g. desktop.A2 → a path/url.)

// ── inspect rendering — a tiny YAML-ish doc, easiest for a human to read ─────

// `label: value` per field; multi-line strings become a `|` literal block
// (no escaping, reads top-to-bottom). Empty/undefined fields are dropped.
const yamlDoc = (fields: [string, unknown][]): string => {
  const out: string[] = [];
  for (const [k, v] of fields) {
    if (v === undefined || v === null || v === "") continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s.includes("\n")) { out.push(`${k}: |`); for (const ln of s.split("\n")) out.push(`  ${ln}`); }
    else out.push(`${k}: ${s}`);
  }
  return out.join("\n");
};
// soft-wrap prose so a long description reads as a paragraph, not one line
const wrap = (s: string, w = 68): string =>
  s.split(/\s+/).reduce<string[]>((ls, word) => {
    const last = ls[ls.length - 1];
    if (last !== undefined && (last + " " + word).length <= w) ls[ls.length - 1] = last + " " + word;
    else ls.push(word);
    return ls;
  }, []).join("\n");

/** The =vocab() catalog as plain text: top-level callable cels + value cels,
 *  each with its metadata.description. Pure (state in, text out) so the effects
 *  drain AND the Pages build (bundle.ts → <noscript>) emit the SAME catalog. */
export const vocabText = (state: State, segment = ""): string => {
  const desc = (c: Cel): string => String((c.metadata as { description?: unknown }).description ?? "");
  const segOf = (c: Cel): string => String((c.metadata as { segment?: unknown }).segment ?? "misc");
  // group callable cels by their segment so the catalog reads as labelled
  // sections (charts, dom, grids, …) — the grouping is the metadata.segment
  // every cel already carries, not a hand-kept list.
  const bySeg = new Map<string, string[]>(); const vals: string[] = [];
  for (const [k, c] of state.cels) {
    if (segment && c.metadata.segment !== segment) continue;
    if (k.includes(".")) continue; // skip namespaced internals (g.A1, foo.bar)
    if (c.celType === "LockedLambdaCel" || c.celType === "EditableLambdaCel" || c.celType === "CompilerCel") {
      const line = `  ${k}${desc(c) ? `  — ${desc(c)}` : ""}`;
      const s = segOf(c); (bySeg.get(s) ?? bySeg.set(s, []).get(s)!).push(line);
    } else if (c.celType === "ValueCel") {
      vals.push(`  ${k} = ${JSON.stringify(c.v)?.slice(0, 40)}`);
    }
  }
  const out: string[] = [`functions (call as (${"name"} …) or =name(…)), grouped by segment:`];
  for (const s of [...bySeg.keys()].sort()) { out.push("", `[${s}]`, ...bySeg.get(s)!.sort()); }
  // [excel] — the inline infix builtins (IF/SUM/VLOOKUP/LET/…). They are NOT
  // cels (evaluated inline, dependency-free), so they don't appear above; list
  // them from BUILTIN_DOCS so the catalog is complete for an LLM. Only in the
  // unfiltered catalog (a segment filter asks for ONE segment's cels).
  if (!segment) {
    out.push("", "[excel]  (infix builtins — call as =NAME(…); inline, not cels)");
    for (const k of Object.keys(BUILTIN_DOCS).sort()) out.push(`  ${k}  — ${BUILTIN_DOCS[k]}`);
  }
  out.push("", "values (reference by name):", ...vals.sort());
  return out.join("\n");
};

// ── origin.effects: load / cels requests (effects at drain) ─────────────────

// Introspection vocabulary. Each returns a REQUEST; the effects drain
// (which has `state`) does the read — formula fns only get input values,
// not state, so a graph read can't be a plain fn. The drain replaces
// the requesting cell with a ValueCel holding the result.
const celsFn: Fn = (name: unknown) => ({ originCels: true, segment: String(name ?? "") });
/** inspect(key) — the cel's full definition (celType, value, formula,
 *  metadata) as readable JSON. */
const inspectFn: Fn = (key: unknown) => ({ originInspect: true, key: String(key ?? "") });
/** segments() — every loaded segment with role/version/dependencies. */
const segmentsFn: Fn = () => ({ originSegments: true });
/** vocab(segment?) — the values + functions you can USE in formulas
 *  (callable lambdas/compilers + value cels), with kind + description.
 *  No arg → across all loaded segments. */
const vocabFn: Fn = (seg?: unknown) => ({ originVocab: true, segment: seg == null ? "" : String(seg) });
/** def(name, kind, source) — define a callable function in `kind` (the
 *  installed compiler: "js" works out of the box; "py"/"wat" need their
 *  runtime loaded). `=def("double", "js", "x => x * 2")` then call it from
 *  any formula: `=double(21)` → 42. */
const defFn: Fn = (name: unknown, kind: unknown, source: unknown) =>
  ({ originDef: true, name: String(name ?? ""), kind: String(kind ?? "js"), source: String(source ?? "") });
/** chat(prompt, apiKey [, model] [, url]) — a chat-completion request to an
 *  OpenAI-shaped endpoint. The effects drain does the fetch and drops the
 *  reply text in the cell. apiKey is the value: pass a literal "xai-…" or a
 *  cel reference holding the key (the formula resolves it before calling). */
const chatFn: Fn = (prompt: unknown, key: unknown, model: unknown, url: unknown) =>
  ({ originChat: true, prompt: String(prompt ?? ""), key: String(key ?? ""),
     model: model == null || model === "" ? undefined : String(model),
     url: url == null || url === "" ? undefined : String(url) });
/** grok(prompt, apiKey [, model]) — chat() pinned to xAI's Grok endpoint. */
const grokFn: Fn = (prompt: unknown, key: unknown, model: unknown) =>
  ({ originChat: true, provider: "grok", prompt: String(prompt ?? ""), key: String(key ?? ""),
     model: model == null || model === "" ? "grok-3-mini" : String(model),
     url: "https://api.x.ai/v1/chat/completions" });
/** claude(prompt, apiKey [, model]) — ask Anthropic Claude, reactively.
 *  Unlike chat()/grok() (drain requests — the cell becomes a one-shot
 *  confirmation), this is a direct async fn: the kernel awaits the
 *  Promise and the reply becomes the cell's VALUE while the formula
 *  stays put — edit the prompt cel and it asks again. Works straight
 *  from the browser via Anthropic's OpenAI-compatible endpoint + the
 *  CORS opt-in header. Empty prompt/key short-circuit without fetching. */
/** cdn(url) — load an external script/library from a URL via the kernel's
 *  loadScript primitive. The explicit way external resources enter the page
 *  (e.g. a charting lib, or a self-hosted Pyodide build). */
const cdnFn: Fn = (url: unknown) => ({ originCdn: true, url: String(url ?? "") });

// --- OPFS filesystem vocabulary (Ubuntu-style) — thin over file-store's fs.*
//     cels. Each returns an effect descriptor; the drain lazy-loads file-store,
//     runs the async op, and lands the result back in the cell. ---
const lsFn:      Fn = (path?: unknown) => ({ originFs: "ls",    path: path == null || path === "" ? "/" : String(path) });
const treeFn:    Fn = (path?: unknown) => ({ originFs: "tree",  path: path == null || path === "" ? "/" : String(path) });
const mkdirFn:   Fn = (path: unknown)  => ({ originFs: "mkdir", path: String(path ?? "") });
const rmFn:      Fn = (path: unknown)  => ({ originFs: "rm",    path: String(path ?? "") });
const mvFn:      Fn = (a: unknown, b: unknown) => ({ originFs: "mv", path: String(a ?? ""), to: String(b ?? "") });
const catFn:     Fn = (path: unknown)  => ({ originFs: "cat",   path: String(path ?? "") });
const fsWriteFn: Fn = (path: unknown, text?: unknown) => ({ originFs: "write", path: String(path ?? ""), text: text == null ? "" : String(text) });
const touchFn:   Fn = (path: unknown)  => ({ originFs: "touch", path: String(path ?? "") });
const statFn:    Fn = (path: unknown)  => ({ originFs: "stat",  path: String(path ?? "") });

// --- segment/sheet manager — list/delete the named sheet FILES that =save()/
//     =open() round-trip through /plastron/sheets (the collectArchive form).
//     =segs() lists them; =saveSeg/=openSeg are name-equivalent to =save/=open. ---
const segsFn:    Fn = () => ({ originSeg: "list" });
const saveSegFn: Fn = (name: unknown) => ({ originSeg: "save", name: String(name ?? "") });
const openSegFn: Fn = (name: unknown) => ({ originSeg: "open", name: String(name ?? "") });
const delSegFn:  Fn = (name: unknown) => ({ originSeg: "del",  name: String(name ?? "") });

// downloadSeg(name) — a ⬇ button for a saved sheet archive under /plastron/sheets.
const downloadSegFn: Fn = (name: unknown): V => {
  const p = `/plastron/sheets/${String(name ?? "")}.json`;
  return el("button", { class: "opfs-btn", type: "button", title: `download ${p}` },
    [T(`⬇ ${p.split("/").pop() || p}`)], { click: { dispatch: "explorer.download", payload: p } });
};
// --- sqlite — db()/sql()/tables() vocabulary. These verbs just emit originDb
//     descriptors; the drain (below) delegates to the `sqlite` library's
//     sqlite.command, which runs @sqlite.org/sqlite-wasm over the opfs-sahpool
//     VFS in a Worker (persistent, incremental, no COOP/COEP). ---
const dbHandleName = (h: unknown): string =>
  (h && typeof h === "object" && typeof (h as { __db?: unknown }).__db === "string")
    ? (h as { __db: string }).__db : String(h ?? "main");

const dbFn:     Fn = (name: unknown) => ({ originDb: "open", name: String(name ?? "main") });
const sqlFn:    Fn = (handle: unknown, query: unknown) => ({ originDb: "sql", name: dbHandleName(handle), query: String(query ?? "") });
const tablesFn: Fn = (handle: unknown) => ({ originDb: "sql", name: dbHandleName(handle), query: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" });
// =dbseed(db, rows, "table") — bulk-load a JSON array of row objects into a table.
// (Named dbseed because =seed already serializes the whole document.)
const dbSeedFn: Fn = (handle: unknown, rows: unknown, table: unknown) =>
  ({ originDb: "seed", name: dbHandleName(handle), query: JSON.stringify({ table: String(table ?? ""), rows: rows ?? [] }) });
// =schema(db) — introspect tables/columns/PK/FK (groundwork for the visual query builder).
const schemaFn: Fn = (handle: unknown) => ({ originDb: "schema", name: dbHandleName(handle) });
// =dbexport(db, path) — serialize the db to a portable .db blob and write it to a
// file-store path (browsable / downloadable). =dbimport(db, path) loads such a
// file back into the db. The bridge between SQLite's opaque SAH pool and the
// browsable filesystem; both go through file-store.
const dbExportFn: Fn = (handle: unknown, path: unknown) =>
  ({ originDb: "export", name: dbHandleName(handle), query: String(path ?? "") });
const dbImportFn: Fn = (handle: unknown, path: unknown) =>
  ({ originDb: "import", name: dbHandleName(handle), query: String(path ?? "") });

// --- interlinked(seg) — the cel graph as a force-directed canvas. Nodes = the
//     segment's coordinate cels; edges = their inputMap deps. The layout is
//     plain JS (a small force sim), NOT a kernel primitive; the drain composes
//     a canvas spec (lines + circles + labels) from it. ---
const forceLayout = (n: number, edges: [number, number][], w: number, h: number): { x: number; y: number }[] => {
  const pos = Array.from({ length: n }, (_, i) => {
    const a = (i / Math.max(1, n)) * Math.PI * 2;
    return { x: w / 2 + Math.cos(a) * w * 0.3, y: h / 2 + Math.sin(a) * h * 0.3 };
  });
  for (let it = 0; it < 150; it++) {
    const fx = new Array<number>(n).fill(0), fy = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let dx = pos[i]!.x - pos[j]!.x, dy = pos[i]!.y - pos[j]!.y;
      const d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2), f = 1600 / d2;
      dx /= d; dy /= d; fx[i]! += dx * f; fy[i]! += dy * f; fx[j]! -= dx * f; fy[j]! -= dy * f;
    }
    for (const [i, j] of edges) {
      let dx = pos[j]!.x - pos[i]!.x, dy = pos[j]!.y - pos[i]!.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01, f = d * 0.02;
      dx /= d; dy /= d; fx[i]! += dx * f; fy[i]! += dy * f; fx[j]! -= dx * f; fy[j]! -= dy * f;
    }
    for (let i = 0; i < n; i++) {
      pos[i]!.x = Math.max(26, Math.min(w - 26, pos[i]!.x + Math.max(-6, Math.min(6, fx[i]!))));
      pos[i]!.y = Math.max(26, Math.min(h - 26, pos[i]!.y + Math.max(-6, Math.min(6, fy[i]!))));
    }
  }
  return pos;
};
const interlinkedFn: Fn = (seg: unknown) => ({ originGraph: String(seg ?? "") });

// --- simulate(fnName, n?) — def-driven animation. Runs a def'd frame fn
//     (i → [x, y]) n times in the drain, then plays the trajectory on an
//     animated canvas. The physics lives in the def'd JS fn; this only runs
//     it + schedules frames (shared shape with interlinked's animated mode). ---
const simulateFn: Fn = (fnName: unknown, n: unknown, r: unknown) =>
  ({ originSim: true, fn: String(fnName ?? ""), n: Math.max(2, Math.min(2000, Math.floor(Number(n)) || 120)), r: Math.max(2, Math.floor(Number(r)) || 12) });

// dragdrop(w?, h?) — two drop zones (A, B) + a draggable rect that snaps to the
// nearest zone on release. A VALUE vnode (like dom/canvas); the interactivity
// lives in dom's canvas renderer (the `draggable`/`zone` ops).
const dragdropFn: Fn = (w: unknown, h: unknown) => {
  const W = Math.max(220, Math.floor(Number(w)) || 420), H = Math.max(120, Math.floor(Number(h)) || 200);
  const zw = W * 0.4, zh = H * 0.66, zy = (H - zh) / 2, ax = W * 0.04, bx = W - W * 0.04 - zw, rw = 64, rh = 40;
  const ops = [
    { op: "zone", x: ax, y: zy, w: zw, h: zh, label: "A" },
    { op: "zone", x: bx, y: zy, w: zw, h: zh, label: "B" },
    { op: "draggable", x: ax + zw / 2 - rw / 2, y: zy + zh / 2 - rh / 2, w: rw, h: rh, fill: "#e91e63" },
  ];
  return { type: "el", tag: "canvas", attrs: { width: W, height: H, "data-ops": JSON.stringify(ops) }, children: [] };
};

const effectsDrain: Fn = async (items: ChannelEnqueue[], stateArg?: unknown): Promise<void> => {
  const state = (stateArg ?? items[0]?.state) as State | undefined;
  if (!state) return;
  const setCel = resolveFn(state, "setCel") as Fn;
  for (const { cel } of items) {
    const req = cel.v as Record<string, unknown> | undefined;
    if (!req || typeof req !== "object") continue;
    // load/cels/inspect/segments/vocab are ACTIONS — the result is data.
    // Replace the requesting FORMULA cel with a ValueCel holding it, so
    // the next runCycle can't re-evaluate the formula over the result.
    let result: unknown;
    try {
      // Consent gate lives upstream now: the central runCycle gate #BLACKLISTs a
      // locked-session formula that references a DANGEROUS verb BEFORE it can emit
      // an effect descriptor, so an un-consented save/cdn/sql/fs/chat never
      // reaches this drain. No per-verb hand-map here.
      if (req.originCels && req.segment) {
        const lines: string[] = [];
        const skill = state.cels.get(`${req.segment}.skill`);
        if (skill && typeof skill.v === "string") lines.push(skill.v, "");
        for (const [k, c] of state.cels) {
          if (c.metadata.segment !== req.segment) continue;
          const f = (c as { f?: string }).f;
          lines.push(`${k}  [${c.celType}${c.locked ? ", locked" : ""}]${f ? `  f: ${f.slice(0, 60)}` : ""}`);
        }
        result = lines.length ? lines.join("\n") : `(no segment named "${req.segment}" — see =segments() for what's loaded)`;
      } else if (req.originInspect && req.key) {
        const key = String(req.key);
        const c = state.cels.get(key);
        const fnTypes = new Set(["LockedLambdaCel", "EditableLambdaCel", "CompilerCel"]);
        if (!c) {
          result = `(no cel named "${key}")`;
        } else if (fnTypes.has(c.celType)) {
          // a lambda/compiler IS a function. Foreground the human-readable
          // bits — signature + about — then the source LAST (it's the live
          // body, which is minified in the bundle). Split a leading
          // "(args) - prose" description into signature + about.
          const md = c.metadata as { kind?: string; description?: string; segment?: string };
          const f = (c as { f?: string; _fn?: unknown }).f;
          const dm = /^\s*(\([^)]*\))\s*[-—:]?\s*([\s\S]*)$/.exec(md.description ?? "");
          const tags = [c.locked ? "locked" : "", md.kind ?? ""].filter(Boolean);
          result = yamlDoc([
            ["name", key],
            ["type", `${c.celType}${tags.length ? ` (${tags.join(", ")})` : ""}`],
            ["segment", md.segment ?? "?"],
            ["signature", dm?.[1]],
            ["about", wrap((dm?.[2] ?? md.description ?? "").trim())],
            ["source", f ?? String((c as { _fn?: unknown })._fn ?? "")],
          ]);
        } else {
          // value / formula cel — labeled scalars; deps shown if present.
          const md = c.metadata as { segment?: string; parser?: string; inputMap?: Record<string, unknown> };
          const inputs = md.inputMap ? Object.values(md.inputMap).flat().filter((x) => typeof x === "string") : [];
          result = yamlDoc([
            ["name", c.metadata.key],
            ["type", `${c.celType}${c.locked ? " (locked)" : ""}`],
            ["segment", md.segment ?? "?"],
            ["parser", md.parser],
            ["formula", (c as { f?: string }).f],
            // a genesis value is a big request object — show the readable
            // grid tree (same summary the cell renders) as a block scalar
            // (yamlDoc indents multi-line strings), not raw JSON.
            ["value", (c.v && typeof c.v === "object" && (c.v as { genesis?: unknown }).genesis === true)
              ? genesisSummary((c.v as { cels?: Record<string, unknown> }).cels)
              : c.v],
            ["inputs", inputs.length ? inputs.join(", ") : undefined],
          ]);
        }
      } else if (req.originSegments) {
        const segs: string[] = [];
        const segMap = (state as { segments?: Map<string, { name: string; role?: string; version?: string; dependencies?: string[] }> }).segments;
        for (const m of (segMap ? segMap.values() : [])) {
          segs.push(`${m.name}  [${m.role ?? "?"}] v${m.version ?? "?"}${m.dependencies?.length ? `  ← ${m.dependencies.join(", ")}` : ""}`);
        }
        result = segs.sort().join("\n") || "(no segments)";
      } else if (req.originVocab) {
        result = vocabText(state, String(req.segment ?? ""));
      } else if (req.originDef && req.name) {
        // define a callable function from source in some compiler `kind`.
        // The new lambda lands at `name` (not a spreadsheet cell — it has no
        // coordinate); the requesting cell becomes the confirmation below.
        const nm = String(req.name); const kind = String(req.kind || "js");
        await setCel(state, nm, {
          celType: "EditableLambdaCel", f: String(req.source ?? ""),
          metadata: { kind, segment: "origin", name: nm },
        });
        result = `defined "${nm}" (${kind}) — call it: =${nm}(…)`;
      } else if (req.originCdn) {
        const url = String(req.url ?? "");
        if (!url) result = `(cdn: pass a url, e.g. =cdn("https://cdn.jsdelivr.net/npm/…"))`;
        else { await (resolveFn(state, "loadScript") as Fn)(state, url); result = `loaded ${url}`; }
      } else if (req.originSeed) {
        result = buildSeed(state); // the whole document as one paste-able formula

      } else if (req.originExport) {
        // archive json (default, lossless) or the re-minting FORMULA, for one
        // document segment or (no arg) the whole document stack. The boot
        // substrate is never serialised (documentSegments).
        const seg = String(req.seg ?? "");
        const form = String(req.form ?? "archive");
        if (seg && isSubstrateSegment(state, seg)) result = `#REFUSED(export: "${seg}" is boot substrate — only document segments export)`;
        else if (form === "formula") {
          if (!seg) result = buildSeed(state); // whole-doc formula = =seed()
          else { const f = segmentFormula(state, seg); result = f || `#NOFORM("${seg}" has no formula form (e.g. a window) — use =export("${seg}") for its archive)`; }
        } else {
          const archive = seg ? dumpArchive(state, seg) : dumpSegments(state, documentSegments(state));
          if (form === "encrypt") {
            const pass = passOf(req.pass, "passphrase to encrypt with");
            result = pass ? `${ENC_METHOD}:${await encryptPayload(archive, pass)}` : "#DENIED(export: a passphrase is required — =export(seg, \"encrypt\", \"secret\"))";
          } else result = archive;
        }
      } else if (req.originImport) {
        const src = String(req.src ?? "").trim();
        // resolve the archive json: plain `{…}`, or an aes256gcm:… blob (decrypt
        // with the passphrase). A =formula is the entry gesture (paste it).
        let json: string | null = null;
        if (!src) result = "(import: paste an archive json `{…}`, an aes256gcm:… blob, or a =formula)";
        else if (src.startsWith(`${ENC_METHOD}:`)) {
          const pass = passOf(req.pass, "passphrase to decrypt the import");
          if (!pass) result = "#DENIED(import: this is encrypted — pass the passphrase: =import(blob, \"secret\"))";
          else { try { json = await decryptPayload(src.slice(ENC_METHOD.length + 1), pass); } catch { result = "#DENIED(import: wrong passphrase or corrupt blob)"; } }
        } else if (src.startsWith("{")) json = src;
        else if (src.startsWith("=") || src.startsWith("(")) result = "(that's a formula — paste it into a cell to run it; =import is for archive json / aes blobs)";
        else result = "(import: not an archive json `{…}`, an aes256gcm:… blob, or a =formula)";

        if (json !== null) {
          const names = archiveSegmentNames(json);
          const blocked = names.filter((n) => isSubstrateSegment(state, n));
          if (!names.length) result = "(import: not a valid 甲骨 archive)";
          else if (blocked.length) result = `#REFUSED(import: ${blocked.join(", ")} ${blocked.length > 1 ? "are reserved boot-set names" : "is a reserved boot-set name"} — can't overwrite the substrate)`;
          else {
            // wholesale replace: retire every existing cel of each incoming
            // segment, AND its live generator cell (the genesis that minted it) so
            // it can't re-mint over the import — the import wins (the stomp). 元 is
            // never retired (the root cell). A stale cel left out of the new
            // archive is therefore swept.
            const stale = new Set<Key>();
            const incoming = new Set(names);
            const toRetire = new Set<Key>();
            for (const [k, c] of state.cels) {
              if (!incoming.has(c.metadata.segment as Key)) continue;
              toRetire.add(k);
              const gen = (c.metadata as { generatedBy?: unknown }).generatedBy;
              if (typeof gen === "string" && gen !== "元") toRetire.add(gen);
            }
            for (const k of toRetire) retireCel(state, k, stale);
            const added = await loadArchive(state, json);
            await (resolveFn(state, "runCycle") as Fn)(state);
            result = `imported ${added.join(", ")} (${added.length} segment${added.length > 1 ? "s" : ""})`;
          }
        }
      } else if (req.originSave) {
        // save the sheet as a real FILE in OPFS (discoverable in 📁 Files), not
        // localStorage. No filesystem here (file://, sandbox, old browser)? fall
        // back to a share link — =link() rebuilds the sheet from a URL anywhere.
        await ensureSegments(state, ["file-store"]);
        const backend = state.cels.get("file-store.backend")?.v;
        const nm = String(req.name || "default") || "default";
        if (backend === "none" || backend === undefined) {
          result = `(no filesystem here to save to — share this sheet with =link() instead; it rebuilds from the URL anywhere)`;
        } else {
          const DIR = "/plastron/sheets", file = `${DIR}/${nm}.json`;
          await (resolveFn(state, "fs.mkdir") as Fn)(DIR);
          await (resolveFn(state, "fs.writeText") as Fn)(file, JSON.stringify(collectArchive(state)));
          result = `saved "${nm}" → ${file} (reopen from 📁 Files, or =open("${nm}"))`;
        }
      } else if (req.originOpen) {
        await ensureSegments(state, ["file-store"]);
        const nm = String(req.name || "default") || "default";
        const file = `/plastron/sheets/${nm}.json`;
        const raw = await ((resolveFn(state, "fs.readText") as Fn)(file) as Promise<string>).catch(() => null) as string | null;
        if (!raw) result = `(no saved sheet "${nm}" — =save("${nm}") first, or =segs() to list)`;
        else { await restoreArchive(state, JSON.parse(raw)); result = `opened "${nm}"`; }
      } else if (req.originVaultSave) {
        // the `secrets` segment, encrypted with the passphrase, → /vault.env.enc.
        await ensureSegments(state, ["file-store"]);
        const backend = state.cels.get("file-store.backend")?.v;
        if (backend === "none" || backend === undefined) result = "(no filesystem here — the vault can't be written to a file; use =export(\"secrets\",\"encrypt\",pass) for a blob)";
        else {
          const pass = passOf(req.pass, "passphrase to encrypt the vault with");
          if (!pass) result = "#DENIED(vaultsave: a passphrase is required — =vaultsave(\"secret\"))";
          else {
            const archive = dumpArchive(state, "secrets");
            const blob = `${ENC_METHOD}:${await encryptPayload(archive, pass)}`;
            await (resolveFn(state, "fs.writeText") as Fn)("/vault.env.enc", blob);
            result = "saved the vault → /vault.env.enc (encrypted; find it in 📁 Files)";
          }
        }
      } else if (req.originVaultLoad) {
        await ensureSegments(state, ["file-store"]);
        const raw = await ((resolveFn(state, "fs.readText") as Fn)("/vault.env.enc") as Promise<string>).catch(() => null) as string | null;
        if (!raw) result = "(no /vault.env.enc — =vaultsave(\"secret\") first)";
        else {
          const pass = passOf(req.pass, "passphrase to decrypt the vault with");
          if (!pass) result = "#DENIED(vaultload: a passphrase is required — =vaultload(\"secret\"))";
          else {
            try {
              const json = raw.startsWith(`${ENC_METHOD}:`) ? await decryptPayload(raw.slice(ENC_METHOD.length + 1), pass) : raw;
              await loadArchive(state, json);
              await (resolveFn(state, "runCycle") as Fn)(state);
              result = "loaded the vault from /vault.env.enc — =unlockVault() to use the keys";
            } catch { result = "#DENIED(vaultload: wrong passphrase or corrupt /vault.env.enc)"; }
          }
        }
      } else if (req.originLink) {
        const t = String(req.target ?? "");
        const src = t ? cellSource(state, t) : buildSeed(state);
        result = await encodeLink(src, { base: String(req.base ?? "https://plastron.ca/"), codec: String(req.codec ?? "auto") as LinkCodec });
      } else if (req.originUnlink) {
        // decode ONLY — returns the formula source as text; does NOT execute it.
        result = await decodeLink(String(req.url ?? ""));
      } else if (req.originEncrypt) {
        const pass = passOf(req.passphrase, "passphrase to encrypt with");
        if (!pass) result = "#DENIED(encrypt: a passphrase is required)";
        else {
          const t = String(req.target ?? "");
          const src = t ? cellSource(state, t) : buildSeed(state);
          result = await encodeEncLink(src, pass, String(req.base ?? "https://plastron.ca/"));
        }
      } else if (req.originDecrypt) {
        // decode ONLY — returns the formula source as text; does NOT execute it.
        const pass = passOf(req.passphrase, "passphrase to decrypt with");
        if (!pass) result = "#DENIED(decrypt: a passphrase is required)";
        else {
          try { result = await decodeEncLink(String(req.url ?? ""), pass); }
          catch (e) { result = "#" + String((e as { message?: unknown })?.message ?? e); }
        }
      } else if (req.originKernel) {
        // spawn a quarantined child; its cells live under <seg>.*, gated
        // capabilities #DENIED unless the preset granted them.
        const preset = String(req.preset ?? "locked");
        const seg = await spawnQuarantined(state, String(req.seed ?? ""), preset);
        result = `spawned "${seg}" (${preset}) — a quarantined plastron; its cells live under ${seg}.*`;
      } else if (req.originJail) {
        // a sandboxed iframe running the seed as its own kernel. allow-scripts
        // WITHOUT allow-same-origin → opaque origin: storage throws, no parent
        // reach, no XSS against plastron.ca. It boots this page with #raw=<seed>.
        const loc = (globalThis as { location?: { href?: string } }).location;
        const base = loc?.href ? String(loc.href).split("#")[0] : "./";
        const src = `${base}#raw=${encodeURIComponent(String(req.seed ?? ""))}`;
        result = { type: "el", tag: "iframe", attrs: { sandbox: "allow-scripts", src, class: "pl-jail", style: "width:100%;height:100%;min-height:240px;border:0;border-radius:.4rem;background:Canvas" }, children: [] };
      } else if (req.originChat) {
        result = String(await (resolveFn(state, "llm.chat") as Fn)(req.prompt, req.key, req.model, req.url));
      } else if (req.originFs) {
        await ensureSegments(state, ["file-store"]);
        result = String(await (resolveFn(state, "fs.command") as Fn)(String(req.originFs), String(req.path ?? ""), req.to, req.text));
      } else if (req.originSeg) {
        // sheet manager — collectArchive ⇄ OPFS files under /plastron/sheets.
        await ensureSegments(state, ["file-store"]);
        const call = (k: string, ...a: unknown[]) => (resolveFn(state, k) as Fn)(...a);
        const DIR = "/plastron/sheets";
        const op = String(req.originSeg);
        const nm = String(req.name ?? "");
        const file = `${DIR}/${nm}.json`;
        if (op === "list") {
          const names = ((await (call("fs.list", DIR) as Promise<string[]>).catch(() => [])) as string[])
            .filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort();
          result = names.length ? names.join("\n") : `(no saved sheets — =saveSeg("name") to store one)`;
        } else if (op === "save") {
          if (!nm) result = `(saveSeg: give it a name, e.g. =saveSeg("budget"))`;
          else { await call("fs.mkdir", DIR); await call("fs.writeText", file, JSON.stringify(collectArchive(state))); result = `saved sheet "${nm}" → OPFS ${file}`; }
        } else if (op === "open") {
          const raw = await (call("fs.readText", file) as Promise<string>).catch(() => null);
          if (!raw) result = `(no saved sheet "${nm}" — =segs() to list)`;
          else { await restoreArchive(state, JSON.parse(raw)); result = `opened sheet "${nm}"`; }
        } else if (op === "del") {
          await call("fs.delete", file); result = `deleted sheet "${nm}"`;
        } else result = `(unknown seg op: ${op})`;
      } else if (req.originDb) {
        result = await (resolveFn(state, "sqlite.command") as Fn)(state, String(req.originDb), String(req.name ?? "main"), String(req.query ?? ""));
      } else if (req.originGraph !== undefined) {
        // force-directed graph of a segment's cels (nodes) + inputMap deps (edges)
        const seg = String(req.originGraph);
        const prefix = `${seg}.`;
        const nodeKeys: string[] = [];
        for (const [k, c] of state.cels) {
          if (!k.startsWith(prefix) || !/[A-Z]+\d+$/.test(k)) continue;
          if (c.celType !== "ValueCel" && c.celType !== "FormulaCel") continue;
          nodeKeys.push(k);
        }
        nodeKeys.sort();
        if (!nodeKeys.length) { result = `(no grid cels in "${seg}" — interlinked graphs a grid segment, e.g. =interlinked("g3x1"))`; }
        else {
          const idx = new Map(nodeKeys.map((k, i) => [k, i]));
          const edges: [number, number][] = [];
          for (let i = 0; i < nodeKeys.length; i++) {
            const im = state.cels.get(nodeKeys[i]!)?.metadata.inputMap as Record<string, Key | Key[]> | undefined;
            if (!im) continue;
            for (const dep of Object.values(im).flat()) {
              const j = idx.get(String(dep));
              if (j !== undefined && j !== i) edges.push([i, j]);
            }
          }
          const w = 440, h = 320;
          const pos = forceLayout(nodeKeys.length, edges, w, h);
          const ops: unknown[] = [];
          for (const [i, j] of edges) ops.push({ op: "line", points: [[pos[i]!.x, pos[i]!.y], [pos[j]!.x, pos[j]!.y]], stroke: "rgba(120,120,150,.6)", lineWidth: 1 });
          for (let i = 0; i < nodeKeys.length; i++) {
            ops.push({ op: "circle", x: pos[i]!.x, y: pos[i]!.y, r: 14, fill: "#4a90d9", stroke: "#fff", lineWidth: 2 });
            const label = nodeKeys[i]!.slice(prefix.length);
            ops.push({ op: "text", x: pos[i]!.x - label.length * 3, y: pos[i]!.y + 4, text: label, fill: "#fff", font: "11px sans-serif" });
          }
          result = { type: "el", tag: "canvas", attrs: { width: w, height: h, "data-ops": JSON.stringify(ops) }, children: [] };
        }
      } else if (req.originSim) {
        // run a def'd frame fn (i → [x, y]) n times, play it back on canvas.
        const fnName = String(req.fn ?? "");
        const frameFn = resolveFn(state, fnName) as Fn | undefined;
        if (!frameFn) { result = `(simulate: no function "${fnName}" — =def("ball","js","i => [x, y]") first, then =simulate("ball", 120))`; }
        else {
          const count = Number(req.n) || 120;
          const frames: [number, number][] = [];
          for (let i = 0; i < count; i++) {
            const p = (await frameFn(i)) as number[] | { x?: unknown; y?: unknown };
            if (Array.isArray(p)) frames.push([Number(p[0]) || 0, Number(p[1]) || 0]);
            else frames.push([Number((p as { x?: unknown })?.x) || 0, Number((p as { y?: unknown })?.y) || 0]);
          }
          const w = 360, h = 280;
          const ops = [{ op: "frames", frames, r: Number(req.r) || 12, fill: "#e91e63", period: 4, box: "rgba(255,255,255,.25)" }];
          result = { type: "el", tag: "canvas", attrs: { width: w, height: h, "data-ops": JSON.stringify(ops) }, children: [] };
        }
      } else continue;
      // Carry forward ownership/name stamps — an introspection result lands
      // back IN the requesting cell, and if that's a grid cell, dropping
      // `generatedBy` orphans it (the next commit's genesis then refuses to
      // re-own it). Same stamps `commit` preserves.
      const pm = cel.metadata as { segment?: string; name?: string; generatedBy?: Key; definedBy?: Key; origin?: Key };
      const keep: Record<string, unknown> = { segment: pm.segment };
      if (pm.name) keep.name = pm.name;
      if (pm.generatedBy) keep.generatedBy = pm.generatedBy;
      if (pm.definedBy) keep.definedBy = pm.definedBy;
      if (pm.origin) keep.origin = pm.origin;
      await setCel(state, cel.metadata.key, { celType: "ValueCel", v: result, metadata: keep });
    } catch (e) {
      const err = makeCelError([cel.metadata.key], "OriginError", e);
      appendError(state, err);
      cel.v = err;
    }
  }
};

export const name = "origin" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["view.refresh",   viewRefreshFn],
  ["mount",          mount],
  ["origin.run",  commit],
  ["origin.edit",    edit],
  ["origin.select",  select],
  ["origin.fire",    fire],
  ["origin.key",     key],
  ["cels",           celsGen],
  ["at",             at],
  ["geom",           geomFn],
  ["segment",        doc],   // primary (was doc — composes a SEGMENT)
  ["doc",            doc],   // deprecated legacy alias
  ["seed",           seedFn],
  ["export",         exportFn],
  ["import",         importFn],
  ["origin.drain",   effectsDrain],
  ["members",        celsFn],
  ["inspect",        inspectFn],
  ["segments",       segmentsFn],
  ["vocab",          vocabFn],
  ["viewport",       viewportFn],
  ["origin.viewportSync", viewportSync],
  ["origin.clockSync", clockSync],
  ["nav",            navFn],
  ["item",           itemFn],
  ["navpanel",       navpanelFn],
  ["navpanelbar",    navpanelbarFn],
  ["origin.navOpen", navOpenFn],
  ["origin.opennav", opennav],
  ["origin.seedStarter", seedStarter],
  ["origin.reseed",   reseed],
  ["def",            defFn],
  ["chat",           chatFn],
  ["grok",           grokFn],
  ["link",           linkFn],
  ["unlink",         unlinkFn],
  ["encrypt",        encryptFn],
  ["decrypt",        decryptFn],
  ["otpEncrypt",     otpEncryptFn],
  ["otpDecrypt",     otpDecryptFn],
  ["otpLoader",      otpLoaderFn],
  ["origin.otpEncrypt", otpEncryptHandler],
  ["origin.otpDecrypt", otpDecryptHandler],
  ["origin.otpUnlock",  otpUnlockHandler],
  ["kernel",         kernelFn],
  ["jail",           jailFn],
  ["jailask",        jailAskFn],
  ["jail.serve",     jailServeFn],
  ["consentdom", consentdomFn],
  ["consentpanel", consentpanelFn],
  ["origin.consentToggle", consentToggle],
  ["origin.consentSync", consentSync],
  ["origin.savepage", download],
  ["origin.tone",    tone],
  ["origin.music",   music],
  ["origin.compose", compose],
  ["origin.composeStop", composeStop],
  ["origin.playmelody", playmelody],
  ["cdn",            cdnFn],
  ["ls",             lsFn],
  ["tree",           treeFn],
  ["mkdir",          mkdirFn],
  ["rm",             rmFn],
  ["mv",             mvFn],
  ["cat",            catFn],
  ["write",          fsWriteFn],
  ["touch",          touchFn],
  ["stat",           statFn],
  ["segs",           segsFn],
  ["saveSeg",        saveSegFn],
  ["openSeg",        openSegFn],
  ["delSeg",         delSegFn],
  ["downloadSeg",    downloadSegFn],
  ["db",             dbFn],
  ["sql",            sqlFn],
  ["tables",         tablesFn],
  ["dbseed",         dbSeedFn],
  ["schema",         schemaFn],
  ["dbexport",       dbExportFn],
  ["dbimport",       dbImportFn],
  ["interlinked",    interlinkedFn],
  ["simulate",       simulateFn],
  ["dragdrop",       dragdropFn],
  ["save",           saveFn],
  ["open",           openFn],
  ["vaultsave",      vaultSaveFn],
  ["vaultload",      vaultLoadFn],
]));
