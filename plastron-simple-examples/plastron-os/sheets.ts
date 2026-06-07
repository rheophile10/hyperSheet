// ============================================================================
// Sheets v1.1 — per-cell view cels (Option A), shared file toolbar,
// metadata panel for the selected cell.
//
// Each cell at sheet.<addr> has a tiny `sheet.<addr>.view` FormulaCel that
// emits a `<td>` VNode (the kernel's `view-layer vnode-embed` extension lets
// us interpolate a VNode value as a child). On an edit, ONLY that cell's
// view fires + the table re-composes — the diff bails on every other cell's
// ref-stable subtree (raf-channel's keyed/subtree bail-out). Selection
// highlight is applied at table assembly via a clone-with-class so per-cell
// views don't all depend on sel.
//
// First draft: modest grid (6×6 by default), metadata panel is read-only (a
// JSON pre block) — editable metadata + virtualized large grids are v1.2.
// ============================================================================

import { resolveFn, buildSheet } from "../../plastron-simple/dist/index.js";
import { addrFrom, indexToCol, parseRef, cellKey } from "../../plastron-simple/dist/甲骨坑/library/sheet/utils/address.js";
import { setupFileToolbar } from "./file-toolbar.js";
import { registerDocBinding } from "./doc-binding.js";

// ── per-cell vnode + table composer (registered fns) ────────────────────────

type V = { type: "el" | "text"; tag?: string; key?: string; attrs?: Record<string, unknown>; events?: Record<string, unknown>; children?: V[]; text?: string };

/** Excel-flavored display for the value kinds a cell can now hold:
 *  CelError → #NAME? (undefined symbol) / #ERR! (other traps), defn
 *  binder request → ƒ name, other objects → JSON (never
 *  "[object Object]"). */
export const displayValue = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : "—";
  if (typeof v === "object") {
    const o = v as { kind?: unknown; message?: unknown; defn?: unknown; name?: unknown };
    if (o.kind === "error") return /undefined symbol/.test(String(o.message ?? "")) ? "#NAME?" : "#ERR!";
    if (o.defn === true) return `ƒ ${String(o.name ?? "")}`;
    try { return JSON.stringify(v) ?? ""; } catch { return "#ERR!"; }
  }
  return String(v);
};

/** A `<td>` VNode for a single cell — addr is baked in as a literal so the
 *  click binding doesn't need to re-resolve it at paint time. Error cells
 *  carry the trap message in `title` so hover explains the #ERR!. */
export const cellVnode = (value: unknown, addr: string): V => {
  const err = value && typeof value === "object" && (value as { kind?: unknown }).kind === "error";
  const attrs: Record<string, unknown> = { class: err ? "cell error" : "cell", "data-addr": addr };
  if (err) attrs.title = String((value as { message?: unknown }).message ?? "");
  return {
    type: "el", tag: "td",
    key: addr,
    attrs,
    events: { click: { f: `(dispatch "sheet.click" "${addr}")` } },
    children: [{ type: "text", text: displayValue(value) }],
  };
};

/** Compose the full `<table>` VNode from the per-cell VNodes (row-major).
 *  The selected cell is rendered as a clone with `.selected` class so the
 *  per-cell views don't have to depend on sel (only the truly-changed cell
 *  refires; the selection highlight is a render-time concern here). */
export const assembleTable = (
  cellViews: V[], dims: { rows: number; cols: number }, sel: { row: number; col: number } | undefined,
): V => {
  const rows = dims?.rows ?? 0, cols = dims?.cols ?? 0;
  const headerCols: V[] = [{ type: "el", tag: "th", attrs: { class: "corner" }, children: [] }];
  for (let c = 0; c < cols; c++) headerCols.push({ type: "el", tag: "th", children: [{ type: "text", text: indexToCol(c) }] });
  const thead: V = { type: "el", tag: "thead", children: [{ type: "el", tag: "tr", children: headerCols }] };

  const bodyRows: V[] = [];
  for (let r = 0; r < rows; r++) {
    const tr: V[] = [{ type: "el", tag: "th", attrs: { class: "rownum" }, children: [{ type: "text", text: String(r + 1) }] }];
    for (let c = 0; c < cols; c++) {
      const base = cellViews[r * cols + c];
      if (!base) continue;
      if (sel && sel.row === r && sel.col === c) {
        const attrs = { ...(base.attrs ?? {}), class: `${(base.attrs?.class as string) ?? "cell"} selected` };
        tr.push({ ...base, attrs });
      } else {
        tr.push(base);
      }
    }
    bodyRows.push({ type: "el", tag: "tr", children: tr });
  }
  return { type: "el", tag: "table", attrs: { class: "sheet" }, children: [thead, { type: "el", tag: "tbody", children: bodyRows }] };
};

