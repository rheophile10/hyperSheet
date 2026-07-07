import type { 甲骨, Cel, Fn, State, VNode, AttrValue, EventBinding } from "../../../types/index.js";
import { bindNativeFns, isCelError, resolveFn, retireCel, precompute } from "../../../kernel/index.js";
import { el as makeEl, text as T, memo } from "../dom/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// sheets — the NATIVE spreadsheet grid, as reusable lambdas (windowing-architecture.md).
// SHEET-UNIQUE rendering only: the Excel grid (table + cells + inline editor). It is
// the perf fast path (memo'd cells), and it produces a CONTENT vnode — a `window` tab
// hosts it, so a worksheet tabs next to any other app. Generic toolbars live in
// `winapps`; the window frame lives in `window`. No frame here, no host wiring — a
// host (origin) aggregates the cells and calls sheetgrid; this segment just draws.
// ============================================================================

type V = VNode;
const el = makeEl as unknown as (tag: string, attrs?: Record<string, AttrValue>, children?: V[], events?: Record<string, EventBinding>) => V;
// memo over the local V alias (el always builds elements; VText never flows here)
const memoV = memo as unknown as (node: V, sig: unknown) => V;
const isVnode = (v: unknown): v is V => !!v && typeof v === "object" && ((v as { type?: unknown }).type === "el" || (v as { type?: unknown }).type === "text");

const SX = {
  scroll: "overflow-x:auto;max-width:100%",
  table: "border-collapse:collapse;font-variant-numeric:tabular-nums",
  th: "border:1px solid #8883;background:#8881;text-align:center;color:#888;font-weight:600;font-size:.8rem;font-family:ui-monospace,monospace;min-width:1.8rem;padding:0 .35rem;height:1.9rem",
  corner: "border:1px solid #8883;background:#8881;text-align:center;color:#aaa;font-weight:700;font-size:.8rem;font-family:ui-monospace,monospace;padding:0 .35rem;height:1.9rem",
  td: "border:1px solid #8883;padding:0;height:1.9rem;text-align:left;vertical-align:top;cursor:cell",
  // content-visibility:auto — the browser skips layout/paint of offscreen cell
  // CONTENT (tall grids render nearly free; `auto` intrinsic-size remembers the
  // last real size so scrollbars stay honest). On the inner div, NOT the tr:
  // containment is ignored on internal table elements, so tr can't have it.
  cellValue: "display:flex;align-items:flex-start;padding:.15rem .4rem;min-height:1.6rem;font-family:ui-monospace,monospace;font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;content-visibility:auto;contain-intrinsic-size:auto 4.5rem auto 1.6rem",
  edit: "width:100%;box-sizing:border-box;min-height:2.4rem;resize:vertical;font-family:ui-monospace,monospace;font-size:.85rem;padding:.15rem .4rem;border:0;background:#4a90d922;white-space:pre-wrap;line-height:1.4",
  // the formula bar (Excel edit surface): a cell-ref label ‖ ⚡ fire ‖ 📖 wiki ‖
  // 🔗 topology ‖ a textarea bound to the draft cel. Sits above the grid (sheetpane
  // stacks them). OPAQUE (Canvas) + position:sticky so a scrolling grid never bleeds
  // through it or scrolls a classic scrollbar over it.
  fxbar: "flex:0 0 auto;position:sticky;top:0;z-index:6;display:flex;align-items:stretch;gap:.3rem;padding:.25rem .35rem;background:Canvas;border-bottom:1px solid #8884;box-shadow:0 1px 0 #0001",
  fxref: "flex:0 0 auto;align-self:center;min-width:2.4rem;text-align:center;font:600 .8rem ui-monospace,monospace;color:#888;padding:0 .25rem;white-space:nowrap",
  fxbtn: "flex:0 0 auto;align-self:center;border:1px solid #8884;background:#8881;border-radius:.25rem;cursor:pointer;font-size:.95rem;line-height:1;padding:.15rem .4rem",
  fxinput: "flex:1 1 auto;box-sizing:border-box;min-height:1.7rem;max-height:8rem;resize:vertical;font-family:ui-monospace,monospace;font-size:.82rem;line-height:1.35;padding:.18rem .4rem;border:1px solid #8884;border-radius:.2rem;background:Canvas;color:CanvasText;white-space:pre",
  // overflow:hidden clips the pane to its window body so ONLY the grid scrolls —
  // the outer body never grows a scrollbar that would run over the formula bar.
  pane: "display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden",
  paneBody: "flex:1 1 auto;overflow:auto;min-height:0",
} as const;

const colLetter = (c: number): string => { let s = "", n = c + 1; while (n > 0) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); } return s; };

// sheetcell(value) — render ONE cell value: a number/string as text; a vnode (a
// formula that built dom/canvas/a chart) renders in place; a cel error / object shows
// its text. The leaf of the grid; reusable on its own.
const displayCell = (v: unknown): V => {
  if (v === null || v === undefined || v === "") return T("");
  if (isVnode(v)) return v as V;
  if (isCelError(v)) return T(String((v as { code?: unknown }).code ?? v));
  // a CALLABLE value (a =LAMBDA cell, a lambda cel's fn) — a quiet ƒ instead
  // of the compiled closure's JS source; the formula bar carries the readable
  // definition (the `ƒ name` convention).
  if (typeof v === "function") return T("ƒ");
  if (typeof v === "object") {
    // a BINDER's value (the defn request =WAT/=JS/=FORMULA computes) — show
    // what it mints instead of the raw request JSON.
    const r = v as { defn?: unknown; name?: unknown; kind?: unknown };
    if (r.defn === true && typeof r.name === "string") return T(`ƒ→ ${r.name} (${String(r.kind ?? "")})`);
    // a GENERATIVE formula's token (=view / =append / =sheet keep their
    // formula; the value is a recognizable handle to the thing the formula
    // made — the `ƒ name` convention). ⧉ = a view pane, ▦ = a worksheet.
    const t = v as { view?: unknown; sheet?: unknown; item?: unknown };
    if (typeof t.view === "string" && Object.keys(t).every((k) => k === "view" || k === "item")) {
      return T(`⧉ ${t.view}${t.item ? " +" : ""}`);
    }
    if (typeof t.sheet === "string" && Object.keys(t).length === 1) {
      return T(`▦ ${t.sheet}`);
    }
    // an =kvseed cell's token — defaults merged into a user kv segment.
    const kvs = v as { kvseed?: unknown; added?: unknown };
    if (typeof kvs.kvseed === "string" && Object.keys(kvs).every((k) => k === "kvseed" || k === "added")) {
      return T(`⚙ ${kvs.kvseed} defaults${kvs.added ? ` +${kvs.added}` : ""}`);
    }
    // an un-landed REQUEST (the drain hasn't run yet) — show a quiet pending
    // mark instead of flashing raw JSON for a frame.
    const ks = Object.keys(v);
    if (ks.length === 1 && /^origin[A-Z]/.test(ks[0]!)) return T("⋯");
    return T(JSON.stringify(v));
  }
  return T(String(v));
};
const sheetcell: Fn = ((value: unknown): V => displayCell(value)) as Fn;

