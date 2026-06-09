import type {
  甲骨, Cel, ChannelEnqueue, Fn, Key, State, VNode, VElement, AttrValue, EventBinding,
} from "../../../types/index.js";
import {
  bindNativeFns, resolveFn, ensureSegments, appendError, makeCelError,
} from "../../../kernel/index.js";
// Core rendering comes from the plastron-dom LIBRARY — the app doesn't re-roll
// vnode building, diffing, or the memo. `el`/`text` build the canonical VNode;
// `memo` attaches the diff's O(changed) short-circuit hint (see plastron-dom).
import { el as makeEl, text as T, memo } from "../../library/plastron-dom/index.js";
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
//   =grid(3,3)    → a 3×3 worksheet of cels, each like 元
//   =dom("h2"…)   → a heading rendered in the cell
// 元.view is UNLOCKED — it renders through plastron-dom like any view,
// built to be reworked in place.
// ============================================================================

// loose view alias for ergonomic in-app access (.children / raw splicing); the
// canonical VNode the painter sees is built by the library `el`/`text` below.
type V = { type: "el" | "text"; tag?: string; key?: string; memo?: unknown; attrs?: Record<string, unknown>; events?: Record<string, unknown>; children?: V[]; text?: string };
// loose-typed adapter over the LIBRARY builder — origin's call sites pass plain
// records; the painter stringifies, so the cast is safe.
const el = (tag: string, attrs: Record<string, unknown>, children: V[], events?: Record<string, unknown>): V =>
  makeEl(tag, attrs as Record<string, AttrValue>, children as VNode[], events as Record<string, EventBinding> | undefined) as V;

const isVnode = (v: unknown): v is V =>
  !!v && typeof v === "object" && ((v as V).type === "el" || (v as V).type === "text");

/** dom(tag, ...children) — a presentation vnode VALUE (not a mounted
 *  view; 元.view composes it). `tag` accepts an emmet-ish class:
 *  "div.readme" → <div class="readme">. Children: strings → text nodes,
 *  nested dom(...) → child elements. A freespace cell whose value is a
 *  vnode renders in the STACK above the cels; delete the formula and it
 *  is gone — composed by value, nothing to unmount. */
const isStyle = (c: unknown): c is { __style: Record<string, unknown> } =>
  !!c && typeof c === "object" && typeof (c as { __style?: unknown }).__style === "object";
const isAttr = (c: unknown): c is { __attr: Record<string, unknown> } =>
  !!c && typeof c === "object" && typeof (c as { __attr?: unknown }).__attr === "object";

const dom: Fn = (tag: unknown, ...children: unknown[]): V => {
  const spec = String(tag ?? "div");
  const dot = spec.indexOf(".");
  const name = dot === -1 ? spec : spec.slice(0, dot);
  const cls = dot === -1 ? undefined : spec.slice(dot + 1).replace(/\./g, " ");
  // (style …) children set inline style; (attr …) children set attributes
  // (href, target, …); the rest are child nodes.
  let style: Record<string, unknown> | undefined;
  const attrs: Record<string, unknown> = cls ? { class: cls } : {};
  const kids: V[] = [];
  for (const c of children) {
    if (isStyle(c)) { style = { ...style, ...c.__style }; continue; }
    if (isAttr(c)) { Object.assign(attrs, c.__attr); continue; }
    kids.push(isVnode(c) ? c : T(c));
  }
  return {
    type: "el", tag: name || "div",
    ...(Object.keys(attrs).length ? { attrs } : {}),
    ...(style ? { style: style as Record<string, string | number | boolean | null> } : {}),
    children: kids,
  };
};

/** style(prop, value, prop, value, …) — inline styles for a dom element.
 *  Pass as a child: (dom "h1" (style "color" "tomato" "font-size" "2rem") "hi"). */
const style: Fn = (...pairs: unknown[]): { __style: Record<string, unknown> } => {
  const s: Record<string, unknown> = {};
  for (let i = 0; i + 1 < pairs.length; i += 2) s[String(pairs[i])] = pairs[i + 1];
  return { __style: s };
};

/** attr(name, value, …) — HTML attributes for a dom element (href, target,
 *  id, …). Pass as a child: (dom "a" (attr "href" "https://…") "link"). */