/** "A1" of the current selection. */
export const selAddr = (sel: { row: number; col: number } | undefined): string =>
  sel ? addrFrom(sel.col ?? 0, sel.row ?? 0) : "";

// ── dispatch helpers (sheet-side; the file toolbar lives in file-toolbar.ts) ─

const cellSource = (state: any, addr: string): string => {
  const cel = state.cels.get(cellKey(addr));
  if (!cel) return "";
  if (cel.celType === "FormulaCel") return (cel.f as string | undefined) ?? "";
  return cel.v === "" || cel.v == null ? "" : String(cel.v);
};

const clickCell = async (state: any, addr: string): Promise<void> => {
  const ref = parseRef(addr) ?? { row: 0, col: 0 };
  await resolveFn(state, "setValueBatch")(state, [
    ["sheet.selection", { row: ref.row, col: ref.col }],
    ["sheet.formula-bar", cellSource(state, addr)],
  ], { flush: "all" });
};

const barInput = async (state: any, _p: unknown, event: any): Promise<void> => {
  await resolveFn(state, "setValue")(state, "sheet.formula-bar", event?.target?.value ?? "");
};

const commit = async (state: any): Promise<void> => {
  const sel = (((s: never, k: never) => (resolveFn(s, "getCel") as (s: never, k: never) => { v?: unknown } | undefined)(s, k)?.v)(state, "sheet.selection") as { row: number; col: number } | undefined) ?? { row: 0, col: 0 };
  const addr = addrFrom(sel.col, sel.row);
  const input = String(((s: never, k: never) => (resolveFn(s, "getCel") as (s: never, k: never) => { v?: unknown } | undefined)(s, k)?.v)(state, "sheet.formula-bar") ?? "");
  await resolveFn(state, "sheet.commit-cell")(state, { addr, input });
  await resolveFn(state, "drain")(state, "plastron-dom.paint");
};

// ── keyboard navigation (document|keydown global listener) ──────────────────
// One self-gated handler: it no-ops unless Sheets is the active app, so the
// listener can stay attached across app switches (the painter's null-mount
// skip means a deactivated view never reconciles its listener away).
//   Enter  — commit the formula bar, move down (Excel's gesture)
//   Escape — restore the bar from the selected cell (abandon the draft)
//   Arrows / Tab / Shift+Tab — move selection (unless typing in the bar)
const keyNav = async (state: any, _p: unknown, event: any): Promise<void> => {
  if (state.cels.get("os.active")?.v !== "sheets") return;
  const k = String(event?.key ?? "");
  const tag = String(event?.target?.tagName ?? "").toUpperCase();
  const inBar = tag === "INPUT" || tag === "TEXTAREA";
  const move = async (dr: number, dc: number): Promise<void> => {
    await resolveFn(state, "sheet.move-selection")(state, { dr, dc });
    await resolveFn(state, "drain")(state, "plastron-dom.paint");
  };
  if (k === "Enter") {
    event?.preventDefault?.();
    await commit(state);
    await move(1, 0);
  } else if (k === "Escape") {
    const sel = (state.cels.get("sheet.selection")?.v as { row: number; col: number } | undefined) ?? { row: 0, col: 0 };
    await resolveFn(state, "setValue")(state, "sheet.formula-bar", cellSource(state, addrFrom(sel.col, sel.row)), { flush: "all" });
  } else if (k === "Tab") {
    event?.preventDefault?.();
    await move(0, event?.shiftKey ? -1 : 1);
  } else if (!inBar) {
    if (k === "ArrowUp") await move(-1, 0);
    else if (k === "ArrowDown") await move(1, 0);
    else if (k === "ArrowLeft") await move(0, -1);
    else if (k === "ArrowRight") await move(0, 1);
  }
};