interface CellEntry { key?: string; col?: number; row?: number; value?: unknown; src?: unknown }
interface GridOpts { active?: string; selected?: string; draft?: string; draftVal?: string; edit?: string; select?: string; fire?: string; commit?: string; wiki?: string; topo?: string; ask?: string }
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ── row/column SIZES (Excel-style resize) ────────────────────────────────────
// Sizes are DATA: `<seg>.colw` / `<seg>.rowh` ValueCels hold SPARSE dicts
// ({"B":120} / {"2":40} — column letter / 1-based row number → px). Only
// overridden columns/rows appear; defaults stay implicit in the CSS. The cels
// carry metadata.segment = the sheet's segment, so resizes archive with the
// document and sync like any cel. sheetgrid takes them as OPTIONAL trailing
// args (absent / 0 → all defaults), and the grid formula references them so a
// resize re-renders through the graph (the <seg>.dims pattern).
const sizeOf = (dict: unknown, key: string): number => {
  if (!dict || typeof dict !== "object" || Array.isArray(dict)) return 0;
  const n = Number((dict as Record<string, unknown>)[key]);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
// the drag hit zone on a header edge: a few px, straddling the border.
const HANDLE = "position:absolute;z-index:3;touch-action:none;user-select:none";
const sizeHandle = (seg: string, kind: "col" | "row", key: string): V =>
  el("div", {
    class: kind === "col" ? "col-resize" : "row-resize",
    [`data-${kind}`]: key,
    title: "drag to resize; double-click to reset",
    style: `${HANDLE};${kind === "col" ? "top:0;right:-3px;width:7px;height:100%;cursor:col-resize" : "left:0;bottom:-3px;height:7px;width:100%;cursor:row-resize"}`,
  }, [], {
    pointerdown: { dispatch: "sheet.resizeGrab", payload: { seg, kind, key } },
    pointermove: { dispatch: "sheet.resizeMove" },
    pointerup:   { dispatch: "sheet.resizeDrop" },
    dblclick:    { dispatch: "sheet.resizeReset", payload: { seg, kind, key } },
  });

// sheetgrid(label, cells, opts?, dims?, colw?, rowh?) — render a worksheet's cells
// as an editable Excel grid CONTENT vnode (corner label + column letters + row
// numbers + cells). `cells` is the host-aggregated list [{ key, col, row, value,
// src }]; `opts` carries the active (editing) + selected cell keys, the draft cel,
// and the handler keys to dispatch (defaults to origin.*). The active cell shows an
// inline editor; others show the value and dispatch select (click) / edit
// (double-click).
//
// SPARSE model: `dims` ({rows, cols} — the <seg>.dims cel) sets the RENDERED range;
// addresses without a backing cel render as live empty cells whose key is synthesized
// from `label` (the segment name) — select/edit/commit all carry the ADDRESSED key, so
// the cel is born only when a value/formula is actually committed. Extent =
// max(dims, populated). No dims (legacy callers) → populated extent only.
//
// `colw`/`rowh` are the sparse size dicts (see above); when `label` names a segment
// the headers grow drag handles (sheet.resizeGrab/Move/Drop, dblclick resets).
const sheetgrid: Fn = ((label: unknown, cells: unknown, opts?: unknown, dims?: unknown, colw?: unknown, rowh?: unknown): V => {
  const o = (opts && typeof opts === "object") ? opts as GridOpts : {};
  const EDIT = o.edit ?? "origin.edit", SEL = o.select ?? "origin.select", FIRE = o.fire ?? "origin.fire";
  const COMMIT = o.commit ?? "origin.key", DRAFT = o.draft ?? "元.draft";
  const active = typeof o.active === "string" ? o.active : null;
  const selected = typeof o.selected === "string" ? o.selected : null;
  // the active cell's edit buffer (元.draft) — what the inline editor SHOWS, so it
  // displays the formula SOURCE (not the computed value) and, on type-to-edit, the
  // freshly-typed char. null = fall back to the cell value (legacy callers).
  const draftVal = typeof o.draftVal === "string" ? o.draftVal : null;
  const list = Array.isArray(cells) ? cells as CellEntry[] : [];
  const seg = typeof label === "string" && label ? label : "";
  const d = (dims && typeof dims === "object") ? dims as { rows?: unknown; cols?: unknown } : undefined;
  let maxC = Math.max(0, Math.trunc(num(d?.cols, 0)) - 1);
  let maxR = Math.max(0, Math.trunc(num(d?.rows, 0)) - 1);
  const at = new Map<string, CellEntry>();
  for (const e of list) { const c = num(e.col), r = num(e.row); at.set(`${c},${r}`, e); maxC = Math.max(maxC, c); maxR = Math.max(maxR, r); }
  // per-column width / per-row height overrides (0 = default). Widths pin the
  // column hard (width+min+max, border-box) so the table can't stretch it back;
  // heights ride the td (a collapse-table td height acts as the row's).
  const wOf = (c: number): number => sizeOf(colw, colLetter(c));
  const hOf = (r: number): number => sizeOf(rowh, String(r + 1));
  const wCss = (w: number): string => w ? `;width:${w}px;min-width:${w}px;max-width:${w}px;box-sizing:border-box` : "";
  const hCss = (h: number): string => h ? `;height:${h}px` : "";

  // autofocus: when a cell becomes the active editor (double-click, or type-to-edit
  // via origin.gridkey) the inline editor mounts focused with the caret at the end,
  // so the user is typing IN THE CELL immediately (the formula bar mirrors 元.draft).
  const editor = (key: string, value: unknown): V =>
    el("textarea", { class: "cell-edit", style: SX.edit, rows: 1, value: String(value ?? ""), "data-key": key, autofocus: "" }, [], {
      input: { set: DRAFT, extract: "value" },
      keydown: { dispatch: COMMIT, payload: key },
    });
  const body = (key: string, value: unknown, rh: number, w: number): V => {
    if (active === key) return editor(key, draftVal != null ? draftVal : value);
    const shown = displayCell(value);
    const inner = shown.type === "text" ? el("span", { class: "cell-val-text" }, [shown]) : shown;
    // a custom row height owns the vertical extent — drop the default min-height
    // so rows can shrink below the stock 1.6rem.
    // TEXT CLAMP: without an explicit column width, long text must not stretch
    // the column past reach (a wall of wat blows the whole sheet's scroll) —
    // clamp the inner div (max-width on a td is unreliable in auto table
    // layout), let the ellipsis clip, and the formula bar carries the full
    // source. Rich vnode content (charts, dom) keeps its natural size; an
    // explicit column width (resize grip / colw dict) overrides the clamp.
    const clamp = shown.type === "text" && !w ? ";max-width:24rem" : "";
    return el("div", { class: "cell-value", "data-key": key, title: "click to select; double-click to edit", style: SX.cellValue + (rh ? ";min-height:0" : "") + clamp }, [inner],
      { click: { dispatch: SEL, payload: key }, dblclick: { dispatch: EDIT, payload: key } });
  };

  // MEMO HINTS (the diff's O(changed) fast path, diff.ts memoEq): each th/td
  // carries a shallow signature of everything its subtree renders from. A
  // selection move re-diffs exactly TWO cells (old + new); a value commit
  // re-diffs one; everything else NOOPs without a deep compare. draftVal is
  // in the signature only for the ACTIVE cell so typing never busts the rest.
  const head = el("tr", {}, [el("th", { class: "corner", style: SX.corner }, [T(String(label ?? ""))]),
    ...Array.from({ length: maxC + 1 }, (_, c) => {
      const letter = colLetter(c);
      return memoV(el("th", { "data-col": letter, style: SX.th + ";position:relative" + wCss(wOf(c)) },
        seg ? [T(letter), sizeHandle(seg, "col", letter)] : [T(letter)]), [letter, wOf(c)]);
    })]);
  const rows = Array.from({ length: maxR + 1 }, (_, r) => {
    const rh = hOf(r);
    return el("tr", {}, [
      memoV(el("th", { class: "rownum", "data-row": String(r + 1), style: SX.th + ";position:relative" + hCss(rh) },
        seg ? [T(String(r + 1)), sizeHandle(seg, "row", String(r + 1))] : [T(String(r + 1))]), [r, rh]),
      ...Array.from({ length: maxC + 1 }, (_, c) => {
        const e = at.get(`${c},${r}`);
        // sparse: no backing cel — synthesize the addressed key so the empty
        // cell is fully live (select/edit/commit birth the cel on demand).
        const key = e?.key ?? (seg ? `${seg}.${colLetter(c)}${r + 1}` : "");
        const w = wOf(c);
        const size = (w ? wCss(w) : ";min-width:4.5rem") + hCss(rh);
        if (!key) return memoV(el("td", { class: "cell", "data-key": "", style: `${SX.td}${size}` }, []), ["", w, rh]);
        const isActive = active === key, isSel = selected === key;
        const outline = isActive ? ";outline:2px solid #4a90d9;outline-offset:-2px" : (isSel ? ";outline:2px solid #4a90d999;outline-offset:-2px" : "");
        void FIRE;
        return memoV(
          el("td", { class: isActive ? "cell editing" : (isSel ? "cell selected" : "cell"), "data-key": key, style: `${SX.td};position:relative${size}${outline}` }, [body(key, e?.value, rh, w)]),
          [key, e?.value, isActive, isSel, isActive ? draftVal : null, w, rh]);
      })]);
  });
  return el("div", { class: "grid-scroll", style: SX.scroll }, [el("table", { class: "grid", style: SX.table }, [el("thead", {}, [head]), el("tbody", {}, rows)])]);
}) as Fn;

// gridopts(active, selected) — build the sheetgrid opts object from the editing /
// selected cell-key cels (e.g. 元.editing / 元.selected) so a worksheet is EDITABLE
// in a workbook tab: the active cell shows the inline editor, a click selects.
// Handlers (edit/select/fire/commit) + the draft cel default to origin.* / 元.draft
// inside sheetgrid; referencing the editing cels in the grid formula makes it
// re-render reactively as the active/selected cell changes.
const gridopts: Fn = ((active?: unknown, selected?: unknown, draftVal?: unknown): unknown =>
  ({ active: typeof active === "string" ? active : null, selected: typeof selected === "string" ? selected : null,
     draftVal: typeof draftVal === "string" ? draftVal : null })) as Fn;

// sheetbar(selected, draft, opts?) — the Excel FORMULA BAR: a cell-ref label, a ⚡
// fire button, and a textarea that EDITS the selected cell's source. `selected` is
// the selected cell KEY (e.g. "元" / "g3x3.A1"); `draft` is the source text to show
// (seeded into the draft cel on select — reference an ASCII mirror like sheet.draft
// in the formula so the bar re-renders on selection). The textarea's `input` writes
// the live text into the draft cel (opts.draft, default "元.draft") WITHOUT re-rendering
// the bar (so typing never churns the grid); Enter (keydown → opts.commit) and ⚡
// (opts.fire) commit it to the selected cell. Stack it over a grid with sheetpane.
const sheetbar: Fn = ((selected: unknown, draft: unknown, writable?: unknown, askable?: unknown, opts?: unknown): V => {
  const o = (opts && typeof opts === "object") ? opts as GridOpts : {};
  const DRAFT = o.draft ?? "元.draft", COMMIT = o.commit ?? "origin.key", FIRE = o.fire ?? "origin.fire";
  const WIKI = o.wiki ?? "wiki.open", TOPO = o.topo ?? "origin.celtopo", ASK = o.ask ?? "origin.askgrok";
  // gate: a RESTRICTED sheet (your identity isn't in <seg>.writers) is read-only.
  // Default (writable undefined/true) keeps every ordinary sheet editable.
  const canWrite = writable !== false;
  const key = typeof selected === "string" && selected ? selected : null;
  const ref = key ? (key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key) : "";
  const refSpan = el("span", { class: "fx-ref", style: SX.fxref, title: key ?? "" }, [T(ref)]);
  const fireBtn = canWrite
    ? el("button", { class: "fx-fire", title: "fire — run this formula (Enter)", style: SX.fxbtn }, [T("⚡")],
        { click: { dispatch: FIRE, payload: key ?? "" } })
    : el("span", { class: "fx-lock", title: "read-only — you are not a writer of this sheet", style: SX.fxbtn + ";cursor:default;opacity:.7" }, [T("🔒")]);
  // 📖 wiki — open the docgraph article + metadata force-graph for THIS cell.
  // 🔗 topology — open the runCycle dependency cone (everything up/downstream).
  // Both are scoped to the selected cell (payload = its key); only shown when one
  // is selected (no cell → nothing to document or trace).
  const wikiBtn = el("button", { class: "fx-wiki", title: key ? `wiki — what is ${ref}?` : "wiki", style: SX.fxbtn }, [T("📖")],
    { click: { dispatch: WIKI, payload: key ?? "" } });
  const topoBtn = el("button", { class: "fx-topo", title: key ? `topology — what ${ref} depends on / feeds` : "topology", style: SX.fxbtn }, [T("🔗")],
    { click: { dispatch: TOPO, payload: key ?? "" } });
  // 🔮 ask grok — turn the natural-language question typed in the bar into a
  // formula for THIS cell (the reply lands back in the bar to review, then ⚡).
  const askBtn = el("button", { class: "fx-ask", title: key ? `ask grok — turn the bar's question into a formula for ${ref}` : "ask grok", style: SX.fxbtn }, [T("🔮")],
    { click: { dispatch: ASK, payload: key ?? "" } });
  const input = key
    ? (canWrite
        ? el("textarea", { class: "fx-input", style: SX.fxinput, rows: 1, value: String(draft ?? ""), "data-key": key, spellcheck: "false" }, [], {
            input: { set: DRAFT, extract: "value" },
            keydown: { dispatch: COMMIT, payload: key },   // origin.key: Enter commits to the selected cell
          })
        // restricted sheet: show the source but DON'T bind input/commit — read-only.
        : el("textarea", { class: "fx-input fx-readonly", style: SX.fxinput + ";opacity:.7", rows: 1, value: String(draft ?? ""), "data-key": key, readonly: "", spellcheck: "false", title: "read-only — you are not a writer of this sheet" }, []))
    : el("textarea", { class: "fx-input", style: SX.fxinput + ";color:#888;font-style:italic", rows: 1, readonly: "", placeholder: "select a cell to see and edit its formula" }, []);
  // 🔮 ask-grok appears only when writable AND signed in (askable) — it's useless
  // until you're authenticated to the completion proxy.
  const canAsk = canWrite && askable === true;
  const children = key
    ? (canWrite
        ? (canAsk ? [refSpan, fireBtn, wikiBtn, topoBtn, askBtn, input] : [refSpan, fireBtn, wikiBtn, topoBtn, input])
        : [refSpan, fireBtn, wikiBtn, topoBtn, input])
    : [refSpan, fireBtn, input];
  return el("div", { class: "sheet-fxbar", style: SX.fxbar }, children);
}) as Fn;

// sheetpane(bar, grid) — stack a formula bar over a grid in one CONTENT vnode (bar
// fixed at top, grid scrolls below), so a worksheet window reads like Excel. Both
// args are already-rendered vnodes; keeping the grid a separate cel-ref means typing
// in the bar re-wraps here without re-running sheetgrid.
const sheetpane: Fn = ((bar: unknown, grid: unknown): V =>
  el("div", { class: "sheet-pane", style: SX.pane }, [
    isVnode(bar) ? bar : T(bar == null ? "" : String(bar)),
    el("div", { class: "sheet-pane-body", style: SX.paneBody }, [isVnode(grid) ? grid : T(grid == null ? "" : String(grid))]),
  ])) as Fn;

// writableBy(identity, writers) — PURE formula-bar gate (co-located with sheetbar
// so it's loaded wherever a grid renders). A segment with NO writers list (the
// common, unencrypted case) is OPEN; one WITH a list admits only its members; a
// locked/empty identity is never a writer of a restricted sheet. The grid content
// formula passes `(writableBy keystore.identity <seg>.writers)` to sheetbar.
const writableBy: Fn = ((identity?: unknown, writers?: unknown): boolean => {
  if (!Array.isArray(writers) || writers.length === 0) return true;   // no allow-list → open
  const id = String(identity ?? "");
  return id !== "" && writers.map(String).includes(id);
}) as Fn;

// signedIn(auth) — PURE: is a Supabase auth status cel signed-in? Tolerant of a
// missing cel (a missing ref yields undefined → false). The grid content formula
// passes `(signedIn sb.<project>.auth)` to sheetbar to gate the 🔮 ask-grok button,
// which is useless until you're authenticated to the completion proxy.
const signedIn: Fn = ((auth?: unknown): boolean =>
  !!auth && typeof auth === "object" && (auth as { status?: unknown }).status === "signed-in") as Fn;

// renameOverlay(ui, draft) — a floating rename box at ui.x,ui.y when ui.open (set
// by sheetapp.tabmenu on a sheet-tab right-click/double-click). An <input> bound to
// the draft cel; Enter (or the ✓ button) applies via sheetapp.applyrename.
const renameOverlay: Fn = ((ui?: unknown, draft?: unknown): V => {
  const u = (ui && typeof ui === "object") ? ui as { open?: boolean; x?: number; y?: number } : {};
  if (!u.open) return el("div", { class: "pl-rename-pop", style: "display:none" }, []);
  const x = Math.max(4, Math.round(Number(u.x) || 200)), y = Math.max(4, Math.round(Number(u.y) || 160));
  return el("div", { class: "pl-rename-pop", style: `position:fixed;left:${x}px;top:${y}px;z-index:99999;background:Canvas;border:1px solid #4a90d9;border-radius:6px;box-shadow:0 6px 22px #0005;padding:.3rem;display:flex;gap:.25rem;align-items:center` }, [
    el("input", { class: "pl-rename-input", style: "font:.85rem ui-monospace,monospace;padding:.2rem .4rem;border:1px solid #8888;border-radius:4px;min-width:9rem", value: String(draft ?? ""), spellcheck: "false", autofocus: "" }, [], {
      input: { set: "sheetapp.renamedraft", extract: "value" },
      keydown: { dispatch: "sheetapp.applyrename" },
    }),
    el("button", { class: "pl-rename-ok", style: "font:.8rem ui-monospace,monospace;padding:.2rem .45rem;cursor:pointer" }, [T("✓ rename")], { click: { dispatch: "sheetapp.applyrename" } }),
  ]);
}) as Fn;

// ── the resize verbs (sheet.resizeGrab / Move / Drop / Reset) ────────────────
// The window.drag pattern: pointerdown on a header-edge handle GRABS (captures
// the pointer + snapshots the start position/size into sheet.resizedrag),
// pointermove writes the size cel LIVE (each write cascades through the grid
// formula — which references <seg>.colw/<seg>.rowh — and repaints), pointerup
// DROPS. dblclick RESETS the one column/row to its default (removes the key).
const SIZE_MIN: Record<string, number> = { col: 24, row: 16 };
const SIZE_CEL: Record<string, string> = { col: "colw", row: "rowh" };
// default rendered extents (td min-width:4.5rem ≈ 72px; th/td height:1.9rem ≈ 30px)
const SIZE_DEFAULT: Record<string, number> = { col: 72, row: 30 };
interface ResizeDrag { seg: string; kind: "col" | "row"; key: string; p0: number; size0: number }
interface ResizeEvt { clientX?: number; clientY?: number; pointerId?: number; currentTarget?: { setPointerCapture?: (id: number) => void; parentElement?: { offsetWidth?: number; offsetHeight?: number } }; target?: { setPointerCapture?: (id: number) => void } }
const captureRz = (e?: ResizeEvt): void => { try { (e?.currentTarget ?? e?.target)?.setPointerCapture?.(num(e?.pointerId)); } catch { /* off-DOM */ } };
const repaintRz = (s: State): Promise<unknown> => Promise.resolve((resolveFn(s, "drain") as Fn)(s, "dom.paint"));
const sizeDict = (s: State, k: string): Record<string, number> => {
  const v = s.cels.get(k)?.v;
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, number>) } : {};
};