const attr: Fn = (...pairs: unknown[]): { __attr: Record<string, unknown> } => {
  const a: Record<string, unknown> = {};
  for (let i = 0; i + 1 < pairs.length; i += 2) a[String(pairs[i])] = pairs[i + 1];
  return { __attr: a };
};

// ── view styles, INLINE ──────────────────────────────────────────────────────
// The view carries all its own CSS as inline `style` attributes (the painter
// writes them straight onto the element) — the host HTML keeps only :root / *
// / body / #app. Pseudo-classes can't be inline: :first-child is handled by
// styling the element directly; :has() by computing per-cell here; :hover is
// dropped (cosmetic).
const SX = {
  origin: "display:flex;flex-direction:column;gap:1.25rem;align-items:center;margin:0 auto",
  sheet: "display:flex;flex-direction:column;gap:1.25rem;align-items:center",
  scroll: "overflow-x:auto;max-width:100%",
  table: "border-collapse:collapse;font-variant-numeric:tabular-nums",
  th: "border:1px solid #8883;background:#8881;text-align:center;color:#888;font-weight:600;font-size:.8rem;font-family:ui-monospace,monospace;min-width:1.8rem;padding:0 .35rem;height:1.9rem",
  corner: "border:1px solid #8883;background:#8881;text-align:center;color:#aaa;font-weight:700;font-size:.8rem;font-family:ui-monospace,monospace;padding:0 .35rem;height:1.9rem",
  td: "border:1px solid #8883;padding:0;height:1.9rem;text-align:left;vertical-align:top;cursor:cell",
  cellValue: "display:flex;align-items:flex-start;gap:.25rem;padding:.15rem .4rem;min-height:1.6rem;max-width:min(56rem,88vw);font-family:ui-monospace,monospace;font-size:.85rem;resize:both;overflow:auto;cursor:text",
  valFirst: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
  pre: "margin:0;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.8rem;line-height:1.4;flex:1;min-width:0;overflow:visible",
  src: "margin:0;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:.8rem;line-height:1.4;color:CanvasText;max-height:16rem;overflow:auto;flex:1;min-width:0",
  editing: "display:flex;flex-direction:column;gap:.2rem;min-width:18rem",
  error: "color:#d4453e;background:#d4453e1a;font-family:ui-monospace,monospace;font-size:.76rem;padding:.15rem .45rem;border-radius:.3rem",
  edit: "width:100%;min-height:2.6rem;resize:both;font-family:ui-monospace,monospace;font-size:.85rem;padding:.15rem .4rem;border:0;background:#4a90d922;white-space:pre-wrap;line-height:1.4",
} as const;

/** How a cell's VALUE shows when not being edited: a dom vnode renders
 *  live; a number/string shows as text; a structure request (genesis /
 *  defn) shows a ƒ marker (it made cels/functions elsewhere); errors
 *  show Excel-style. Empty shows nothing. */
const displayCell = (v: unknown): V => {
  if (isVnode(v)) return v as V;
  if (v === null || v === undefined || v === "") return T("");
  if (typeof v === "object") {
    const o = v as { kind?: unknown; message?: unknown; genesis?: unknown; defn?: unknown; name?: unknown; __mount?: unknown };
    if (o.kind === "error") return T(/undefined symbol|not a function/.test(String(o.message)) ? "#NAME?" : "#ERR!");
    if (o.genesis === true) return T("ƒ grid");
    if (o.defn === true) return T(`ƒ ${String(o.name ?? "")}`);
    if (typeof o.__mount === "string") return T(""); // content renders elsewhere (mounted) — the cell stays clean
    try { return T(JSON.stringify(v).slice(0, 60)); } catch { return T("#ERR!"); }
  }
  // a multi-line string (inspect output, a paragraph) keeps its shape in a
  // <pre>; inline it stays a one-line preview (.cell-value clips it), but
  // the ⤢ expand panel shows it formatted top-to-bottom.
  if (typeof v === "string" && v.includes("\n")) return el("pre", { class: "cell-pre", style: SX.pre }, [T(v)]);
  return T(String(v));
};

