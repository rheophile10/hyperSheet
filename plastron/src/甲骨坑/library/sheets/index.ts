import type { 甲骨, Cel, Fn, VNode, AttrValue, EventBinding } from "../../../types/index.js";
import { bindNativeFns, isCelError } from "../../../kernel/index.js";
import { el as makeEl, text as T } from "../dom/index.js";
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
const isVnode = (v: unknown): v is V => !!v && typeof v === "object" && ((v as { type?: unknown }).type === "el" || (v as { type?: unknown }).type === "text");

const SX = {
  scroll: "overflow-x:auto;max-width:100%",
  table: "border-collapse:collapse;font-variant-numeric:tabular-nums",
  th: "border:1px solid #8883;background:#8881;text-align:center;color:#888;font-weight:600;font-size:.8rem;font-family:ui-monospace,monospace;min-width:1.8rem;padding:0 .35rem;height:1.9rem",
  corner: "border:1px solid #8883;background:#8881;text-align:center;color:#aaa;font-weight:700;font-size:.8rem;font-family:ui-monospace,monospace;padding:0 .35rem;height:1.9rem",
  td: "border:1px solid #8883;padding:0;height:1.9rem;text-align:left;vertical-align:top;cursor:cell",
  cellValue: "display:flex;align-items:flex-start;padding:.15rem .4rem;min-height:1.6rem;font-family:ui-monospace,monospace;font-size:.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap",
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
  if (typeof v === "object") return T(JSON.stringify(v));
  return T(String(v));
};
const sheetcell: Fn = ((value: unknown): V => displayCell(value)) as Fn;

interface CellEntry { key?: string; col?: number; row?: number; value?: unknown; src?: unknown }
interface GridOpts { active?: string; selected?: string; draft?: string; edit?: string; select?: string; fire?: string; commit?: string; wiki?: string; topo?: string }
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// sheetgrid(label, cells, opts?) — render a worksheet's cells as an editable Excel grid
// CONTENT vnode (corner label + column letters + row numbers + cells). `cells` is the
// host-aggregated list [{ key, col, row, value, src }]; `opts` carries the active
// (editing) + selected cell keys, the draft cel, and the handler keys to dispatch
// (defaults to origin.*). The active cell shows an inline editor; others show the value
// and dispatch select (click) / edit (double-click). Cells are memo-friendly upstream.
const sheetgrid: Fn = ((label: unknown, cells: unknown, opts?: unknown): V => {
  const o = (opts && typeof opts === "object") ? opts as GridOpts : {};
  const EDIT = o.edit ?? "origin.edit", SEL = o.select ?? "origin.select", FIRE = o.fire ?? "origin.fire";
  const COMMIT = o.commit ?? "origin.key", DRAFT = o.draft ?? "元.draft";
  const active = typeof o.active === "string" ? o.active : null;
  const selected = typeof o.selected === "string" ? o.selected : null;
  const list = Array.isArray(cells) ? cells as CellEntry[] : [];
  let maxC = 0, maxR = 0;
  const at = new Map<string, CellEntry>();
  for (const e of list) { const c = num(e.col), r = num(e.row); at.set(`${c},${r}`, e); maxC = Math.max(maxC, c); maxR = Math.max(maxR, r); }

  const editor = (key: string, value: unknown): V =>
    el("textarea", { class: "cell-edit", style: SX.edit, rows: 1, value: String(value ?? ""), "data-key": key }, [], {
      input: { set: DRAFT, extract: "value" },
      keydown: { dispatch: COMMIT, payload: key },
    });
  const body = (key: string, value: unknown): V => {
    if (active === key) return editor(key, value);
    const shown = displayCell(value);
    const inner = shown.type === "text" ? el("span", { class: "cell-val-text" }, [shown]) : shown;
    return el("div", { class: "cell-value", "data-key": key, title: "click to select; double-click to edit", style: SX.cellValue }, [inner],
      { click: { dispatch: SEL, payload: key }, dblclick: { dispatch: EDIT, payload: key } });
  };

  const head = el("tr", {}, [el("th", { class: "corner", style: SX.corner }, [T(String(label ?? ""))]),
    ...Array.from({ length: maxC + 1 }, (_, c) => el("th", { style: SX.th }, [T(colLetter(c))]))]);
  const rows = Array.from({ length: maxR + 1 }, (_, r) =>
    el("tr", {}, [el("th", { class: "rownum", style: SX.th }, [T(String(r + 1))]),
      ...Array.from({ length: maxC + 1 }, (_, c) => {
        const e = at.get(`${c},${r}`);
        if (!e?.key) return el("td", { class: "cell", "data-key": "", style: `${SX.td};min-width:4.5rem` }, []);
        const isActive = active === e.key, isSel = selected === e.key;
        const outline = isActive ? ";outline:2px solid #4a90d9;outline-offset:-2px" : (isSel ? ";outline:2px solid #4a90d999;outline-offset:-2px" : "");
        void FIRE;
        return el("td", { class: isActive ? "cell editing" : (isSel ? "cell selected" : "cell"), "data-key": e.key, style: `${SX.td};position:relative;min-width:4.5rem${outline}` }, [body(e.key, e.value)]);
      })]));
  return el("div", { class: "grid-scroll", style: SX.scroll }, [el("table", { class: "grid", style: SX.table }, [el("thead", {}, [head]), el("tbody", {}, rows)])]);
}) as Fn;