// A grid content formula authored BEFORE a size cel existed can't reference it
// (an unresolved bare symbol traps the whole formula — the <seg>.dims lesson).
// When the first resize mints <seg>.colw / <seg>.rowh, rewrite every grid
// formula rendering this seg so its sheetgrid tail references the size cels
// that now exist (positional tail: dims, colw, rowh; absent → 0). Same regex
// surgery contract as sheetapp.regrid — gridopts(...) args and the tail refs
// never nest parens. Idempotent: the tail is rebuilt from what exists.
const regridSizes = async (s: State, seg: string): Promise<void> => {
  const tail = ["dims", SIZE_CEL.col, SIZE_CEL.row]
    .map((n) => s.cels.has(`${seg}.${n}`) ? `, ${seg}.${n}` : ", 0").join("");
  const setValue = resolveFn(s, "setValue") as Fn;
  for (const [k, c] of [...s.cels]) {
    const f = (c as { f?: string }).f;
    if (c.celType !== "FormulaCel" || typeof f !== "string" || !f.includes(`sheetgrid('${seg}'`)) continue;
    const next = f.replace(/(gridopts\([^)]*\))([^()]*)\)/, `$1${tail})`);
    if (next !== f) { try { await setValue(s, k, next); } catch { /* locked/foreign grid formula — leave it */ } }
  }
};

