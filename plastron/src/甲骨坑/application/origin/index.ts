import type {
  甲骨, Cel, ChannelEnqueue, Fn, Key, State, VNode, AttrValue, EventBinding,
} from "../../../types/index.js";
import {
  bindNativeFns, resolveFn, ensureSegments, appendError, makeCelError, canUse, setTrust,
} from "../../../kernel/index.js";
// Core rendering comes from the dom LIBRARY — the app doesn't re-roll
// vnode building, diffing, or the memo. `el`/`text` build the canonical VNode;
// `memo` attaches the diff's O(changed) short-circuit hint (see dom).
import { el as makeEl, text as T } from "../../library/dom/index.js";
import { openAsSheet } from "../../library/sheet-host/index.js";
import { encodeLink, decodeLink, type LinkCodec } from "./share-link.js";
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

const isAt = (x: unknown): x is { __at: string; content: unknown } => !!x && typeof x === "object" && typeof (x as { __at?: unknown }).__at === "string";
const isValues = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x) && !isAt(x);

// at(addr, content) — one cell's initial content for a cels() grid. A plain
// function call (no new parser syntax). cels collects trailing at() markers.
const at: Fn = (addr?: unknown, content?: unknown) => ({ __at: String(addr ?? ""), content: content == null ? "" : String(content) });

// gather a values map from an optional {object} and/or trailing at() markers.
const collectValues = (args: unknown[], i: number): [Record<string, unknown> | undefined, number] => {
  const values: Record<string, unknown> = {};
  if (isValues(args[i])) { Object.assign(values, args[i]); i++; }
  while (isAt(args[i])) { const a = args[i] as { __at: string; content: unknown }; values[a.__at] = a.content; i++; }
  return [Object.keys(values).length ? values : undefined, i];
};

/** cels — a genesis vocabulary that adds worksheets of editable cels, each
 *  like 元. Shapes from ONE formula:
 *    cels(rows, cols)              → one sheet, auto-named g<r>x<c>
 *    cels(rows, cols, "name")      → one named sheet
 *    cels("in", 4, 3, "out", 4, 3) → a WORKBOOK of named sheets
 *    cels("in", 4, 3, at("a1","apple"), at("b2","=1+1"))  → a sheet
 *      with initial cell contents (a value, or a formula like =1+1).
 *  Delete the formula → swept. */
// SHEET_CLOSURE — every cels() worksheet mints a CLOSURE: only the host view
// (`origin`, which aggregates every cell's value to render the grid) may read it;
// a formula in ANOTHER sheet/window can't, so cross-sheet reads are denied unless
// the two sheets are tabbed together (tabbing → bundleSegments, the one opener —
// the turtles pattern). set stays private (only the sheet itself writes). Listing
// `origin` rather than going fully `private` keeps the renderer working while
// still closing the sheet to every peer formula.
const SHEET_CLOSURE = { get: ["origin"], set: "private" } as const;
const celsGen: Fn = (...args: unknown[]): unknown => {
  if (typeof args[0] === "string") {
    // workbook: (name, rows, cols [, at()…])+ — at() markers belong to the
    // preceding grid; the next string starts the next grid. A workbook's sheets
    // all land in the generator's own segment (one closure), so they share memory.
    const cels: Record<string, unknown> = {};
    let i = 0, n = 0;
    while (i < args.length && typeof args[i] === "string") {
      const nm = String(args[i]).trim() || `s${++n}`;
      const [values, ni] = collectValues(args, i + 3);
      Object.assign(cels, gridShape(args[i + 1], args[i + 2], nm, values).cels);
      i = ni;
    }
    return { genesis: true, cels };
  }
  // numbers → one sheet: (rows, cols [, name] [, at()…]).
  const [rows, cols] = args;
  const named = typeof args[2] === "string" && args[2] !== "";
  const name = named ? String(args[2])
    : `g${Math.max(1, Math.min(100, Math.floor(Number(rows) || 1)))}x${Math.max(1, Math.min(50, Math.floor(Number(cols) || 1)))}`;
  const [values] = collectValues(args, named ? 3 : 2);
  // each standalone named sheet is its OWN private closure.
  return { genesis: true, ...gridShape(rows, cols, name, values), access: SHEET_CLOSURE };
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
  const stamp = (partCels: Record<string, unknown>, layer: string, access: unknown): void => {
    for (const spec of Object.values(partCels)) {
      const sp = spec as { metadata?: Record<string, unknown> };
      sp.metadata = { ...(sp.metadata ?? {}), segment: layer };   // this part's cels belong to ITS segment
    }
    mints[layer] = (access && typeof access === "object") ? access : {};
  };
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (o.genesis === true && o.cels) {                                                  // cels(…)/winapp(…)/chatapp(…)
      if (typeof o.layer === "string") stamp(o.cels as Record<string, unknown>, o.layer, o.access);
      Object.assign(cels, o.cels);
    } else if (o.cels && o.layer) {                                                       // gridShape direct
      stamp(o.cels as Record<string, unknown>, String(o.layer), o.access);
      Object.assign(cels, o.cels as Record<string, unknown>);
    } else if (o.originDef === true) cels[String(o.name)] = { celType: "EditableLambdaCel", f: String(o.source ?? ""), metadata: { kind: String(o.kind ?? "js"), name: String(o.name) } };
  }
  return { genesis: true, cels, mints };
};