// gridopts(active, selected) — build the sheetgrid opts object from the editing /
// selected cell-key cels (e.g. 元.editing / 元.selected) so a worksheet is EDITABLE
// in a workbook tab: the active cell shows the inline editor, a click selects.
// Handlers (edit/select/fire/commit) + the draft cel default to origin.* / 元.draft
// inside sheetgrid; referencing the editing cels in the grid formula makes it
// re-render reactively as the active/selected cell changes.
const gridopts: Fn = ((active?: unknown, selected?: unknown): unknown =>
  ({ active: typeof active === "string" ? active : null, selected: typeof selected === "string" ? selected : null })) as Fn;

// sheetbar(selected, draft, opts?) — the Excel FORMULA BAR: a cell-ref label, a ⚡
// fire button, and a textarea that EDITS the selected cell's source. `selected` is
// the selected cell KEY (e.g. "元" / "g3x3.A1"); `draft` is the source text to show
// (seeded into the draft cel on select — reference an ASCII mirror like sheet.draft
// in the formula so the bar re-renders on selection). The textarea's `input` writes
// the live text into the draft cel (opts.draft, default "元.draft") WITHOUT re-rendering
// the bar (so typing never churns the grid); Enter (keydown → opts.commit) and ⚡
// (opts.fire) commit it to the selected cell. Stack it over a grid with sheetpane.
const sheetbar: Fn = ((selected: unknown, draft: unknown, writable?: unknown, opts?: unknown): V => {
  const o = (opts && typeof opts === "object") ? opts as GridOpts : {};
  const DRAFT = o.draft ?? "元.draft", COMMIT = o.commit ?? "origin.key", FIRE = o.fire ?? "origin.fire";
  const WIKI = o.wiki ?? "wiki.open", TOPO = o.topo ?? "origin.celtopo";
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
  const input = key
    ? (canWrite
        ? el("textarea", { class: "fx-input", style: SX.fxinput, rows: 1, value: String(draft ?? ""), "data-key": key, spellcheck: "false" }, [], {
            input: { set: DRAFT, extract: "value" },
            keydown: { dispatch: COMMIT, payload: key },   // origin.key: Enter commits to the selected cell
          })
        // restricted sheet: show the source but DON'T bind input/commit — read-only.
        : el("textarea", { class: "fx-input fx-readonly", style: SX.fxinput + ";opacity:.7", rows: 1, value: String(draft ?? ""), "data-key": key, readonly: "", spellcheck: "false", title: "read-only — you are not a writer of this sheet" }, []))
    : el("textarea", { class: "fx-input", style: SX.fxinput + ";color:#888;font-style:italic", rows: 1, readonly: "", placeholder: "select a cell to see and edit its formula" }, []);
  const children = key ? [refSpan, fireBtn, wikiBtn, topoBtn, input] : [refSpan, fireBtn, input];
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

export const name = "sheets" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sheetcell", sheetcell],
  ["sheetgrid", sheetgrid],
  ["gridopts", gridopts],
  ["sheetbar", sheetbar],
  ["sheetpane", sheetpane],
  ["writableBy", writableBy],
]));