const resizeGrab: Fn = (async (s: State, payload: unknown, e?: unknown): Promise<void> => {
  const p = (payload ?? {}) as { seg?: unknown; kind?: unknown; key?: unknown };
  const seg = String(p.seg ?? ""), kind = String(p.kind ?? "") as "col" | "row", key = String(p.key ?? "");
  if (!seg || !key || SIZE_MIN[kind] === undefined) return;
  const ev = e as ResizeEvt | undefined;
  captureRz(ev);
  const ck = `${seg}.${SIZE_CEL[kind]}`;
  if (!s.cels.get(ck)) {
    // mint LAZILY, owned by the SHEET's segment so it archives with the doc.
    await (resolveFn(s, "setCel") as Fn)(s, ck, {
      celType: "ValueCel", v: {},
      metadata: { key: ck, segment: seg, name: SIZE_CEL[kind], description: `sparse ${kind === "col" ? "column widths ({letter: px})" : "row heights ({row: px})"} — Excel-style header-edge resize (sheet.resizeGrab); absent keys use the grid defaults` },
    });
  }
  // (re)wire the grid formulas on EVERY grab — idempotent, and it covers a
  // REOPENED doc whose size cels rehydrated but whose freshly-authored grid
  // formula doesn't reference them yet (until the host's singleGrid does).
  await regridSizes(s, seg);
  // start size: the stored override, else the header's real rendered extent
  // (the handle's parent th), else the stock default.
  const hdr = ev?.currentTarget?.parentElement;
  const rendered = kind === "col" ? hdr?.offsetWidth : hdr?.offsetHeight;
  const size0 = Math.max(SIZE_MIN[kind]!, Math.round(num(sizeDict(s, ck)[key], num(rendered, SIZE_DEFAULT[kind]))));
  const p0 = num(kind === "col" ? ev?.clientX : ev?.clientY);
  await (resolveFn(s, "setValue") as Fn)(s, "sheet.resizedrag", { seg, kind, key, p0, size0 } as ResizeDrag);
}) as Fn;