// seed() — ask the drain (which has state) to serialize the whole document to a
// single recreating formula. Callable from ANY cel; its value becomes the source.
const seedFn: Fn = () => ({ originSeed: true });

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
    // grid cels (genesis-owned). win.* layer cels (state/content/frame) are
    // first-class desktop cells even when handler-created (no generatedBy) —
    // e.g. the wiki window. The link-edge overlay (linkfx.overlay) is a
    // desktop-wide mount too, so it survives 元 re-renders and keeps drawing
    // the corner-link edges.
    if (md.generatedBy || /^win\.[\w-]+\.(state|content|frame)$/.test(k) || k === "linkfx.overlay") out.push(k);
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
// (#17 render half — the abandoned walletKeys worksheet, future windows).
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

// A click that lands on a form control a formula rendered INSIDE a cell (a
// password box from =unlockWallet(), a file picker from =upload(), a button)
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
    [["元.editing", next], ["元.draft", next ? cellSource(state, next) : ""], ["元.error", null]]);
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
    [["元.selected", key], ["元.draft", cellSource(state, key)], ["元.error", null]]);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
};

// fire — re-evaluate (recompute) the selected cell. A FormulaCel re-applies its
// source through setValue (which recompiles + re-cascades); a ValueCel re-writes
// its own value (a harmless re-cascade that repaints dependents). The 🔫 button
// on the formula bar dispatches this.
const fire: Fn = async (state: State, payload?: unknown) => {
  const key = typeof payload === "string" && payload ? payload
    : String(state.cels.get("元.selected")?.v ?? "");
  if (!key) return state;
  const c = state.cels.get(key);
  if (!c) return state;
  const setValue = resolveFn(state, "setValue") as Fn;
  const f = (c as { f?: string }).f;
  await setValue(state, key, f !== undefined ? f : c.v);
  // drain whatever it produces: a GENESIS (e.g. 元) re-materializes its windows +
  // cels, so firing 元 rebuilds the desktop (recovery). Mirrors commit's loop.
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
    if (state.cels.size === before) break;
  }
  await rewireView(state, cellKeys(state));
  await (resolveFn(state, "runCycle") as Fn)(state);
  await drain(state, "dom.paint");
  return state;
};

// ex(formula, target) — a try-it payload: the formula to run and the cell key
// it should land in. Authored in each readme ROW's ⚡ button, where target is
// that ROW's OWN B cell: (on "click" "tryexample" (ex "=1+1" "readme.B2")).
// Per-row targets keep the def/use examples from clobbering each other.
// Returns a marker the painter hands to tryexample verbatim (no serialization).
const ex: Fn = (formula?: unknown, target?: unknown) =>
  ({ __ex: { formula: String(formula ?? ""), target: String(target ?? "") } });

// tryexample — the readme "try it" handler. Copies an example's formula into a
// scratch cell beside the readme and evaluates it, so clicking the ⚡ shows the
// result. Reuses commit (seed 元.draft → commit(target)): commit sniffs the
// source into a FormulaCel, writes it to the target, re-evaluates and repaints.
const tryexample: Fn = async (state: State, payload?: unknown) => {
  const p = payload as { __ex?: { formula?: unknown; target?: unknown } } | undefined;
  const formula = p && typeof p === "object" && p.__ex ? String(p.__ex.formula ?? "") : "";
  const target = p && typeof p === "object" && p.__ex ? String(p.__ex.target ?? "") : "";
  if (!target) return state;
  await (resolveFn(state, "setValue") as Fn)(state, "元.draft", formula);
  await commit(state, target);
  return state;
};

/** commit — set the edited cell's content from the draft and re-evaluate.
 *  Every cell (元 included) executes its formula/value like A1. 元 is
 *  un-deletable: clearing it restores the readme. A structure formula
 *  (=grid …) makes more cels; the post-drain rebuild adds them. */
