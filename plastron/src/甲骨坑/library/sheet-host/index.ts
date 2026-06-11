import type { 甲骨, Cel, Fn, VElement } from "../../../types/index.js";
import { bindNativeFns, isSecretHandleRef } from "../../../kernel/index.js";
import { el as makeEl, text as T, memo } from "../dom/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// sheet-host — the spreadsheet view loop as a reusable capability, extracted
// from origin (apps-are-cels). The render cluster (displayCell + the Excel-grid
// renderer + the editor + mount placement) parameterized over a small view
// config so any host mounts it: sheetView(cfg, editing, draft, mount, error,
// keys, vals, srcs) where cfg = { base, draftCel, editHandler, keyHandler }.
// genesisSummary is duplicated (origin's drain uses its own copy; segments
// can't import each other — a generic formatter dup is fine).
// ============================================================================

type V = { type: "el" | "text"; tag?: string; key?: string; memo?: unknown; attrs?: Record<string, unknown>; events?: Record<string, unknown>; children?: V[]; text?: string };
const el = makeEl as unknown as (tag: string, attrs?: Record<string, unknown>, children?: V[], events?: Record<string, unknown>) => V;

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

const isVnode = (v: unknown): v is V =>
  !!v && typeof v === "object" && ((v as V).type === "el" || (v as V).type === "text");

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

const displayCell = (v: unknown): V => {
  if (isVnode(v)) return v as V;
  if (v === null || v === undefined || v === "") return T("");
  if (typeof v === "object") {
    const o = v as { kind?: unknown; message?: unknown; genesis?: unknown; cels?: unknown; defn?: unknown; name?: unknown; __mount?: unknown };
    if (o.kind === "error") return T(/undefined symbol|not a function/.test(String(o.message)) ? "#NAME?" : "#ERR!");
    if (o.genesis === true) return el("pre", { class: "cell-pre", style: SX.pre }, [T(genesisSummary(o.cels as Record<string, unknown> | undefined))]);
    if (o.defn === true) return T(`ƒ ${String(o.name ?? "")}`);
    if (isSecretHandleRef(v)) return T(`🔑 ${(v as { name: string }).name}`); // wallet handle (or persisted ref) — never the secret
    if (typeof o.__mount === "string") return T(""); // content renders elsewhere (mounted) — the cell stays clean
    try { return T(JSON.stringify(v).slice(0, 60)); } catch { return T("#ERR!"); }
  }
  // a multi-line string (inspect output, a paragraph) keeps its shape in a
  // <pre>; inline it stays a one-line preview (.cell-value clips it), but
  // the ⤢ expand panel shows it formatted top-to-bottom.
  if (typeof v === "string" && v.includes("\n")) return el("pre", { class: "cell-pre", style: SX.pre }, [T(v)]);
  return T(String(v));
};

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

const sheetView: Fn = ((
  cfg: unknown, editing: unknown, draft: unknown, mount: unknown, error: unknown, keys: unknown, vals: unknown, srcs: unknown,
) => {
  const c = (cfg ?? {}) as { base?: string; draftCel?: string; editHandler?: string; keyHandler?: string };
  const BASE = c.base ?? "元", DRAFT = c.draftCel ?? "元.draft", EDIT = c.editHandler ?? "origin.edit", KEYH = c.keyHandler ?? "origin.key";
  const ks = Array.isArray(keys) ? (keys as string[]) : ["元"];
  const vs = Array.isArray(vals) ? (vals as unknown[]) : [];
  const ss = Array.isArray(srcs) ? (srcs as unknown[]) : [];
  const active = typeof editing === "string" ? editing : null;
  const errMsg = typeof error === "string" ? error : null;
  const valOf = new Map<string, unknown>(); ks.forEach((k, i) => valOf.set(k, vs[i]));
  const srcOf = new Map<string, string>(); ks.forEach((k, i) => srcOf.set(k, String(ss[i] ?? "")));

  // the editor — a resizable textarea (the SAME for every cell), plus an
  // error line when its last formula failed to compile.
  const editor = (key: string): V => {
    // Open the editor at roughly the footprint of what was on screen, so a
    // big cell (the readme, a multi-line formula) doesn't collapse to a tiny
    // box the moment you click it. Size from the draft: rows from line count,
    // width from the longest line — both clamped, and resize:both still lets
    // you adjust by hand.
    const txt = String(draft ?? "");
    const lines = txt.split("\n");
    const rows = Math.min(Math.max(lines.length + 1, 4), 30);
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const widthCh = Math.min(Math.max(longest + 2, 28), 96);
    const editingStyle = `${SX.editing};width:${widthCh}ch;max-width:min(56rem,88vw)`;
    return el("div", { class: "cell-editing", style: editingStyle }, [
      el("textarea", { class: "cell-edit", style: SX.edit, rows, value: txt }, [], {
        input: { set: DRAFT, extract: "value" },
        keydown: { dispatch: KEYH, payload: key }, // origin.key commits on Enter
      }),
      ...(errMsg ? [el("div", { class: "cell-error", style: SX.error }, [T(errMsg)])] : []),
    ]);
  };

  const isMountVal = (v: unknown): boolean => !!v && typeof v === "object" && typeof (v as { __mount?: unknown }).__mount === "string";

  // the inner of a cell: inline editor when active, else the value. A cell
  // whose value renders ELSEWHERE (a mount — e.g. the readme in 元) shows its
  // SOURCE here, so the formula is visible + editable. Click to edit.
  const body = (key: string, value: unknown): V => {
    if (active === key) return editor(key);
    const shown = isMountVal(value) ? el("pre", { class: "cell-pre cell-src", style: SX.src }, [T(srcOf.get(key) ?? "")]) : displayCell(value);
    const valEl = shown.type === "text" ? el("span", { class: "cell-val-text", style: SX.valFirst }, [shown]) : shown;
    return el("div", { class: "cell-value", title: "click to edit", style: SX.cellValue }, [valEl],
      { click: { dispatch: EDIT, payload: key } });
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
          // memo hint → dom's diff skips an unchanged cell's deep compare
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
  if (base.length) sections.push(sheetTable(BASE, base.map((k, i) => ({ key: k, col: 0, row: i }))));
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
}) as Fn;

export const name = "sheet-host" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sheetView", sheetView],
]));