const resizeMove: Fn = (async (s: State, _p: unknown, e?: unknown): Promise<void> => {
  const d = s.cels.get("sheet.resizedrag")?.v as ResizeDrag | null | undefined;
  if (!d || !d.seg) return;
  const ev = e as ResizeEvt | undefined;
  const pos = num(d.kind === "col" ? ev?.clientX : ev?.clientY);
  const size = Math.max(SIZE_MIN[d.kind]!, Math.round(d.size0 + pos - d.p0));
  const ck = `${d.seg}.${SIZE_CEL[d.kind]}`;
  const cur = sizeDict(s, ck);
  if (cur[d.key] === size) return;
  await (resolveFn(s, "setValue") as Fn)(s, ck, { ...cur, [d.key]: size });   // live resize — the grid formula cascades
  await repaintRz(s);
}) as Fn;

const resizeDrop: Fn = (async (s: State): Promise<void> => {
  await (resolveFn(s, "setValue") as Fn)(s, "sheet.resizedrag", null);
}) as Fn;

const resizeReset: Fn = (async (s: State, payload: unknown): Promise<void> => {
  const p = (payload ?? {}) as { seg?: unknown; kind?: unknown; key?: unknown };
  const seg = String(p.seg ?? ""), kind = String(p.kind ?? ""), key = String(p.key ?? "");
  if (!seg || !key || SIZE_CEL[kind] === undefined) return;
  const ck = `${seg}.${SIZE_CEL[kind]}`;
  const cur = sizeDict(s, ck);
  if (!(key in cur)) return;
  delete cur[key];
  await (resolveFn(s, "setValue") as Fn)(s, ck, cur);
  await repaintRz(s);
}) as Fn;