const commit: Fn = async (state: State, payload?: unknown) => {
  const key = typeof payload === "string" ? payload : "元";
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
  // …rebuild the cell list (new grids in, swept cels out), re-fire, paint.
  await rewireView(state, cellKeys(state));
  // a SEEDED tab (win.geom[seg].host) must grant shared memory like a runtime
  // drop — bundle each host clique so a tabbed private sheet reads its host
  // (turtlecharts reads turtles!). Idempotent; safe to call every commit.
  const sync = resolveFn(state, "winsheet.syncBundles") as Fn | undefined;
  if (sync) await sync(state);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await drain(state, "dom.paint");
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

// ── persistence — save the sheet to localStorage; auto-load it on boot ───────
// A "sheet archive" is just the cell SOURCES (元.cells) + any def'd functions.
// Replaying them reconstructs the sheet (grids regenerate, values + formulas
// come back). The full .甲 graph archive is the eventual path; this round-trips
// the origin's own data today without a user-space-segment refactor.

const LS = (): Storage | undefined => (globalThis as { localStorage?: Storage }).localStorage;
const slot = (name?: unknown): string => `plastron.sheet.${String(name || "default") || "default"}`;

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
const qstr = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
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
// link(target?, base?, codec?) — a shareable URL that rebuilds a plastron from the
// page address. target "" → the whole sheet (buildSeed); a cell key → its source.
const linkFn: Fn = (target?: unknown, base?: unknown, codec?: unknown) =>
  ({ originLink: true, target: target == null ? "" : String(target),
     base: base == null ? "https://plastron.ca/" : String(base),
     codec: codec == null ? "auto" : String(codec) });
const unlinkFn: Fn = (url?: unknown) => ({ originUnlink: true, url: String(url ?? "") });
// kernel(seed, preset?) — spawn a QUARANTINED child plastron from a seed formula
// in a fresh segment. The preset is the child's grant, capped by THIS kernel's
// trust at resolve time (kernel ∧ segment). A #f= URL is a "locked" seed.
const TRUST_PRESETS: Record<string, Record<string, unknown>> = {
  locked:  { code: false, net: false, storage: false, secrets: false, segments: [] },
  compute: { code: true,  net: false, storage: false, secrets: false, segments: [] },
  net:     { code: true,  net: true,  storage: false, secrets: false, segments: [] },
  trusted: { code: true,  net: true,  storage: true,  secrets: true },
};
const kernelFn: Fn = (seed?: unknown, preset?: unknown) =>
  ({ originKernel: true, seed: String(seed ?? ""), preset: preset == null ? "locked" : String(preset) });
/** origin.autoload — restore the default slot on boot (the host calls this). */
const autoload: Fn = async (state: State): Promise<State> => {
  const raw = LS()?.getItem(slot());
  if (raw) { try { await restoreArchive(state, JSON.parse(raw)); } catch { /* corrupt save — ignore */ } }
  return state;
};

// decode a data:<mime>;base64,<payload> URI into [bytes, extension].
const dataUriToBytes = (uri: string): { bytes: Uint8Array; ext: string } | null => {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  const mime = m[1] ?? "", isB64 = !!m[2], payload = m[3] ?? "";
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : mime === "image/svg+xml" ? "svg" : (mime.split("/")[1] || "bin");
  let bytes: Uint8Array;
  if (isB64) {
    const bin = (globalThis as { atob?: (s: string) => string }).atob?.(payload) ?? Buffer.from(payload, "base64").toString("binary");
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return { bytes, ext };
};

/** origin.seedWallpaper — write the shipped wallpaper (windows.wallpaper, a
 *  data-URI) into an OPFS FILE and point desktop.A2 (the wallpaper-path cell)
 *  at it, so the desktop background now LOADS FROM A FILE in OPFS instead of a
 *  hard-coded constant. Idempotent: writes only if the file is missing, and
 *  only re-points A2 when it still holds the empty default (a user's own
 *  uploaded path is preserved). Host-called once after boot. */
const seedWallpaper: Fn = async (state: State): Promise<State> => {
  const backend = state.cels.get("file-store.backend")?.v;
  if (backend === "none" || backend === undefined) return state;       // no fs here — keep the constant fallback
  const uri = String(state.cels.get("windows.wallpaper")?.v ?? "");
  if (!uri.startsWith("data:")) return state;
  const decoded = dataUriToBytes(uri);
  if (!decoded) return state;
  const path = `/desktop/wallpaper.${decoded.ext}`;
  await ensureSegments(state, ["file-store"]);
  const exists = (await ((resolveFn(state, "fs.exists") as Fn)(path) as Promise<boolean>).catch(() => false)) as boolean;
  if (!exists) {
    await (resolveFn(state, "fs.mkdir") as Fn)("/desktop");
    await (resolveFn(state, "fs.write") as Fn)(path, decoded.bytes);
  }
  // point the desktop's wallpaper-path cell at the OPFS file (only if it still
  // holds the empty default — don't clobber a user-set path).
  const a2 = state.cels.get("desktop.A2");
  if (a2 && (a2.v === "" || a2.v == null)) {
    await (resolveFn(state, "setValue") as Fn)(state, "desktop.A2", path);
    await (resolveFn(state, "runCycle") as Fn)(state);
    await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  }
  return state;
};

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

// ── origin.effects: load / cels requests (effects at drain) ─────────────────

// Introspection vocabulary. Each returns a REQUEST; the effects drain
// (which has `state`) does the read — formula fns only get input values,
// not state, so a graph read can't be a plain fn. The drain replaces
// the requesting cell with a ValueCel holding the result.
const loadFn: Fn = (name: unknown) => ({ originLoad: true, name: String(name ?? "") });
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

// --- explorer(cwd, preview, listing) — a PURE OPFS file-browser render. It
//     takes the navigation state (cwd / preview path) plus a `listing`
//     ({ entries: {name,isDir}[], previewText }) and builds the folders-then-
//     files vnode. The async OPFS reads live in the nav/open handlers (which
//     write explorer.listing); this fn is pure so the WINDOW's content formula
//     `(explorer explorer.cwd explorer.preview explorer.listing)` re-fires
//     reactively when any of those cels change (inputMap doctrine). ---
const parentPath = (p: string): string => {
  const norm = "/" + p.split("/").filter(Boolean).join("/");
  if (norm === "/") return "/";
  const i = norm.lastIndexOf("/");
  return i <= 0 ? "/" : norm.slice(0, i);
};
// --- binary-preview guard. Never text-preview a binary/huge file (decoding
//     megabytes of bytes into a string blows out browser memory). A file is
//     "previewable text" only when its extension isn't a known binary one AND
//     it's under PREVIEW_MAX_BYTES AND its bytes are valid UTF-8.
const PREVIEW_MAX_BYTES = 256 * 1024;
const BINARY_EXTS = new Set([
  "wasm", "wad", "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif",
  "zip", "甲", "xlsx", "xls", "pdf", "gz", "tar", "br", "db", "sqlite",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "wav", "ogg", "mov", "webm",
]);
const fileExt = (path: string): string => {
  const base = path.split("/").pop() || path;
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
};
const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
// strict UTF-8 validity probe (TextDecoder with fatal:true throws on invalid bytes)
const isValidUtf8 = (bytes: Uint8Array): boolean => {
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; }
  catch { return false; }
};
const joinPath = (dir: string, name: string): string =>
  (dir === "/" ? "" : dir.replace(/\/+$/, "")) + "/" + name;
// per-file action button (🗑 / ✎ / ⬇) — a small dispatch control beside a file
const feAction = (icon: string, title: string, dispatch: string, payload: string): V =>
  el("button", { class: "fe-act", type: "button", title, style: "border:0;background:transparent;cursor:pointer;font-size:.8rem;padding:0 .15rem;line-height:1" },
    [T(icon)], { click: { dispatch, payload } });
const renderExplorer = (cwd: string, entries: { name: string; isDir: boolean }[], preview: string, previewText: string, previewBinary: boolean): V => {
  const rowStyle = "display:flex;align-items:center;gap:.4rem;padding:.25rem .4rem;border-radius:.3rem;cursor:pointer;font:.82rem ui-monospace,monospace";
  const rows: V[] = [];
  if (cwd !== "/") {
    rows.push(el("div", { class: "fe-row fe-up", style: rowStyle + ";opacity:.8" },
      [T("📁 ..")], { click: { dispatch: "origin.explorerNav", payload: parentPath(cwd) } }));
  }
  for (const e of entries) {
    const full = joinPath(cwd, e.name);
    if (e.isDir) {
      rows.push(el("div", { class: "fe-row fe-dir", style: rowStyle },
        [T(`📁 ${e.name}/`)], { click: { dispatch: "origin.explorerNav", payload: full } }));
    } else {
      // file row: clickable name (preview) + per-file actions (delete/rename/download)
      rows.push(el("div", { class: "fe-row fe-file" + (full === preview ? " fe-sel" : ""), style: rowStyle + (full === preview ? ";background:#4a90d955" : "") },
        [el("span", { class: "fe-name", style: "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" },
           [T(`📄 ${e.name}`)], { click: { dispatch: "origin.explorerOpen", payload: full }, dblclick: { dispatch: "origin.explorerOpenSheet", payload: full } }),
         el("span", { class: "fe-acts", style: "display:flex;gap:.1rem;flex:0 0 auto" }, [
           feAction("🗑", `delete ${e.name}`, "origin.explorerDelete", full),
           feAction("✎", `rename ${e.name}`, "origin.explorerRename", full),
           feAction("⬇", `download ${e.name}`, "origin.explorerDownload", full),
         ])]));
    }
  }
  if (!entries.length) rows.push(el("div", { style: "opacity:.6;padding:.3rem;font:.8rem ui-monospace,monospace" }, [T("(empty)")]));
  const left: V[] = [
    el("div", { class: "fe-bar", style: "display:flex;align-items:center;gap:.4rem;padding:.25rem .4rem;border-bottom:1px solid #8884;font:600 .8rem ui-monospace,monospace" },
      [T(`📂 ${cwd}`)]),
    el("div", { class: "fe-list", style: "flex:1 1 auto;overflow:auto;padding:.2rem" }, rows),
    el("div", { class: "fe-upload", style: "padding:.3rem .4rem;border-top:1px solid #8884;font:.75rem system-ui" },
      [T("upload here: "), el("input", { class: "opfs-upload", type: "file", title: `upload into ${cwd}` }, [], { change: { dispatch: "origin.upload", payload: cwd } })]),
  ];
  // preview body: a binary/oversize file shows a placeholder + download button
  // (never the bytes); a text file shows its content in a <pre>.
  const previewBody: V[] = previewBinary
    ? [el("div", { class: "fe-binary", style: "flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.6rem;padding:1rem;text-align:center;font:.8rem system-ui;opacity:.85" },
        [T(previewText), el("button", { class: "opfs-btn fe-dl", type: "button", title: `download ${preview}` },
           [T(`⬇ download ${preview.split("/").pop() || preview}`)], { click: { dispatch: "origin.explorerDownload", payload: preview } })])]
    : [el("pre", { style: "flex:1 1 auto;overflow:auto;margin:0;padding:.4rem;font:.78rem ui-monospace,monospace;white-space:pre-wrap;word-break:break-word" }, [T(previewText)])];
  const right: V[] = preview
    ? [el("div", { class: "fe-preview", style: "flex:1 1 50%;min-width:0;border-left:1px solid #8884;display:flex;flex-direction:column" },
        [el("div", { style: "padding:.25rem .4rem;border-bottom:1px solid #8884;font:600 .78rem ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, [T(preview.split("/").pop() || preview)]),
         ...previewBody])]
    : [];
  return el("div", { class: "file-explorer", style: "display:flex;height:100%;min-height:0" },
    [el("div", { class: "fe-pane", style: "flex:1 1 50%;min-width:0;display:flex;flex-direction:column" }, left), ...right]);
};
const explorerFn: Fn = (cwd?: unknown, preview?: unknown, listing?: unknown): V => {
  const c = cwd == null || cwd === "" ? "/" : String(cwd);
  const pv = preview == null ? "" : String(preview);
  const lst = (listing && typeof listing === "object") ? listing as { entries?: { name: string; isDir: boolean }[]; previewText?: string; previewBinary?: boolean } : {};
  return renderExplorer(c, Array.isArray(lst.entries) ? lst.entries : [], pv, String(lst.previewText ?? ""), !!lst.previewBinary);
};

// explorerListing — the async OPFS read the nav/open handlers share: list the
// cwd (fs.list + fs.stat), sort folders-first, and cat the preview file. Lands
// as explorer.listing, which the content formula references → reactive repaint.
const explorerListing = async (state: State, cwd: string, preview: string): Promise<{ entries: { name: string; isDir: boolean }[]; previewText: string; previewBinary: boolean }> => {
  await ensureSegments(state, ["file-store"]);
  const list = resolveFn(state, "fs.list") as Fn, fstat = resolveFn(state, "fs.stat") as Fn;
  const names = ((await (list(cwd) as Promise<string[]>).catch(() => [])) as string[]).slice();
  const entries: { name: string; isDir: boolean }[] = [];
  for (const n of names) {
    const st = (await (fstat(joinPath(cwd, n)) as Promise<{ isDir?: boolean }>).catch(() => null)) as { isDir?: boolean } | null;
    entries.push({ name: n, isDir: !!st?.isDir });
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  let previewText = "", previewBinary = false;
  if (preview) {
    const ext = fileExt(preview);
    const st = (await ((fstat(preview)) as Promise<{ size?: number; isDir?: boolean }>).catch(() => null)) as { size?: number; isDir?: boolean } | null;
    const size = Number(st?.size ?? 0);
    if (BINARY_EXTS.has(ext) || size > PREVIEW_MAX_BYTES) {
      // known-binary extension or oversize → never read it as text (memory).
      previewBinary = true;
      previewText = `binary file — ${ext || "no ext"}, ${fmtBytes(size)} — ⬇ download to inspect`;
    } else {
      // small + non-binary-ext: read RAW bytes and only decode if valid UTF-8.
      const bytes = (await ((resolveFn(state, "fs.read") as Fn)(preview) as Promise<Uint8Array>).catch(() => null)) as Uint8Array | null;
      if (bytes == null) { previewBinary = true; previewText = "(cannot read file)"; }
      else if (!isValidUtf8(bytes)) { previewBinary = true; previewText = `binary file — ${ext || "no ext"}, ${fmtBytes(bytes.byteLength)} — ⬇ download to inspect`; }
      else previewText = new TextDecoder("utf-8").decode(bytes);
    }
  }
  return { entries, previewText, previewBinary };
};

// --- segment/sheet manager — persist the WHOLE sheet (the collectArchive
//     form save()/open() use) to OPFS files under /plastron/sheets, so work
//     survives across machines as real files (vs save()'s localStorage). ---
const segsFn:    Fn = () => ({ originSeg: "list" });
const saveSegFn: Fn = (name: unknown) => ({ originSeg: "save", name: String(name ?? "") });
const openSegFn: Fn = (name: unknown) => ({ originSeg: "open", name: String(name ?? "") });
const delSegFn:  Fn = (name: unknown) => ({ originSeg: "del",  name: String(name ?? "") });

// --- upload / download — a cel becomes a button / file input that moves bytes
//     between OPFS and the user's disk. The formula returns a vnode VALUE (like
//     dom()); its dispatch handler runs in the browser (click/change), where
//     Blob/File/URL exist. The genuinely new plumbing for opfs-formulas. ---
const downloadFn: Fn = (path: unknown): V => {
  const p = String(path ?? "");
  return el("button", { class: "opfs-btn", type: "button", title: `download ${p}` },
    [T(`⬇ ${p.split("/").pop() || p}`)], { click: { dispatch: "origin.download", payload: p } });
};
const downloadSegFn: Fn = (name: unknown): V => downloadFn(`/plastron/sheets/${String(name ?? "")}.json`) as V;
const uploadFn: Fn = (path?: unknown): V => {
  const dir = path == null || path === "" ? "/" : String(path);
  return el("input", { class: "opfs-upload", type: "file", title: `upload into ${dir}` },
    [], { change: { dispatch: "origin.upload", payload: dir } });
};

// dispatch targets — called (state, payload, event) on click/change.
type DomDownload = {
  document?: { createElement(t: string): { href: string; download: string; click(): void; remove(): void }; body: { appendChild(n: unknown): void } };
  URL?: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void };
  Blob?: new (parts: unknown[]) => unknown;
};
const downloadHandler: Fn = async (stateArg: unknown, path: unknown) => {
  const state = stateArg as State;
  const g = globalThis as DomDownload;
  if (!g.document || !g.URL || !g.Blob) return state;
  await ensureSegments(state, ["file-store"]);
  const p = String(path ?? "");
  const bytes = (await (resolveFn(state, "fs.read") as Fn)(p)) as Uint8Array;
  const url = g.URL.createObjectURL(new g.Blob([bytes]));
  const a = g.document.createElement("a");
  a.href = url; a.download = p.split("/").pop() || "download";
  g.document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => g.URL!.revokeObjectURL(url), 1000);
  return state;
};
const uploadHandler: Fn = async (stateArg: unknown, dir: unknown, event: unknown) => {
  const state = stateArg as State;
  await ensureSegments(state, ["file-store"]);
  const file = (event as { target?: { files?: ArrayLike<{ name: string; arrayBuffer(): Promise<ArrayBuffer> }> } })?.target?.files?.[0];
  if (!file) return state;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const d = String(dir ?? "/");
  const dest = (d === "/" ? "" : d.replace(/\/+$/, "")) + "/" + file.name;
  await (resolveFn(state, "fs.write") as Fn)(dest, bytes);
  // refresh the explorer (if open) so the freshly-uploaded file shows up.
  if (state.cels.get("explorer.cwd")) await refreshExplorer(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
};

// setOrCreate — write a value cel (used by the explorer nav state cels). Creates
// it under the explorer's window segment if the explorer window isn't seeded.
const setOrCreate = async (state: State, key: string, v: unknown): Promise<void> => {
  if (state.cels.get(key)) await (resolveFn(state, "setValue") as Fn)(state, key, v);
  else await (resolveFn(state, "setCel") as Fn)(state, key, { celType: "ValueCel", v, metadata: { key, segment: "win.explorer" } });
};

// refreshExplorer — recompute explorer.listing from the current cwd/preview and
// write it back. The content formula `(explorer explorer.cwd explorer.preview
// explorer.listing)` references explorer.listing, so this write re-fires the
// render through the graph (no hand-rolled repaint of the formula itself).
const refreshExplorer = async (state: State): Promise<void> => {
  const cwd = String(state.cels.get("explorer.cwd")?.v ?? "/") || "/";
  const preview = String(state.cels.get("explorer.preview")?.v ?? "");
  const listing = await explorerListing(state, cwd, preview);
  await setOrCreate(state, "explorer.listing", listing);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
};

// explorerNav — descend into a folder (or climb via a "/parent" payload). Sets
// explorer.cwd, clears the preview, recomputes the listing. The explorer window
// content formula references explorer.cwd/listing, so it re-fires reactively.
const explorerNav: Fn = async (stateArg: unknown, path: unknown) => {
  const state = stateArg as State;
  const p = String(path ?? "/") || "/";
  await setOrCreate(state, "explorer.cwd", p);
  await setOrCreate(state, "explorer.preview", "");
  await refreshExplorer(state);
  return state;
};

// explorerOpen — preview a file: set explorer.preview and recompute the listing
// (which cats the file into previewText). Reactive via explorer.listing.
const explorerOpen: Fn = async (stateArg: unknown, path: unknown) => {
  const state = stateArg as State;
  await setOrCreate(state, "explorer.preview", String(path ?? ""));
  await refreshExplorer(state);
  return state;
};

// explorerOpenSheet — double-click a file in the explorer: a .csv/.xlsx/.甲 file
// OPENS as a new sheet WINDOW (read its OPFS bytes → openAsSheet, which detects
// the format by extension and materializes a standalone sheet window). Any other
// file falls back to the text-preview behavior.
const SHEET_EXTS = new Set(["csv", "xlsx", "xls", "甲"]);
const explorerOpenSheet: Fn = async (stateArg: unknown, path: unknown) => {
  const state = stateArg as State;
  const p = String(path ?? "");
  if (!SHEET_EXTS.has(fileExt(p))) return explorerOpen(state, p);   // not a sheet → preview
  await ensureSegments(state, ["file-store"]);
  const bytes = (await ((resolveFn(state, "fs.read") as Fn)(p) as Promise<Uint8Array>).catch(() => null)) as Uint8Array | null;
  if (!bytes) return state;
  await openAsSheet(state, bytes, p.split("/").pop() || p);
  return state;
};

// origin.explorerRefresh — populate explorer.listing for the current cwd. The
// host calls it once at boot so the explorer window shows its initial listing
// (the nav/open handlers refresh it thereafter).
const explorerRefresh: Fn = async (stateArg: unknown) => {
  const state = stateArg as State;
  if (state.cels.get("explorer.cwd")) await refreshExplorer(state);
  return state;
};

// explorerDelete — fs.delete a file, clear the preview if it was showing, then
// refresh the listing (reactive via explorer.listing).
const explorerDelete: Fn = async (stateArg: unknown, path: unknown) => {
  const state = stateArg as State;
  const p = String(path ?? "");
  if (!p) return state;
  await ensureSegments(state, ["file-store"]);
  await ((resolveFn(state, "fs.delete") as Fn)(p) as Promise<unknown>).catch(() => {});
  if (String(state.cels.get("explorer.preview")?.v ?? "") === p) await setOrCreate(state, "explorer.preview", "");
  await refreshExplorer(state);
  return state;
};

// explorerRename — prompt for a new NAME (same dir), fs.rename, follow the
// preview if it moved, then refresh. No-op off-DOM (no prompt available).
type DomPrompt = { prompt?: (msg: string, def?: string) => string | null };
const explorerRename: Fn = async (stateArg: unknown, path: unknown) => {
  const state = stateArg as State;
  const p = String(path ?? "");
  if (!p) return state;
  const g = globalThis as DomPrompt;
  if (typeof g.prompt !== "function") return state;
  const old = p.split("/").pop() || p;
  const next = g.prompt(`Rename "${old}" to:`, old);
  if (next == null || next === "" || next === old) return state;
  await ensureSegments(state, ["file-store"]);
  const dest = joinPath(parentPath(p), String(next).replace(/^\/+/, ""));
  await ((resolveFn(state, "fs.rename") as Fn)(p, dest) as Promise<unknown>).catch(() => {});
  if (String(state.cels.get("explorer.preview")?.v ?? "") === p) await setOrCreate(state, "explorer.preview", dest);
  await refreshExplorer(state);
  return state;
};

// explorerDownload — per-file download from the explorer; reuses the existing
// download dispatch (read OPFS bytes → browser save).
const explorerDownload: Fn = async (stateArg: unknown, path: unknown) =>
  downloadHandler(stateArg, path);

// origin.seedIndexHtml — seed the page's own served HTML into OPFS at
// /plastron/index.html so the explorer isn't empty: it shows "the index.html
// that plastron makes". Best-effort; no-op off-DOM. Idempotent-ish: overwrites
// /plastron/index.html each boot with the current document.
type DomHtml = { document?: { documentElement?: { outerHTML?: string } } };
const seedIndexHtml: Fn = async (state: State): Promise<State> => {
  const backend = state.cels.get("file-store.backend")?.v;
  if (backend === "none" || backend === undefined) return state;
  const g = globalThis as DomHtml;
  const html = g.document?.documentElement?.outerHTML;
  if (typeof html !== "string" || html.length === 0) return state;
  await ensureSegments(state, ["file-store"]);
  await ((resolveFn(state, "fs.mkdir") as Fn)("/plastron") as Promise<unknown>).catch(() => {});
  await ((resolveFn(state, "fs.write") as Fn)("/plastron/index.html", `<!doctype html>\n${html}`) as Promise<unknown>).catch(() => {});
  return state;
};

// join a dir path and an entry name into an absolute OPFS path.


// --- sqlite — lazy sql.js (CDN, like pyodide) + in-memory dbs persisted to
//     OPFS bytes at /plastron/dbs/<name>.db. db()/sql()/tables() vocabulary.
//     (A dedicated `sqlite` segment is the cleaner long-term host; the MVP
//     lives here alongside opfs, lazy-loading sql.js on first db() use.) ---
const dbHandleName = (h: unknown): string =>
  (h && typeof h === "object" && typeof (h as { __db?: unknown }).__db === "string")
    ? (h as { __db: string }).__db : String(h ?? "main");

const dbFn:     Fn = (name: unknown) => ({ originDb: "open", name: String(name ?? "main") });
const sqlFn:    Fn = (handle: unknown, query: unknown) => ({ originDb: "sql", name: dbHandleName(handle), query: String(query ?? "") });
const tablesFn: Fn = (handle: unknown) => ({ originDb: "sql", name: dbHandleName(handle), query: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" });

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
  const desc = (c: Cel): string => String((c.metadata as { description?: unknown }).description ?? "");
  for (const { cel } of items) {
    const req = cel.v as Record<string, unknown> | undefined;
    if (!req || typeof req !== "object") continue;
    // load/cels/inspect/segments/vocab are ACTIONS — the result is data.
    // Replace the requesting FORMULA cel with a ValueCel holding it, so
    // the next runCycle can't re-evaluate the formula over the result.
    let result: unknown;
    try {
      // Capability gate (quarantine, Layer-B): an effect that reaches the
      // network or persistent storage needs the requesting segment to hold
      // `net` / `storage`. A quarantined segment/kernel gets #DENIED — the
      // formula already ran, only the EFFECT is refused.
      const capNeeded = req.originChat ? "net" as const
        : (req.originSave || req.originOpen || req.originFs || req.originSeg || req.originDb) ? "storage" as const
        : null;
      if (capNeeded && !canUse(state, cel.metadata.segment, capNeeded)) {
        result = `#DENIED(${capNeeded}: segment "${cel.metadata.segment}" is quarantined — grant ${capNeeded} in trust settings)`;
      } else if (req.originLoad && req.name) {
        await ensureSegments(state, [String(req.name)]);
        result = `loaded "${req.name}" - its vocabulary is callable now`;
      } else if (req.originCels && req.segment) {
        const lines: string[] = [];
        const skill = state.cels.get(`${req.segment}.skill`);
        if (skill && typeof skill.v === "string") lines.push(skill.v, "");
        for (const [k, c] of state.cels) {
          if (c.metadata.segment !== req.segment) continue;
          const f = (c as { f?: string }).f;
          lines.push(`${k}  [${c.celType}${c.locked ? ", locked" : ""}]${f ? `  f: ${f.slice(0, 60)}` : ""}`);
        }
        result = lines.length ? lines.join("\n") : `(no segment named "${req.segment}" is loaded - try =load("${req.segment}"))`;
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
        const seg = String(req.segment ?? "");
        const fns: string[] = []; const vals: string[] = [];
        for (const [k, c] of state.cels) {
          if (seg && c.metadata.segment !== seg) continue;
          if (k.includes(".")) continue; // skip namespaced internals (g.A1, foo.bar)
          if (c.celType === "LockedLambdaCel" || c.celType === "EditableLambdaCel" || c.celType === "CompilerCel") {
            fns.push(`  ${k}${desc(c) ? `  — ${desc(c)}` : ""}`);
          } else if (c.celType === "ValueCel") {
            vals.push(`  ${k} = ${JSON.stringify(c.v)?.slice(0, 40)}`);
          }
        }
        result = [`functions (call as (${"name"} …) or =name(…)):`, ...fns.sort(),
          "", "values (reference by name):", ...vals.sort()].join("\n");
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

      } else if (req.originSave) {
        const ls = LS();
        if (!ls) result = "(no localStorage here)";
        else { ls.setItem(slot(req.name), JSON.stringify(collectArchive(state))); result = `saved — reload and your sheet is back (slot "${String(req.name || "default")}")`; }
      } else if (req.originOpen) {
        const raw = LS()?.getItem(slot(req.name));
        if (!raw) result = `(nothing saved as "${String(req.name || "default")}")`;
        else { await restoreArchive(state, JSON.parse(raw)); result = `opened "${String(req.name || "default")}"`; }
      } else if (req.originLink) {
        const t = String(req.target ?? "");
        const src = t ? cellSource(state, t) : buildSeed(state);
        result = await encodeLink(src, { base: String(req.base ?? "https://plastron.ca/"), codec: String(req.codec ?? "auto") as LinkCodec });
      } else if (req.originUnlink) {
        // decode ONLY — returns the formula source as text; does NOT execute it.
        result = await decodeLink(String(req.url ?? ""));
      } else if (req.originKernel) {
        // spawn a quarantined child: fresh segment, trust = preset (capped by
        // this kernel at resolve time), seed formula in <seg>.元. Its cells live
        // under <seg>.*; gated capabilities are #DENIED unless the preset grants.
        const preset = String(req.preset ?? "locked");
        const trust = TRUST_PRESETS[preset] ?? TRUST_PRESETS.locked;
        let n = 1; while (state.cels.has(`app${n}.元`)) n++;
        const seg = `app${n}`;
        setTrust(state, seg, trust);
        await setCel(state, `${seg}.元`, { celType: "FormulaCel", f: String(req.seed ?? ""), metadata: { key: `${seg}.元`, segment: seg, parser: "infix" } });
        result = `spawned "${seg}" (${preset}) — a quarantined plastron; its cells live under ${seg}.*`;
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
  ["origin.commit",  commit],
  ["origin.edit",    edit],
  ["origin.select",  select],
  ["origin.fire",    fire],
  ["origin.key",     key],
  ["ex",             ex],
  ["tryexample",     tryexample],
  ["cels",           celsGen],
  ["at",             at],
  ["segment",        doc],   // primary (was doc — composes a SEGMENT)
  ["doc",            doc],   // deprecated legacy alias
  ["seed",           seedFn],
  ["origin.drain",   effectsDrain],
  ["load",           loadFn],
  ["members",        celsFn],
  ["inspect",        inspectFn],
  ["segments",       segmentsFn],
  ["vocab",          vocabFn],
  ["def",            defFn],
  ["chat",           chatFn],
  ["grok",           grokFn],
  ["link",           linkFn],
  ["unlink",         unlinkFn],
  ["kernel",         kernelFn],
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
  ["explorer",       explorerFn],
  ["origin.explorerNav",  explorerNav],
  ["origin.explorerOpen", explorerOpen],
  ["origin.explorerOpenSheet", explorerOpenSheet],
  ["origin.explorerRefresh", explorerRefresh],
  ["origin.explorerDelete", explorerDelete],
  ["origin.explorerRename", explorerRename],
  ["origin.explorerDownload", explorerDownload],
  ["segs",           segsFn],
  ["saveSeg",        saveSegFn],
  ["openSeg",        openSegFn],
  ["delSeg",         delSegFn],
  ["download",       downloadFn],
  ["downloadSeg",    downloadSegFn],
  ["upload",         uploadFn],
  ["origin.download", downloadHandler],
  ["origin.upload",   uploadHandler],
  ["db",             dbFn],
  ["sql",            sqlFn],
  ["tables",         tablesFn],
  ["interlinked",    interlinkedFn],
  ["simulate",       simulateFn],
  ["dragdrop",       dragdropFn],
  ["save",           saveFn],
  ["open",           openFn],
  ["origin.autoload", autoload],
  ["origin.seedWallpaper", seedWallpaper],
  ["origin.seedIndexHtml", seedIndexHtml],
]));
