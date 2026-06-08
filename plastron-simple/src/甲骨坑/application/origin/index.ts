import type {
  甲骨, Cel, ChannelEnqueue, Fn, Key, State,
} from "../../../types/index.js";
import {
  bindNativeFns, resolveFn, ensureSegments, appendError, makeCelError,
} from "../../../kernel/index.js";
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

type V = { type: "el" | "text"; tag?: string; key?: string; attrs?: Record<string, unknown>; events?: Record<string, unknown>; children?: V[]; text?: string };
const T = (s: unknown): V => ({ type: "text", text: String(s ?? "") });
const el = (tag: string, attrs: Record<string, unknown>, children: V[], events?: Record<string, unknown>): V =>
  ({ type: "el", tag, attrs, children, ...(events ? { events } : {}) });

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

const dom: Fn = (tag: unknown, ...children: unknown[]): V => {
  const spec = String(tag ?? "div");
  const dot = spec.indexOf(".");
  const name = dot === -1 ? spec : spec.slice(0, dot);
  const cls = dot === -1 ? undefined : spec.slice(dot + 1).replace(/\./g, " ");
  // a (style …) child sets inline style; the rest are children
  let style: Record<string, unknown> | undefined;
  const kids: V[] = [];
  for (const c of children) {
    if (isStyle(c)) { style = { ...style, ...c.__style }; continue; }
    kids.push(isVnode(c) ? c : T(c));
  }
  const attrs = cls ? { class: cls } : undefined;
  return {
    type: "el", tag: name || "div",
    ...(attrs ? { attrs } : {}),
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
    if (typeof o.__mount === "string") return T(`→ ${o.__mount}`); // spliced into a node of the view; renders there, not here
    try { return T(JSON.stringify(v).slice(0, 60)); } catch { return T("#ERR!"); }
  }
  // a multi-line string (inspect output, a paragraph) keeps its shape in a
  // <pre>; inline it stays a one-line preview (.cell-value clips it), but
  // the ⤢ expand panel shows it formatted top-to-bottom.
  if (typeof v === "string" && v.includes("\n")) return el("pre", { class: "cell-pre" }, [T(v)]);
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
  editing: unknown, draft: unknown, mount: unknown, error: unknown, keys: unknown, vals: unknown,
) => {
  const ks = Array.isArray(keys) ? (keys as string[]) : ["元"];
  const vs = Array.isArray(vals) ? (vals as unknown[]) : [];
  const active = typeof editing === "string" ? editing : null;
  const errMsg = typeof error === "string" ? error : null;
  const valOf = new Map<string, unknown>(); ks.forEach((k, i) => valOf.set(k, vs[i]));

  // the editor input, plus an error line when its last formula failed to
  // compile (so a syntax error shows instead of doing nothing)
  const editor = (key: string): V =>
    el("div", { class: "cell-editing" }, [
      el("input", { class: "cell-edit", value: String(draft ?? "") }, [], {
        input: { set: "元.draft", extract: "value" },
        keydown: { dispatch: "origin.key", payload: key }, // origin.key commits on Enter
      }),
      ...(errMsg ? [el("div", { class: "cell-error" }, [T(errMsg)])] : []),
    ]);

  // the inner of a cell: inline editor when active, else the value. CLICK
  // the value to edit it — the one edit gesture, working for grid cells
  // (which have no label) and for 元.
  const body = (key: string, value: unknown): V => {
    if (active === key) return editor(key);
    // wrap the value in an element so it's the flex:1 child of .cell-value
    const shown = displayCell(value);
    const valEl = shown.type === "text" ? el("span", { class: "cell-val-text" }, [shown]) : shown;
    return el("div", { class: "cell-value", title: "click to edit" }, [valEl],
      { click: { dispatch: "origin.edit", payload: key } });
  };

  // base sheet: 元 as a labelled button-box (the "元 button")
  const baseCell = (key: string, value: unknown): V =>
    el("div", { class: active === key ? "cell zhorigin editing" : "cell zhorigin", "data-key": key },
      [el("div", { class: "cell-label" }, [T("元")], { click: { dispatch: "origin.edit", payload: key } }), body(key, value)]);

  // a grid layer → an Excel-style table
  const gridTable = (layer: string, members: string[]): V => {
    let maxC = 0, maxR = 0;
    const at = new Map<string, string>();
    for (const k of members) {
      const a = addrOf(k); if (!a) continue;
      at.set(`${a.col},${a.row}`, k); maxC = Math.max(maxC, a.col); maxR = Math.max(maxR, a.row);
    }
    const colLetter = (c: number): string => { let s = "", n = c + 1; while (n > 0) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); } return s; };
    const head = el("tr", {}, [el("th", { class: "corner" }, [T(layer)]),
      ...Array.from({ length: maxC + 1 }, (_, c) => el("th", {}, [T(colLetter(c))]))]);
    const rows = Array.from({ length: maxR + 1 }, (_, r) =>
      el("tr", {}, [el("th", { class: "rownum" }, [T(String(r + 1))]),
        ...Array.from({ length: maxC + 1 }, (_, c) => {
          const k = at.get(`${c},${r}`);
          return el("td", { class: k && active === k ? "cell editing" : "cell", "data-key": k ?? "" },
            k ? [body(k, valOf.get(k))] : []);
        })]));
    // wrap in a horizontal scroller so a wide grid reaches column A
    // (a centered overflowing table clips its left edge unreachably).
    return el("div", { class: "grid-scroll" }, [el("table", { class: "grid" }, [el("thead", {}, [head]), el("tbody", {}, rows)])]);
  };

  // group: base cels (no dot) vs grid layers (segment before the dot)
  const base: string[] = []; const layers = new Map<string, string[]>();
  for (const k of ks) {
    const dot = k.indexOf(".");
    if (dot === -1) base.push(k);
    else { const lr = k.slice(0, dot); (layers.get(lr) ?? layers.set(lr, []).get(lr))!.push(k); }
  }

  const sections: V[] = base.map((k) => baseCell(k, valOf.get(k)));
  for (const [layer, members] of layers) sections.push(gridTable(layer, members));

  // PLACED dom — a cell whose value is mount(target, content). The dom is
  // spliced into the first node of THIS view matching `target` (a node the
  // origin renders: ".sheet", ".region-top", "div.cell", …) and renders
  // there, not in its cell. A bare word that matches no node is a region
  // anchor the origin lays out around the sheet ("top" above, "bottom"
  // below, others above in name order). Delete the formula → it's gone.
  const placements: { sel: string; vnode: V }[] = [];
  for (const k of ks) {
    const v = valOf.get(k) as { __mount?: unknown; vnode?: unknown } | undefined;
    if (v && typeof v === "object" && typeof v.__mount === "string" && isVnode(v.vnode)) {
      placements.push({ sel: v.__mount, vnode: v.vnode as V });
    }
  }

  const sheetNode = el("div", { class: "sheet" }, sections);
  const topRegion = el("div", { class: "region region-top" }, []);
  const bottomRegion = el("div", { class: "region region-bottom" }, []);
  const originNode = el("div", { class: "origin" }, [topRegion, sheetNode, bottomRegion]);
  const extraRegions = new Map<string, V>();

  for (const { sel, vnode } of placements) {
    const p = parseSel(sel);
    let target = p ? findNode(originNode, p) : null;
    if (!target) {
      const named = sel.trim().replace(/^[.#]/, "") || "top";
      target = named === "top" ? topRegion : named === "bottom" ? bottomRegion
        : (extraRegions.get(named) ?? extraRegions.set(named, el("div", { class: `region region-${named}` }, [])).get(named)!);
    }
    (target.children ??= []).push(vnode);
  }
  originNode.children = [topRegion, ...[...extraRegions.keys()].sort().map((n) => extraRegions.get(n)!), sheetNode, bottomRegion];

  return { vnode: originNode, mount: typeof mount === "string" ? mount : null, listeners: [] };
};

/** mount(target, content) — PLACE a dom object UNDER another element of the
 *  sheet, instead of inside the cell that holds the formula. `target` is a
 *  simple selector matched against the origin's own render tree: ".sheet"
 *  pins under the cells, ".region-top"/"top" in a region the origin lays
 *  out around the sheet, "div.cell" under the first cell, "#id" by id. The
 *  origin view owns #app and re-paints every frame, so mount splices into
 *  the SPEC (reconciled like everything else) rather than the live DOM —
 *  this is why it's a selector into the view, not an xpath into the page.
 *  Vanishes when the formula is deleted; no painter-target conflict. */
const mount: Fn = (target: unknown, content: unknown): unknown =>
  ({ __mount: String(target ?? "top"), vnode: isVnode(content) ? content : T(content) });

// Build the genesis request for ONE named grid (rows×cols of empty
// infix cels under `name.A1` …). Shared by grid() and sheets().
const gridShape = (rows: unknown, cols: unknown, name: string): { layer: string; cels: Record<string, unknown> } => {
  const r = Math.max(1, Math.min(100, Math.floor(Number(rows) || 1))); // capped — true million-scale needs virtualization (excel-scale roadmap)
  const c = Math.max(1, Math.min(50, Math.floor(Number(cols) || 1)));
  const colLetter = (n: number): string => { let s = "", x = n + 1; while (x > 0) { s = String.fromCharCode(65 + (x - 1) % 26) + s; x = Math.floor((x - 1) / 26); } return s; };
  const cels: Record<string, unknown> = {};
  for (let row = 0; row < r; row++) {
    for (let col = 0; col < c; col++) {
      const addr = `${colLetter(col)}${row + 1}`;
      cels[`${name}.${addr}`] = { celType: "ValueCel", v: "", metadata: { name: addr, parser: "infix" } };
    }
  }
  return { layer: name, cels };
};

/** grid — a genesis vocabulary that adds worksheets of editable cels,
 *  each like 元. Two shapes from ONE formula:
 *    grid(rows, cols)            → one sheet, auto-named g<r>x<c>
 *    grid(rows, cols, "name")    → one named sheet
 *    grid("in", 4, 3, "out", 4, 3) → a WORKBOOK of named sheets (a string
 *                                    first arg switches to name,r,c triples)
 *  The auto name g<r>x<c> means different-shaped grids never collide — a
 *  grid in a cell of another grid just works. Delete the formula → swept. */
const grid: Fn = (...args: unknown[]): unknown => {
  // string first arg → workbook of (name, rows, cols) triples.
  if (typeof args[0] === "string") {
    const cels: Record<string, unknown> = {};
    for (let i = 0; i + 2 < args.length; i += 3) {
      const nm = String(args[i] ?? "").trim() || `s${i / 3 + 1}`;
      Object.assign(cels, gridShape(args[i + 1], args[i + 2], nm).cels);
    }
    return { genesis: true, cels };
  }
  // numbers → one sheet: (rows, cols [, name]).
  const [rows, cols, nameArg] = args;
  const name = typeof nameArg === "string" && nameArg !== "" ? nameArg
    : `g${Math.max(1, Math.min(100, Math.floor(Number(rows) || 1)))}x${Math.max(1, Math.min(50, Math.floor(Number(cols) || 1)))}`;
  return { genesis: true, ...gridShape(rows, cols, name) };
};

// ── the entry gesture ────────────────────────────────────────────────────────

const sniff = (src: string): { celType: string; f?: string; v?: unknown; parser?: string } => {
  const t = src.trim();
  if (t.startsWith("=")) return { celType: "FormulaCel", f: t, parser: "infix" };
  if (t.startsWith("(")) return { celType: "FormulaCel", f: t, parser: "f" };
  const n = Number(t);
  return { celType: "ValueCel", v: t !== "" && !Number.isNaN(n) ? n : src };
};

const VIEW_KEY = "元.view";
const README = "(mount \"top\"\n  (dom \"div.readme\" (style \"max-width\" \"46rem\" \"margin\" \"0 auto\" \"padding\" \"1.1rem 1.3rem\" \"border\" \"1px solid #8884\" \"border-radius\" \".7rem\" \"background\" \"#8881\" \"font\" \"13px/1.55 ui-monospace, monospace\")\n    (canvas 540 96 (rect 0 0 540 96 \"#16161f\") (text 18 40 \"plastron 🐢\" \"#f5f5f7\" \"bold 26px system-ui\") (text 18 72 \"a spreadsheet that draws — this banner is a =canvas formula\" \"#8a8a99\" \"13px system-ui\") (rect 372 66 16 20 \"#4a90d9\") (rect 394 54 16 32 \"#5fb0e8\") (rect 416 42 16 44 \"#7fd0ff\") (rect 438 58 16 28 \"#5fb0e8\") (rect 460 48 16 38 \"#7fd0ff\") (circle 506 40 13 \"#e6677a\"))\n    (dom \"p\" (style \"margin\" \".8rem 0 .4rem\" \"color\" \"#888\" \"font-family\" \"system-ui\") \"every formula starts with = — try these in any cell:\")\n    (dom \"pre\" (style \"margin\" \".12rem 0\") \"=1 + 1\")\n    (dom \"pre\" (style \"margin\" \".12rem 0\") \"=grid(8, 5)              a worksheet of editable cels\")\n    (dom \"pre\" (style \"margin\" \".12rem 0\") \"=grid(\\\"in\\\", 4, 3, \\\"out\\\", 4, 3)   a workbook of named sheets\")\n    (dom \"pre\" (style \"margin\" \".12rem 0\") \"=def(\\\"double\\\", \\\"js\\\", \\\"x => x * 2\\\")   a function from javascript\")\n    (dom \"pre\" (style \"margin\" \".12rem 0\") \"=double(21)                call your function -> 42\")\n    (dom \"pre\" (style \"margin\" \".12rem 0\" \"color\" \"tomato\") \"=canvas(300, 80, rect(0,0,300,80,\\\"#222\\\"), text(14,46,\\\"hi\\\",\\\"#fff\\\"))   draw on a canvas\")\n    (dom \"pre\" (style \"margin\" \".12rem 0\") \"=dom(\\\"h2\\\", style(\\\"color\\\", \\\"tomato\\\"), \\\"styled\\\")\")\n    (dom \"pre\" (style \"margin\" \".12rem 0\") \"=mount(\\\".sheet\\\", dom(\\\"p\\\", \\\"under the cells\\\"))  pin dom under an element\")\n    (dom \"pre\" (style \"margin\" \".12rem 0\") \"=inspect(\\\"mount\\\")           a function: signature + source\")\n    (dom \"pre\" (style \"margin\" \".12rem 0\") \"=segments()                loaded libraries\")\n    (dom \"pre\" (style \"margin\" \".12rem 0\") \"=vocab(\\\"origin\\\")            what you can call\")\n    (dom \"pre\" (style \"margin\" \".12rem 0\") \"=grok(\\\"say hi in 5 words\\\", key)   chat with grok (key = a cel holding your api key)\")\n    (dom \"pre\" (style \"margin\" \".12rem 0\") \"=checkpoint(\\\"safe\\\")          a snapshot to restore\")\n    (dom \"pre\" (style \"margin\" \".12rem 0\") \"=load(\\\"sheet\\\")              load a library\")\n    (dom \"p\" (style \"margin\" \".7rem 0 0\" \"font-size\" \".82rem\" \"font-family\" \"system-ui\") \"this whole page is one index.html — no install, no PWA. the ↓ save button keeps a copy with your sheet baked in; double-click it to run offline from your desktop.\")\n    (dom \"p\" (style \"margin\" \".4rem 0 0\" \"color\" \"#888\" \"font-size\" \".82rem\" \"font-family\" \"system-ui\") \"click 元 to edit this; clear it to bring it back.\")))";

/** The current spreadsheet cell list: 元 (A1) plus every genesis-created
 *  DATA cel (grid cells), sorted. Rebuilt after each commit so new grids
 *  show and swept ones vanish. */
const cellKeys = (state: State): string[] => {
  const out: string[] = ["元"];
  for (const [k, c] of state.cels) {
    if (k === "元") continue;
    const md = c.metadata as { generatedBy?: Key };
    if (md.generatedBy && (c.celType === "ValueCel" || c.celType === "FormulaCel")) out.push(k);
  }
  return [out[0]!, ...out.slice(1).sort()];
};

// 元.view's `vals` is an ARRAY inputMap of the cell keys (→ array of
// values); `keys` is the same list as a value cel. Rewire both so the
// view re-fires against the live cell set.
const rewireView = async (state: State, keys: string[]): Promise<void> => {
  const im = { ...(state.cels.get(VIEW_KEY)?.metadata.inputMap as Record<string, Key | Key[]>) };
  im.vals = keys;
  await (resolveFn(state, "setValue") as Fn)(state, "元.cells", keys);
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
  // fire generators so they enqueue, then commit structure + sweep…
  await (resolveFn(state, "runCycle") as Fn)(state);
  const drain = resolveFn(state, "drain") as Fn;
  for (const ch of ["genesis.commit", "defn.commit", "checkpoint.commit", "origin.effects"]) {
    if (state.cels.get(ch)) await drain(state, ch);
  }
  const gd = resolveFn(state, "genesis.drain") as Fn | undefined; if (gd) await gd([], state);
  const dd = resolveFn(state, "defn.drain") as Fn | undefined; if (dd) await dd([], state);
  // …rebuild the cell list (new grids in, swept cels out), re-fire, paint.
  await rewireView(state, cellKeys(state));
  await (resolveFn(state, "runCycle") as Fn)(state);
  await drain(state, "plastron-dom.paint");
  return state;
};

const key: Fn = async (state: State, payload: unknown, event: unknown) => {
  const e = event as { key?: string; preventDefault?: () => void } | undefined;
  if (e?.key === "Enter") {
    e.preventDefault?.();
    await commit(state, payload);
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
  ["mount",          mount],
  ["origin.commit",  commit],
  ["origin.edit",    edit],
  ["origin.key",     key],
  ["grid",           grid],
  ["origin.drain",   effectsDrain],
  ["load",           loadFn],
  ["cels",           celsFn],
  ["inspect",        inspectFn],
  ["segments",       segmentsFn],
  ["vocab",          vocabFn],
  ["def",            defFn],
  ["chat",           chatFn],
  ["grok",           grokFn],
]));