// ── the sheet view template ─────────────────────────────────────────────────

// The file toolbar is a FRAGMENT view cel (vnode-valuecel-collapse):
// `{{(cel "sheet.toolbar.view")}}` splices its RenderSpec by reference,
// so toolbar work is zero when os.doc didn't change and the paint diff
// skips its subtree in O(1). The monolithic (string-inlined) form stays
// available via opts.monolithicToolbar for the DOM-fingerprint identity
// regression test.
const TOOLBAR_FRAGMENT_TEMPLATE = `
    <div class="file-toolbar">
      <button class="ft-new"  onClick={{(dispatch "file.new")}}>📄 New</button>
      <button class="ft-save" onClick={{(dispatch "file.save")}}>💾 Save</button>
      <button class="ft-open" onClick={{(dispatch "file.pick")}}>📂 Open</button>
      <span class="doc-name">{{(toolbarLabel doc)}}</span>
    </div>`;

const SHEET_TEMPLATE = `
<div class="sheet-app">
  {{(cel "sheet.toolbar.view")}}
  <div class="bar">
    <button class="close" onClick={{(dispatch "os.exit")}}>×</button>
    <span class="cellref">{{(selAddr sel)}}</span>
    <input class="fx" value={{formulaBar}} onInput={{(dispatch "sheet.bar-input")}} />
    <button class="commit" onClick={{(dispatch "sheet.commit")}}>✓</button>
  </div>
  <div class="grid">{{(assembleTable cellViews dims sel)}}</div>
  <div class="meta-panel">
    <h4>{{(selAddr sel)}} — metadata</h4>
    <pre class="meta">{{(currentMeta sel)}}</pre>
  </div>
</div>`;

// ── builder ─────────────────────────────────────────────────────────────────