// A minimal CSS-ish selector, matched against the view's OWN render tree
// (NOT the live DOM). mount() splices its content into the first matching
// SPEC node so the painter — which owns #app and re-renders every frame —
// reconciles it like everything else; a node appended to the live DOM by
// xpath would just be wiped on the next paint. Grammar: optional tag plus
// any number of .class / #id — ".sheet", "div.cell", "#k".
const parseSel = (sel: string): { tag?: string; classes: string[]; id?: string } | null => {
  const m = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)+)?$/.exec(sel.trim());
  if (!m || (!m[1] && !m[2])) return null;
  const classes: string[] = []; let id: string | undefined;
  for (const tok of (m[2] ?? "").match(/[.#][\w-]+/g) ?? []) {
    if (tok[0] === ".") classes.push(tok.slice(1)); else id = tok.slice(1);
  }
  return { tag: m[1], classes, id };
};
const matchNode = (n: V, p: { tag?: string; classes: string[]; id?: string }): boolean => {
  if (n.type !== "el") return false;
  if (p.tag && n.tag !== p.tag) return false;
  const cls = String((n.attrs as Record<string, unknown> | undefined)?.class ?? "").split(/\s+/);
  if (p.classes.some((c) => !cls.includes(c))) return false;
  if (p.id && (n.attrs as Record<string, unknown> | undefined)?.id !== p.id) return false;
  return true;
};
const findNode = (root: V, p: { tag?: string; classes: string[]; id?: string }): V | null => {
  if (matchNode(root, p)) return root;
  for (const c of root.children ?? []) { const r = findNode(c, p); if (r) return r; }
  return null;
};

// A1-address parsing for the Excel grid layout (col letters → index, etc.)
const colIdx = (letters: string): number => {
  let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1;
};
const addrOf = (key: string): { col: number; row: number } | null => {
  const m = /([A-Z]+)([0-9]+)$/.exec(key.includes(".") ? key.slice(key.indexOf(".") + 1) : key);
  return m ? { col: colIdx(m[1]!), row: parseInt(m[2]!, 10) - 1 } : null;
};

/** The spreadsheet renderer (parser "f"):
 *  (editing expanded draft mount keys vals) → render-spec.
 *  The base sheet's first cel (元) is a labelled button; every grid()
 *  layer renders as an Excel-style <table> (corner + column letters +
 *  row numbers). Click a cell to edit inline; the ⤢ on a cell opens an
 *  expanded editor panel for its full formula. A cell's value shows in
 *  place — a number, text, or a live dom object. */
const originView: Fn = (
  editing: unknown, draft: unknown, mount: unknown, error: unknown, keys: unknown, vals: unknown, srcs: unknown,
) => {
  const ks = Array.isArray(keys) ? (keys as string[]) : ["元"];
  const vs = Array.isArray(vals) ? (vals as unknown[]) : [];
  const ss = Array.isArray(srcs) ? (srcs as unknown[]) : [];
  const active = typeof editing === "string" ? editing : null;
  const errMsg = typeof error === "string" ? error : null;
  const valOf = new Map<string, unknown>(); ks.forEach((k, i) => valOf.set(k, vs[i]));
  const srcOf = new Map<string, string>(); ks.forEach((k, i) => srcOf.set(k, String(ss[i] ?? "")));

  // the editor — a resizable textarea (the SAME for every cell), plus an
  // error line when its last formula failed to compile.
  const editor = (key: string): V =>
    el("div", { class: "cell-editing", style: SX.editing }, [
      el("textarea", { class: "cell-edit", style: SX.edit, value: String(draft ?? "") }, [], {
        input: { set: "元.draft", extract: "value" },
        keydown: { dispatch: "origin.key", payload: key }, // origin.key commits on Enter
      }),
      ...(errMsg ? [el("div", { class: "cell-error", style: SX.error }, [T(errMsg)])] : []),
    ]);

  const isMountVal = (v: unknown): boolean => !!v && typeof v === "object" && typeof (v as { __mount?: unknown }).__mount === "string";

  // the inner of a cell: inline editor when active, else the value. A cell
  // whose value renders ELSEWHERE (a mount — e.g. the readme in 元) shows its
  // SOURCE here, so the formula is visible + editable. Click to edit.
  const body = (key: string, value: unknown): V => {
    if (active === key) return editor(key);
    const shown = isMountVal(value) ? el("pre", { class: "cell-pre cell-src", style: SX.src }, [T(srcOf.get(key) ?? "")]) : displayCell(value);
    const valEl = shown.type === "text" ? el("span", { class: "cell-val-text", style: SX.valFirst }, [shown]) : shown;
    return el("div", { class: "cell-value", title: "click to edit", style: SX.cellValue }, [valEl],
      { click: { dispatch: "origin.edit", payload: key } });
  };

  // ANY set of cels → one Excel-style table (corner label + column letters +
  // row numbers). The base sheet (元 at A1) and every grid() layer go through
  // this same renderer — ONE cell UI everywhere, every cell resizable.
  const colLetter = (c: number): string => { let s = "", n = c + 1; while (n > 0) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); } return s; };
  const sheetTable = (label: string, entries: { key: string; col: number; row: number }[]): V => {
    let maxC = 0, maxR = 0;
    const at = new Map<string, string>();
    for (const e of entries) { at.set(`${e.col},${e.row}`, e.key); maxC = Math.max(maxC, e.col); maxR = Math.max(maxR, e.row); }
    const head = el("tr", {}, [el("th", { class: "corner", style: SX.corner }, [T(label)]),
      ...Array.from({ length: maxC + 1 }, (_, c) => el("th", { style: SX.th }, [T(colLetter(c))]))]);
    const rows = Array.from({ length: maxR + 1 }, (_, r) =>
      el("tr", {}, [el("th", { class: "rownum", style: SX.th }, [T(String(r + 1))]),
        ...Array.from({ length: maxC + 1 }, (_, c) => {
          const k = at.get(`${c},${r}`);
          if (!k) return el("td", { class: "cell", "data-key": "", style: `${SX.td};min-width:4.5rem` }, []);
          const v = valOf.get(k);
          const isActive = active === k;
          // mount cells (showing a long source) get a roomier min-width;
          // the active cell gets the editing outline — both inline.
          const tdStyle = `${SX.td};min-width:${isMountVal(v) ? "26rem" : "4.5rem"}${isActive ? ";outline:2px solid #4a90d9;outline-offset:-2px" : ""}`;
          const td = el("td", { class: isActive ? "cell editing" : "cell", "data-key": k, style: tdStyle }, [body(k, v)]);
          // memo hint → plastron-dom's diff skips an unchanged cell's deep compare
          // (O(changed), library-level). The ACTIVE cell gets NO memo — its editor
          // depends on draft/error — so it's always deep-diffed.
          return isActive ? td : (memo(td as unknown as VElement, [v, isMountVal(v) ? srcOf.get(k) : undefined]) as unknown as V);
        })]));
    // wrap in a horizontal scroller so a wide grid reaches column A
    // (a centered overflowing table clips its left edge unreachably).
    return el("div", { class: "grid-scroll", style: SX.scroll }, [el("table", { class: "grid", style: SX.table }, [el("thead", {}, [head]), el("tbody", {}, rows)])]);
  };

  // group: base cels (no dot) vs grid layers (segment before the dot)
  const base: string[] = []; const layers = new Map<string, string[]>();
  for (const k of ks) {
    const dot = k.indexOf(".");
    if (dot === -1) base.push(k);
    else { const lr = k.slice(0, dot); (layers.get(lr) ?? layers.set(lr, []).get(lr))!.push(k); }
  }

  const sections: V[] = [];
  // the base sheet: 元 at A1, any other base cels down column A.
  if (base.length) sections.push(sheetTable("元", base.map((k, i) => ({ key: k, col: 0, row: i }))));
  for (const [layer, members] of layers) {
    const entries = members.map((k) => { const a = addrOf(k); return a ? { key: k, col: a.col, row: a.row } : null; }).filter((e): e is { key: string; col: number; row: number } => !!e);
    sections.push(sheetTable(layer, entries));
  }

  // PLACED dom — a cell whose value is mount(target, content). The dom is
  // spliced into the first node of THIS view matching `target` (a node the
  // origin renders: ".sheet", ".region-top", "div.cell", …) and renders
  // there, not in its cell. A bare word that matches no node is a region
  // anchor the origin lays out around the sheet ("top" above, "bottom"
  // below, others above in name order). Delete the formula → it's gone.
  const asPlacement = (v: unknown): { sel: string; vnode: V } | null => {
    const o = v as { __mount?: unknown; vnode?: unknown } | undefined;
    return o && typeof o === "object" && typeof o.__mount === "string" && isVnode(o.vnode)
      ? { sel: o.__mount, vnode: o.vnode as V } : null;
  };
  const placements: { sel: string; vnode: V }[] = [];
  for (const k of ks) { const p = asPlacement(valOf.get(k)); if (p) placements.push(p); }

  const sheetNode = el("div", { class: "sheet", style: SX.sheet }, sections);
  const originNode = el("div", { class: "origin", style: SX.origin }, [sheetNode]);

  // Splice each placement into the FIRST view node matching its selector.
  // No magic regions: the target must be an element the view actually renders
  // (".origin", ".sheet", "div.cell", a previously-mounted ".readme", …). A
  // selector that matches nothing places nothing (the cell shows "→ sel").
  for (const { sel, vnode } of placements) {
    const p = parseSel(sel);
    const target = p ? findNode(originNode, p) : null;
    if (target) (target.children ??= []).push(vnode);
  }

  return { vnode: originNode, mount: typeof mount === "string" ? mount : null, listeners: [] };
};