// ── kvsheet — a key-value worksheet over NAMED cels (kv-sheet.md) ────────────
// A worksheet VARIANT for parameter-shaped data: one row per NAMED cel of a
// segment (`ecs.cohesion`), not per grid address. Rows are name → editable
// value → 🗑; a composer row (name + value + ➕) mints new cels. kvsheet adds
// NO storage — rows are real ValueCels/FormulaCels (metadata.segment = the
// sheet's segment, so they archive with the document).
//
// The reactive-set rule (the one hard part): a formula cannot reference a
// dynamic key set, so the roster lives in `<seg>.keys` (a list cel — dims'
// sibling) and the mint/retire verbs update it AND rewrite every kvsheet view
// formula to splice each named cel in as ('<seg>.<name>', <seg>.<name>) pairs
// — a row's value ref IS the dependency. Both the roster cel and the formula
// refs are lazily wired: `=view("params", kvsheet('ecs', 0))` bootstraps with
// nothing but the formula; the first ➕ mints `<seg>.keys` and rewrites.

const KV_STYLE = {
  root: "display:flex;flex-direction:column;gap:1px;font:.85rem ui-monospace,monospace;min-width:16rem",
  row: "display:flex;align-items:center;gap:.35rem;padding:.1rem .2rem;border-bottom:1px solid #8883",
  key: "flex:0 0 9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#888;font-weight:600;cursor:pointer;padding:.15rem .2rem",
  val: "flex:1 1 auto;min-width:6rem;box-sizing:border-box;font:.85rem ui-monospace,monospace;padding:.15rem .35rem;border:1px solid #8883;border-radius:.2rem;background:Canvas;color:CanvasText",
  del: "flex:0 0 auto;border:0;background:transparent;cursor:pointer;font-size:.85rem;padding:0 .25rem;opacity:.7",
  add: "flex:0 0 auto;border:1px solid #8884;background:#8881;border-radius:.25rem;cursor:pointer;font-size:.9rem;line-height:1;padding:.15rem .45rem",
} as const;