export const buildSheetsApp = async (
  state: any, opts: { rows?: number; cols?: number; cells?: Record<string, string>; monolithicToolbar?: boolean } = {},
): Promise<void> => {
  const monolithic = opts.monolithicToolbar === true;
  const rows = opts.rows ?? 6;
  const cols = opts.cols ?? 6;
  const setCelFn_ = resolveFn(state as never, "setCel") as (s: unknown, k: string, spec: unknown) => Promise<unknown>;
  const reg = (s: unknown, a: { key: string; fn?: unknown; kind?: string; locked?: boolean; segment?: string }) =>
    setCelFn_(s, a.key, { celType: a.locked ? "LockedLambdaCel" : "EditableLambdaCel", locked: a.locked, fn: a.fn, metadata: { segment: a.segment, kind: a.kind } });
  await reg(state, { key: "cellVnode", fn: cellVnode, kind: "custom" });
  await reg(state, { key: "assembleTable", fn: assembleTable, kind: "custom" });
  await reg(state, { key: "selAddr", fn: selAddr, kind: "custom" });
  await reg(state, { key: "sheet.click", fn: clickCell, kind: "custom" });
  await reg(state, { key: "sheet.bar-input", fn: barInput, kind: "custom" });
  await reg(state, { key: "sheet.commit", fn: commit, kind: "custom" });
  await reg(state, { key: "sheet.key", fn: keyNav, kind: "custom" });
  await reg(state, { key: "if", fn: (c: unknown, a: unknown, b: unknown) => (c ? a : b), kind: "custom" });
  await reg(state, { key: "eq", fn: (a: unknown, b: unknown) => a === b, kind: "custom" });
  await reg(state, { key: "toolbarLabel", fn: (doc: unknown) => String(doc ?? "(unsaved)").replace(/[<>{}]/g, ""), kind: "custom" });

  // currentMeta closes over state so the template can show the selected
  // cel's metadata without dragging state through the formula language.
  await reg(state, {
    key: "currentMeta", kind: "custom",
    fn: (sel: { row?: number; col?: number } | undefined) => {
      if (!sel) return "(no selection)";
      const cel = state.cels.get(cellKey(addrFrom(sel.col ?? 0, sel.row ?? 0)));
      if (!cel) return "(no cell)";
      const view: Record<string, unknown> = { celType: cel.celType, metadata: cel.metadata };
      if (cel.f !== undefined) view.f = cel.f;
      if (cel.celType === "ValueCel") view.v = cel.v;
      return JSON.stringify(view, null, 2);
    },
  });
  await setupFileToolbar(state);

  // grid data + view cel keys (row-major). View keys feed sheet.view's
  // array-ref input; data keys go into the doc-binding registry so File
  // toolbar's new/save/open knows which cels are document content.
  const cellViewKeys: string[] = [];
  const cellDataKeys: string[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const addr = addrFrom(c, r);
    cellViewKeys.push(`sheet.${addr}.view`);
    cellDataKeys.push(cellKey(addr));
  }
  registerDocBinding({ app: "sheets", cels: cellDataKeys, empty: () => "" });

  const seg = buildSheet({ rows, cols, cells: opts.cells ?? {}, segment: "sheets" }) as { name: string; version: string; dependencies: string[]; cels: any[] };

  // per-cell view cels — one FormulaCel per cell emits a <td> VNode
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const addr = addrFrom(c, r);
    seg.cels.push({
      key: `sheet.${addr}.view`, celType: "FormulaCel",
      metadata: { key: `sheet.${addr}.view`, segment: "sheets", parser: "f", inputMap: { value: cellKey(addr) } },
      f: `(cellVnode value "${addr}")`,
    });
  }

  seg.cels.push({
    key: "sheet.mount", celType: "FormulaCel",
    metadata: { key: "sheet.mount", segment: "sheets", parser: "f", inputMap: { active: "os.active" } },
    f: `(if (eq active "sheets") "#app" null)`,
  });
  // Global keyboard listener spec (RenderSpec.listeners reserved input).
  // Static — keyNav self-gates on os.active, so attach-once is safe.
  seg.cels.push({
    key: "sheet.listeners", celType: "ValueCel",
    metadata: { key: "sheet.listeners", segment: "sheets" },
    v: ['document|keydown|(dispatch "sheet.key")'],
  });
  // App-type advertisement — file-explorer + picker read this for our file icon.
  seg.cels.push({
    key: "sheets.app-type", celType: "ValueCel",
    metadata: { key: "sheets.app-type", segment: "sheets" },
    v: { key: "sheets", title: "Sheets", extension: "csv", icon: "📊" },
  });
  if (!monolithic) {
    seg.cels.push({
      key: "sheet.toolbar.view", celType: "FormulaCel",
      metadata: {
        key: "sheet.toolbar.view", segment: "sheets", parser: "html-template", schema: "render-spec",
        inputMap: { doc: "os.doc" },
      },
      f: TOOLBAR_FRAGMENT_TEMPLATE,
    });
  }
  seg.cels.push({
    key: "sheet.view", celType: "FormulaCel",
    metadata: {
      key: "sheet.view", segment: "sheets", parser: "html-template", schema: "render-spec",
      channel: ["plastron-dom.paint"],
      inputMap: monolithic
        ? { mount: "sheet.mount", listeners: "sheet.listeners", sel: "sheet.selection", formulaBar: "sheet.formula-bar", doc: "os.doc", cellViews: cellViewKeys, dims: "sheet.dims" }
        : { mount: "sheet.mount", listeners: "sheet.listeners", sel: "sheet.selection", formulaBar: "sheet.formula-bar", cellViews: cellViewKeys, dims: "sheet.dims" },
    },
    f: monolithic
      ? SHEET_TEMPLATE.replace('{{(cel "sheet.toolbar.view")}}', '{{(renderFileToolbar doc)}}')
      : SHEET_TEMPLATE,
  });

  const deps = ["sheet", "app-host", "html-template-parser", "plastron-dom", "segment-store", "user-space-ops"];
  const hydrate = resolveFn(state, "hydrate") as (s: unknown, segs: unknown, m: unknown) => Promise<unknown>;
  await hydrate(state, [{ ...seg, dependencies: deps, role: "application" }], [{ name: "sheets", version: "0.1.0", dependencies: deps, role: "application" }]);
  // Register with the file-explorer's app-type registry (a no-op if
  // file-explorer hasn't booted yet — bootOS arranges the order so it has).
  const registerApp = resolveFn(state, "fe.register-app") as ((...a: unknown[]) => Promise<unknown>) | undefined;
  if (registerApp) await registerApp(state, state.cels.get("sheets.app-type")?.v);
};