/** mount(selector, content) — PLACE a dom object UNDER another element the
 *  origin renders, instead of inside the cell that holds the formula. The
 *  selector matches the view's own render tree: ".origin" (the frame),
 *  ".sheet" (under the cells), "div.cell" (the first cell), "#id" by id, or a
 *  class a previous mount added. The origin owns #app and re-paints every
 *  frame, so mount splices into the SPEC (reconciled like everything else)
 *  rather than the live DOM — a selector into the view, not an xpath into the
 *  page. No match → nothing is placed. Vanishes when the formula is deleted. */
const mount: Fn = (target: unknown, content: unknown): unknown =>
  ({ __mount: String(target ?? ".origin"), vnode: isVnode(content) ? content : T(content) });

// Build the genesis request for ONE named grid (rows×cols of empty
// infix cels under `name.A1` …). Shared by grid() and sheets().
// a cell SOURCE → cel spec. Like sniff, but a bare `name(…)` call counts as a
// formula too (so cell values like cel("monkey") become formulas, not text).
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
 *    cels("in", 4, 3, at("a1","apple"), at("b2","cel(\"monkey\")"))  → a sheet
 *      with initial cell contents (a value, or a formula like cel(…) / =1+1).
 *  Delete the formula → swept. `grid` is a back-compat alias. */