// a row value in the input, by the collections display rules: strings raw,
// scalars stringified, dicts/lists as JSON (=json() inspects; editing inside
// one is the formula bar's job).
const kvShow = (v: unknown): string => {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (isCelError(v)) return String((v as { message?: unknown }).message ?? "#ERROR");
  if (typeof v === "object") { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
};

// kvsheet(seg, keys?, opts?, …pairs) — PURE vnode. `keys` is the roster cel's
// value (list of short names; 0/absent → composer only). `opts` is the
// selected-key cel's value (a string — the highlighted row) or {selected,
// select}. `pairs` are ('<seg>.<name>', <value>) — spliced by the rewrite so
// every row's value is a live reference. Value edits commit on change/Enter
// (kv.set); ➕ mints (kv.mint, reading the kv.name/kv.value draft cels);
// 🗑 retires (kv.retire, no guardrails). Selecting a row's name dispatches
// opts.select (default origin.select) with the cel key — the formula bar
// loads its source like any cell.
const kvsheet: Fn = ((segArg: unknown, keysArg?: unknown, optsArg?: unknown, ...pairs: unknown[]): V => {
  const seg = typeof segArg === "string" ? segArg : "";
  const names = Array.isArray(keysArg) ? keysArg.map(String) : [];
  const o = (optsArg && typeof optsArg === "object") ? optsArg as { selected?: unknown; select?: unknown } : { selected: optsArg };
  const selected = typeof o.selected === "string" ? o.selected : null;
  const SEL = typeof o.select === "string" ? o.select : "origin.select";
  const vals = new Map<string, unknown>();
  for (let i = 0; i + 1 < pairs.length; i += 2) vals.set(String(pairs[i]), pairs[i + 1]);

  const rows = names.map((name) => {
    const key = `${seg}.${name}`;
    const isSel = selected === key;
    return el("div", { class: "kv-row" + (isSel ? " selected" : ""), "data-key": key, style: KV_STYLE.row + (isSel ? ";outline:2px solid #4a90d999;outline-offset:-2px" : "") }, [
      el("span", { class: "kv-key", title: `${key} — click to load its source into the formula bar`, style: KV_STYLE.key }, [T(name)],
        { click: { dispatch: SEL, payload: key } }),
      el("input", { class: "kv-val", "data-key": key, value: kvShow(vals.get(key)), spellcheck: "false", title: "edit and press Enter (or leave the field) to commit" }, [], {
        change:  { dispatch: "kv.set", payload: key },
        keydown: { dispatch: "kv.set", payload: key },
      }),
      el("button", { class: "kv-del", title: `retire ${key}`, style: KV_STYLE.del }, [T("🗑")],
        { click: { dispatch: "kv.retire", payload: { seg, name } } }),
    ]);
  });

  const composer = el("div", { class: "kv-composer", style: KV_STYLE.row + ";border-bottom:0;padding-top:.3rem" }, [
    el("input", { class: "kv-name", placeholder: "name", spellcheck: "false", style: KV_STYLE.val + ";flex:0 0 9rem" }, [],
      { input: { set: "kv.name", extract: "value" } }),
    el("input", { class: "kv-value", placeholder: "value ({ and [ parse as JSON; = for a formula)", spellcheck: "false", style: KV_STYLE.val }, [],
      { input: { set: "kv.value", extract: "value" }, keydown: { dispatch: "kv.mint", payload: seg } }),
    el("button", { class: "kv-add", title: "add — mint the named cel", style: KV_STYLE.add }, [T("➕")],
      { click: { dispatch: "kv.mint", payload: seg } }),
  ]);

  return el("div", { class: "kv-sheet", "data-seg": seg, style: KV_STYLE.root }, [...rows, composer]);
}) as Fn;

// value-entry rules for a kv row (the JSON-entry / sniffCel contract):
// `=`/`(` → a FormulaCel source; `{`/`[` → the parsed JSON is the VALUE
// (a writable ValueCel — data entry, not a derived formula); numeric →
// number; anything else → the raw string.
const kvEntry = (src: string): { f?: string; parser?: string; v?: unknown } => {
  const t = src.trim();
  if (t.startsWith("=")) return { f: t, parser: "infix" };
  if (t.startsWith("(")) return { f: t, parser: "f" };
  if (t.startsWith("{") || t.startsWith("[")) { try { return { v: JSON.parse(t) }; } catch { /* not JSON — a string */ } }
  const n = Number(t);
  if (t !== "" && !Number.isNaN(n)) return { v: n };
  return { v: src };
};

const rosterOf = (s: State, seg: string): string[] => {
  const v = s.cels.get(`${seg}.keys`)?.v;
  return Array.isArray(v) ? v.map(String) : [];
};

// Rewrite every kvsheet view formula for `seg` from the CURRENT roster: the
// canonical call is kvsheet('<seg>', <seg>.keys|0, <opts>, '<seg>.<n>', <seg>.<n>, …)
// — args stay paren-free by construction, so the same no-nested-parens regex
// surgery as regridSizes applies. The author's opts (a bare ref like
// sheet.selected, or 0) survives; old pairs and the old roster ref are rebuilt.
const kvViewRe = (seg: string): RegExp =>
  new RegExp(`kvsheet\\((['"])${seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1([^()]*)\\)`);
const rekvViews = async (s: State, seg: string): Promise<void> => {
  const keysRef = s.cels.has(`${seg}.keys`) ? `${seg}.keys` : "0";
  const pairsTail = rosterOf(s, seg).map((n) => `, '${seg}.${n}', ${seg}.${n}`).join("");
  const setValue = resolveFn(s, "setValue") as Fn;
  for (const [k, c] of [...s.cels]) {
    const f = (c as { f?: string }).f;
    if (c.celType !== "FormulaCel" || typeof f !== "string") continue;
    const m = kvViewRe(seg).exec(f);
    if (!m) continue;
    // tokens after the seg literal: skip the old roster ref / 0 placeholder;
    // the first bare token is the author's opts; quoted tokens start the old
    // pairs (rebuilt below).
    let opts = "0";
    for (const t of m[2]!.split(",").map((x) => x.trim()).filter((x) => x !== "")) {
      if (t.startsWith("'") || t.startsWith('"')) break;
      if (t === "0" || t === `${seg}.keys`) continue;
      opts = t; break;
    }
    const next = f.replace(kvViewRe(seg), `kvsheet('${seg}', ${keysRef}, ${opts}${pairsTail})`);
    if (next !== f) { try { await setValue(s, k, next); } catch { /* locked/foreign — leave it */ } }
  }
};

// settle after a kv structure change: an unsuppressed cycle fires freshly
// minted FormulaCels (and re-derives every =view to its request), the effects
// drain lands the requests back to tokens + fresh pane content, then paint.
// Value-only edits skip the cycle (the write's own cascade already re-fired
// the view formula to its request — landing + paint is enough).
const kvSettle = async (s: State, cycle: boolean): Promise<void> => {
  if (cycle) await (resolveFn(s, "runCycle") as Fn)(s);
  const dr = resolveFn(s, "drain") as Fn;
  if (s.cels.get("origin.effects")) await dr(s, "origin.effects");
  if (s.cels.get("dom.paint")) await dr(s, "dom.paint");
};

// kv.mint(state, seg, event?) — the composer's ➕ (and Enter in its value
// input): mint `<seg>.<name>` from the kv.name/kv.value drafts by the entry
// rules, ensure the `<seg>.keys` roster, append the name, rewrite the view
// formulas, settle. Re-minting an existing name replaces the cel (an edit).
const kvMint: Fn = (async (s: State, payload: unknown, e?: unknown): Promise<void> => {
  const seg = String(payload ?? "").trim();
  const ev = e as { key?: string } | undefined;
  if (ev && typeof ev.key === "string" && ev.key !== "Enter") return;   // keydown path: Enter mints
  const name = String(s.cels.get("kv.name")?.v ?? "").trim().replace(/[^\w-]/g, "");
  if (!seg || !name) return;
  const setCel = resolveFn(s, "setCel") as Fn, setValue = resolveFn(s, "setValue") as Fn;
  const key = `${seg}.${name}`;
  const spec = kvEntry(String(s.cels.get("kv.value")?.v ?? ""));
  await setCel(s, key, spec.f !== undefined
    ? { celType: "FormulaCel", f: spec.f, metadata: { key, segment: seg, name, parser: spec.parser } }
    : { celType: "ValueCel", v: spec.v, metadata: { key, segment: seg, name } });
  const rk = `${seg}.keys`;
  if (!s.cels.has(rk)) {
    await setCel(s, rk, { celType: "ValueCel", v: [], metadata: { key: rk, segment: seg, name: "keys", description: "the kv sheet ROSTER — the ordered short names of this segment's kvsheet rows (kv-sheet.md). kv.mint appends, kv.retire removes; the kvsheet view formula references it (dims' sibling)." } });
  }
  const roster = rosterOf(s, seg);
  if (!roster.includes(name)) await setValue(s, rk, [...roster, name]);
  await rekvViews(s, seg);
  await setValue(s, "kv.name", "");                                     // clear the composer
  await setValue(s, "kv.value", "");
  await kvSettle(s, true);                                              // fire the mint + land the panes
}) as Fn;

// kv.set(state, key, event) — a row value commit (change, or Enter in the
// input): apply the entry rules to the input's text. Same-tier writes are
// plain setValue (the spliced ref cascades the view); a tier CHANGE (value ↔
// formula) replaces the cel wholesale and cycles so the new formula fires.
const kvSet: Fn = (async (s: State, payload: unknown, e?: unknown): Promise<void> => {
  const key = String(payload ?? "");
  const cur = s.cels.get(key);
  if (!cur) return;
  const ev = e as { key?: string; target?: { value?: unknown } } | undefined;
  if (ev && typeof ev.key === "string" && ev.key !== "Enter") return;   // keydown path: Enter commits
  const spec = kvEntry(String(ev?.target?.value ?? ""));
  const md = cur.metadata as { segment?: string; name?: string };
  const setCel = resolveFn(s, "setCel") as Fn, setValue = resolveFn(s, "setValue") as Fn;
  if (spec.f !== undefined) {
    if (cur.celType === "FormulaCel") await setValue(s, key, spec.f);
    else await setCel(s, key, { celType: "FormulaCel", f: spec.f, metadata: { key, segment: md.segment, name: md.name, parser: spec.parser } });
    await kvSettle(s, true);                                            // fire the (re)compiled formula
  } else if (cur.celType === "ValueCel") {
    await setValue(s, key, spec.v);
    await kvSettle(s, false);
  } else {
    await setCel(s, key, { celType: "ValueCel", v: spec.v, metadata: { key, segment: md.segment, name: md.name } });
    await kvSettle(s, true);
  }
}) as Fn;

// kv.retire(state, {seg, name}) — the row's 🗑: drop the name from the roster,
// rewrite the view formulas FIRST (so no view references the dying cel), then
// retire it (no guardrails — deletion doctrine) and refire what's left; a
// surviving formula that referenced it traps undefined-symbol, honestly.
const kvRetire: Fn = (async (s: State, payload: unknown): Promise<void> => {
  const p = (payload ?? {}) as { seg?: unknown; name?: unknown };
  const seg = String(p.seg ?? ""), name = String(p.name ?? "");
  if (!seg || !name) return;
  const key = `${seg}.${name}`;
  const rk = `${seg}.keys`;
  if (s.cels.has(rk)) await (resolveFn(s, "setValue") as Fn)(s, rk, rosterOf(s, seg).filter((n) => n !== name));
  await rekvViews(s, seg);
  const stale = new Set<string>();
  retireCel(s, key, stale);
  precompute(s);
  await kvSettle(s, true);                                              // refires survivors (stale consumers trap)
}) as Fn;

// ── kv.seed — merge SHIPPED DEFAULTS into a user-owned kv segment ────────────
// kv.seed(state, {into, from}) — for each name in `<from>.keys` MISSING from
// `<into>`: copy the default cel's value (+ description) as `<into>.<name>`
// and append the roster. NEVER overwrites an existing row — the user's value
// wins; re-seeding after a defaults refresh adds only NEW keys (the
// install-once/usercfg pattern: refreshApps stomps the defaults segment
// freely, skips the install:"once" user segment, and =kvseed re-merges on
// open). Always rewrites the kvsheet view formulas (a refreshed doc reverts
// them to the bootstrap form). NB: deleting a user row means the next seed
// re-adds it at the default — reset-to-default by deletion; the 🗑 stays
// unguarded (deletion doctrine).
//
// NO settle here: kv.seed is invoked FROM INSIDE the origin.effects drain (the
// =kvseed landing arm) — draining origin.effects reentrantly would land the
// =kvseed request again and recurse forever. The caller's settle loop (opendoc
// / origin.run run several cycle+drain rounds) converges the cascades: the
// rewritten view formula re-fires, its request lands next round, and a
// no-change rewrite is skipped so the loop terminates.
const kvSeed: Fn = (async (s: State, payload: unknown): Promise<unknown> => {
  const p = (payload ?? {}) as { into?: unknown; from?: unknown };
  const into = String(p.into ?? "").trim(), from = String(p.from ?? "").trim();
  if (!into || !from) return { added: [] };
  const setCel = resolveFn(s, "setCel") as Fn, setValue = resolveFn(s, "setValue") as Fn;
  const added: string[] = [];
  for (const name of rosterOf(s, from)) {
    const ik = `${into}.${name}`;
    if (s.cels.has(ik)) continue;
    const src = s.cels.get(`${from}.${name}`);
    if (!src) continue;
    const desc = (src.metadata as { description?: string }).description;
    await setCel(s, ik, { celType: "ValueCel", v: src.v, metadata: { key: ik, segment: into, name, ...(desc ? { description: desc } : {}) } });
    added.push(name);
  }
  const rk = `${into}.keys`;
  if (!s.cels.has(rk)) {
    await setCel(s, rk, { celType: "ValueCel", v: [], metadata: { key: rk, segment: into, name: "keys", description: "the kv sheet ROSTER — the ordered short names of this segment's kvsheet rows (kv-sheet.md). kv.mint appends, kv.retire removes, kv.seed merges missing defaults in; the kvsheet view formula references it (dims' sibling)." } });
  }
  const roster = rosterOf(s, into);
  const fresh = added.filter((n) => !roster.includes(n));
  if (fresh.length) await setValue(s, rk, [...roster, ...fresh]);
  await rekvViews(s, into);
  return { kvseed: into, added };
}) as Fn;

// ── sheet.addrow — a form's ➕: append a RECORD row to a worksheet ────────────
// sheet.addrow(state, {seg, from, clear?}) — pure mechanism (grid-program
// contract): copy the CURRENT values of the `from` cels into columns A.. of the
// first free row (1 + the max populated row across those target columns — a
// form's own draft cells live in other columns and never push the append down),
// grow <seg>.dims to cover the new row, then reset each `clear` cel to "".
// ALL policy is authored in the dispatching formula: which draft cels feed
// which columns (`from` order), what an id is (a visible next-id formula cell
// fed as a `from` entry), and which drafts reset. Reading the drafts at CLICK
// time (the kv.mint pattern) keeps the payload static-authorable — no repaint
// race between typing and the button's payload.
const addRow: Fn = (async (s: State, payload: unknown): Promise<void> => {
  const p = (payload ?? {}) as { seg?: unknown; from?: unknown; clear?: unknown };
  const seg = String(p.seg ?? "").trim();
  const from = Array.isArray(p.from) ? p.from.map(String) : [];
  if (!seg || from.length === 0) return;
  const clear = Array.isArray(p.clear) ? p.clear.map(String) : [];
  const targets = Array.from({ length: from.length }, (_, i) => colLetter(i));
  const targetSet = new Set(targets);
  let maxRow = 0;
  for (const key of s.cels.keys()) {
    if (!key.startsWith(`${seg}.`)) continue;
    const m = /^([A-Z]+)(\d+)$/.exec(key.slice(seg.length + 1));
    if (m && targetSet.has(m[1]!)) maxRow = Math.max(maxRow, Number(m[2]));
  }
  const row = maxRow + 1;
  const setCel = resolveFn(s, "setCel") as Fn, setValue = resolveFn(s, "setValue") as Fn;
  for (let i = 0; i < from.length; i++) {
    const key = `${seg}.${targets[i]}${row}`;
    const v = s.cels.get(from[i]!)?.v ?? "";
    if (s.cels.get(key)?.celType === "ValueCel") await setValue(s, key, v);
    else await setCel(s, key, { celType: "ValueCel", v, metadata: { key, segment: seg, name: `${targets[i]}${row}` } });
  }
  const dk = `${seg}.dims`;
  const dv = s.cels.get(dk)?.v as { rows?: unknown; cols?: unknown } | undefined;
  if (dv && typeof dv === "object" && num(dv.rows) < row) await setValue(s, dk, { ...dv, rows: row });
  for (const k of clear) if (s.cels.get(k)?.celType === "ValueCel") await setValue(s, k, "");
  await kvSettle(s, true);                                              // fire dependents (next-id, board views) + land panes
}) as Fn;

export const name = "sheets" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sheetcell", sheetcell],
  ["sheetgrid", sheetgrid],
  ["gridopts", gridopts],
  ["sheetbar", sheetbar],
  ["sheetpane", sheetpane],
  ["writableBy", writableBy],
  ["signedIn", signedIn],
  ["renameOverlay", renameOverlay],
  ["sheet.resizeGrab", resizeGrab],
  ["sheet.resizeMove", resizeMove],
  ["sheet.resizeDrop", resizeDrop],
  ["sheet.resizeReset", resizeReset],
  ["sheet.addrow", addRow],
  ["kv.seed", kvSeed],
  ["kvsheet", kvsheet],
  ["kv.mint", kvMint],
  ["kv.set", kvSet],
  ["kv.retire", kvRetire],
]));