const grid: Fn = (...args: unknown[]): unknown => {
  if (typeof args[0] === "string") {
    // workbook: (name, rows, cols [, at()…])+ — at() markers belong to the
    // preceding grid; the next string starts the next grid.
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
  return { genesis: true, ...gridShape(rows, cols, name, values) };
};

/** cel(content?) — create ONE new cel out of the origin cel. `cel()` makes an
 *  empty cel; `cel("monkey")` a cel holding the value monkey; `cel("cel(\"x\")")`
 *  a cel holding that formula. The new cel lands as a base cel beside 元. */
const celFn: Fn = (content?: unknown) => ({ originCel: true, content: content == null ? "" : String(content) });

/** doc(…parts) — compose an ENTIRE document from cels()/def()/cel() parts into
 *  ONE genesis batch. This is what `seed()` emits: paste a doc(…) into 元 and
 *  the whole app re-materializes (genesis seeds at creation, preserves edits). */
const doc: Fn = (...parts: unknown[]): unknown => {
  const cels: Record<string, unknown> = {};
  let cn = 0;
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (o.genesis === true && o.cels) Object.assign(cels, o.cels);                       // cels(…)
    else if (o.cels && o.layer) Object.assign(cels, o.cels as Record<string, unknown>);  // gridShape direct
    else if (o.originDef === true) cels[String(o.name)] = { celType: "EditableLambdaCel", f: String(o.source ?? ""), metadata: { kind: String(o.kind ?? "js"), name: String(o.name) } };
    else if (o.originCel === true) { const k = `c${++cn}`; const s = sniffCel(String(o.content ?? "")); cels[k] = { celType: s.celType, f: s.f, v: s.v, metadata: { name: k, parser: s.parser } }; }
  }
  return { genesis: true, cels };
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
    // grid cels (genesis-owned) + cel()-created base cels (c1, c2, …; no dot,
    // origin segment — but not the internal 元.* state cels, which have dots).
    if (md.generatedBy || (md.segment === "origin" && /^c\d+$/.test(k))) out.push(k);
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

// source text of a cell (formula `f`, else stringified value)
const cellSource = (state: State, key: string): string => {
  const c = state.cels.get(key);
  const f = (c as { f?: string } | undefined)?.f;
  return f ?? (c?.v === undefined || c?.v === null ? "" : String(c.v));
};

/** edit — start INLINE editing a cell (seed the draft with its source);
 *  clicking the active cell again closes it. */
const edit: Fn = async (state: State, payload?: unknown) => {
  const key = typeof payload === "string" ? payload : null;
  const cur = state.cels.get("元.editing")?.v;
  const next = cur === key ? null : key;
  await (resolveFn(state, "setValueBatch") as Fn)(state,
    [["元.editing", next], ["元.draft", next ? cellSource(state, next) : ""], ["元.error", null]]);
  await (resolveFn(state, "drain") as Fn)(state, "plastron-dom.paint");
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
    await (resolveFn(state, "drain") as Fn)(state, "plastron-dom.paint");
    return state;
  }

  await (resolveFn(state, "setValueBatch") as Fn)(state, [["元.editing", null], ["元.draft", ""], ["元.error", null]]);
  // fire generators so they enqueue, then commit structure + sweep. Loop until
  // quiescent: an effect can create a cel whose own formula is a request (e.g.
  // cel("cel(\"banana\")") → c1 = =cel("banana") → another cel) — keep draining
  // until a pass adds nothing new (capped, so a runaway can't spin forever).
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
  await (resolveFn(state, "runCycle") as Fn)(state);
  await drain(state, "plastron-dom.paint");
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
// cels("seg", r, c, at(addr, src)…); base cels → cel(src); defs → def(…). One
// grid alone stays a bare cels(…); anything composite wraps in doc(…).
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
  const bases: string[] = [];
  for (const [key, src] of arch.cells) {
    if (key === "元" || /^=?\s*seed\s*\(/.test(src)) continue;   // skip 元 + any =seed() cell (no self-capture)
    const dot = key.indexOf(".");
    if (dot < 0) { bases.push(src); continue; }
    const seg = key.slice(0, dot), addr = key.slice(dot + 1);
    (grids.get(seg) ?? grids.set(seg, []).get(seg)!).push([addr, src]);
  }
  const parts: string[] = [];
  for (const [seg, cells] of grids) {
    const { r, c } = gridDims(cells.map(([a]) => a));
    const ats = cells.filter(([, s]) => s !== "").map(([a, s]) => `at(${qstr(a)}, ${qstr(s)})`);
    parts.push(`cels(${qstr(seg)}, ${r}, ${c}${ats.length ? ", " + ats.join(", ") : ""})`);
  }
  for (const s of bases) parts.push(`cel(${qstr(s)})`);
  for (const [name, kind, f] of arch.defs) parts.push(`def(${qstr(name)}, ${qstr(kind)}, ${qstr(f)})`);
  if (parts.length === 0) return "=cels(1, 1)";
  if (parts.length === 1 && parts[0]!.startsWith("cels(")) return "=" + parts[0];
  return "=doc(" + parts.join(", ") + ")";
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
/** origin.autoload — restore the default slot on boot (the host calls this). */
const autoload: Fn = async (state: State): Promise<State> => {
  const raw = LS()?.getItem(slot());
  if (raw) { try { await restoreArchive(state, JSON.parse(raw)); } catch { /* corrupt save — ignore */ } }
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
  await (resolveFn(state, "drain") as Fn)(state, "plastron-dom.paint");
  return state;
};

// join a dir path and an entry name into an absolute OPFS path.
const fsJoin = (dir: string, name: string): string =>
  (dir === "/" ? "" : dir.replace(/\/+$/, "")) + "/" + name;

// recursive listing, indented — `tree(path)`.
const fsTree = async (state: State, path: string, prefix = ""): Promise<string> => {
  const call = (k: string, ...a: unknown[]) => (resolveFn(state, k) as Fn)(...a);
  const names = ((await call("fs.list", path)) as string[]).slice().sort();
  const out: string[] = [];
  for (const n of names) {
    const full = fsJoin(path, n);
    const st = await (call("fs.stat", full) as Promise<{ isDir?: boolean }>).catch(() => null);
    if (st?.isDir) { out.push(`${prefix}${n}/`); out.push(await fsTree(state, full, `${prefix}  `)); }
    else out.push(`${prefix}${n}`);
  }
  return out.filter(Boolean).join("\n");
};

// --- sqlite — lazy sql.js (CDN, like pyodide) + in-memory dbs persisted to
//     OPFS bytes at /plastron/dbs/<name>.db. db()/sql()/tables() vocabulary.
//     (A dedicated `sqlite` segment is the cleaner long-term host; the MVP
//     lives here alongside opfs, lazy-loading sql.js on first db() use.) ---
interface SqlDb { exec(q: string): { columns: string[]; values: unknown[][] }[]; export(): Uint8Array; }
interface SqlJs { Database: new (bytes?: Uint8Array) => SqlDb; }
let _sqlJs: SqlJs | null = null;
const _dbs = new Map<string, SqlDb>();
const sqliteCdn = (): string => (globalThis as { __sqliteCdn?: string }).__sqliteCdn ?? "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/";
const dbFile = (name: string): string => `/plastron/dbs/${name}.db`;
const loadSqlJs = async (state: State): Promise<SqlJs> => {
  if (_sqlJs) return _sqlJs;
  const base = sqliteCdn();
  await (resolveFn(state, "loadScript") as Fn)(state, `${base}sql-wasm.js`);
  const init = (globalThis as { initSqlJs?: (o: { locateFile: (f: string) => string }) => Promise<SqlJs> }).initSqlJs;
  if (!init) throw new Error("sqlite: sql.js failed to load from CDN");
  _sqlJs = await init({ locateFile: (f: string) => base + f });
  return _sqlJs;
};
const openDb = async (state: State, name: string): Promise<SqlDb> => {
  const cached = _dbs.get(name);
  if (cached) return cached;
  const SQL = await loadSqlJs(state);
  await ensureSegments(state, ["file-store"]);
  let bytes: Uint8Array | undefined;
  try { bytes = (await (resolveFn(state, "fs.read") as Fn)(dbFile(name))) as Uint8Array; } catch { /* new db */ }
  const db = bytes && bytes.length ? new SQL.Database(bytes) : new SQL.Database();
  _dbs.set(name, db);
  return db;
};
const persistDb = async (state: State, name: string, db: SqlDb): Promise<void> => {
  await ensureSegments(state, ["file-store"]);
  await (resolveFn(state, "fs.mkdir") as Fn)("/plastron/dbs");
  await (resolveFn(state, "fs.write") as Fn)(dbFile(name), db.export());
};
const dbHandleName = (h: unknown): string =>
  (h && typeof h === "object" && typeof (h as { __db?: unknown }).__db === "string")
    ? (h as { __db: string }).__db : String(h ?? "main");
const WRITE_SQL = /^\s*(insert|update|delete|create|drop|alter|replace|begin|commit|vacuum)\b/i;

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
      if (req.originLoad && req.name) {
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
            ["value", c.v],
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
      } else if (req.originCel) {
        // create ONE new base cel (c1, c2, …) holding the given content. The
        // requesting cell becomes the confirmation below, so it won't re-fire.
        let n = 1; while (state.cels.get(`c${n}`)) n++;
        const ck = `c${n}`;
        const spec = sniffCel(String(req.content ?? ""));
        // emitsTo lets a cel whose formula is itself a request (e.g. cel(…))
        // route it to this drain — so cel("cel(\"banana\")") really makes another cel.
        await setCel(state, ck, { celType: spec.celType, f: spec.f, v: spec.v, metadata: { segment: "origin", name: ck, parser: spec.parser, emitsTo: "origin.effects" } });
        result = `created cel ${ck}`;
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
      } else if (req.originChat) {
        // chat completion — POST to an OpenAI-shaped endpoint, await the reply.
        const url = String(req.url ?? "https://api.x.ai/v1/chat/completions");
        const model = String(req.model ?? "grok-3-mini");
        const key = String(req.key ?? "");
        if (!key) {
          result = `(no api key — pass one: =grok("hi", "xai-…") or =grok("hi", apiKeyCel))`;
        } else {
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: JSON.stringify({ model, messages: [{ role: "user", content: String(req.prompt ?? "") }] }),
          });
          if (!res.ok) result = `(chat ${res.status}: ${(await res.text()).slice(0, 200)})`;
          else {
            const j = await res.json() as { choices?: { message?: { content?: string } }[] };
            result = j?.choices?.[0]?.message?.content ?? JSON.stringify(j).slice(0, 500);
          }
        }
      } else if (req.originFs) {
        // OPFS filesystem op — lazy-load file-store, then run the fs.* cel.
        await ensureSegments(state, ["file-store"]);
        const call = (k: string, ...a: unknown[]) => (resolveFn(state, k) as Fn)(...a);
        const op = String(req.originFs);
        const p = String(req.path ?? "");
        if (op === "ls") {
          const names = ((await call("fs.list", p)) as string[]).slice().sort();
          const lines = await Promise.all(names.map(async (n) => {
            const st = await (call("fs.stat", fsJoin(p, n)) as Promise<{ isDir?: boolean }>).catch(() => null);
            return st?.isDir ? `${n}/` : n;
          }));
          result = lines.length ? lines.join("\n") : "(empty)";
        } else if (op === "tree") {
          result = await fsTree(state, p) || "(empty)";
        } else if (op === "mkdir") {
          await call("fs.mkdir", p); result = `mkdir ${p}`;
        } else if (op === "rm") {
          const st = await (call("fs.stat", p) as Promise<{ isDir?: boolean }>).catch(() => null);
          if (st?.isDir) await call("fs.rmdir", p); else await call("fs.delete", p);
          result = `rm ${p}`;
        } else if (op === "mv") {
          await call("fs.rename", p, String(req.to)); result = `mv ${p} → ${req.to}`;
        } else if (op === "cat") {
          result = await call("fs.readText", p);
        } else if (op === "write") {
          await call("fs.writeText", p, String(req.text ?? "")); result = `wrote ${p}`;
        } else if (op === "touch") {
          if (!(await call("fs.exists", p))) await call("fs.writeText", p, "");
          result = `touch ${p}`;
        } else if (op === "stat") {
          const st = (await call("fs.stat", p)) as { size?: number; isDir?: boolean; mtime?: unknown };
          result = yamlDoc([["path", p], ["isDir", st.isDir], ["size", st.size], ["mtime", st.mtime != null ? String(st.mtime) : undefined]]);
        } else result = `(unknown fs op: ${op})`;
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
        // sqlite — open a db (sql.js, OPFS-backed) or run a query.
        const op = String(req.originDb);
        const name = String(req.name ?? "main");
        if (op === "open") {
          await openDb(state, name);
          result = { __db: name };                 // a handle sql()/tables() accept
        } else if (op === "sql") {
          const db = await openDb(state, name);
          const query = String(req.query ?? "");
          const res = db.exec(query);
          if (WRITE_SQL.test(query)) await persistDb(state, name, db);
          if (res.length && res[0]!.values.length) {
            const { columns, values } = res[0]!;
            result = values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
          } else result = res.length ? [] : "ok";
        } else result = `(unknown db op: ${op})`;
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
  ["originView",     originView],
  ["dom",            dom],
  ["style",          style],
  ["attr",           attr],
  ["mount",          mount],
  ["origin.commit",  commit],
  ["origin.edit",    edit],
  ["origin.key",     key],
  ["cels",           grid],
  ["grid",           grid],
  ["cel",            celFn],
  ["at",             at],
  ["doc",            doc],
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
  ["save",           saveFn],
  ["open",           openFn],
  ["origin.autoload", autoload],
]));
