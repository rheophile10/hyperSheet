import type { 甲骨, Cel, Fn, State, VElement } from "../../../types/index.js";
import { bindNativeFns, isSecretHandleRef, resolveFn, bundleSegments, setAccessPolicy, precompute } from "../../../kernel/index.js";
import { el as makeEl, text as T, memo } from "../dom/index.js";
import { fromXlsx } from "../xlsx/index.js";
import { zipBytes, unzipBytes } from "../segment-archive/index.js";
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
  edit: "width:100%;box-sizing:border-box;max-width:100%;min-height:2.6rem;resize:vertical;font-family:ui-monospace,monospace;font-size:.85rem;padding:.15rem .4rem;border:0;background:#4a90d922;white-space:pre-wrap;line-height:1.4",
  fxbar: "flex:0 0 auto;display:flex;align-items:stretch;gap:.3rem;padding:.2rem .4rem;background:#8881;border-bottom:1px solid #8883",
  fxlabel: "flex:0 0 auto;align-self:center;color:#888;font:600 .76rem ui-monospace,monospace",
  fxinput: "flex:1 1 auto;box-sizing:border-box;min-height:7.5rem;resize:vertical;overflow-y:auto;overflow-x:hidden;font-family:ui-monospace,monospace;font-size:.82rem;padding:.15rem .35rem;border:1px solid #8884;border-radius:.25rem;background:Canvas;color:CanvasText;white-space:pre-wrap;word-break:break-word",
  glyphBtn: "border:0;background:#8882;border-radius:.2rem;cursor:pointer;font:600 1.1rem ui-monospace,monospace;line-height:1;padding:.2rem .4rem;color:#888",
} as const;

const displayCell = (v: unknown): V => {
  if (isVnode(v)) return v as V;
  if (v === null || v === undefined || v === "") return T("");
  if (typeof v === "object") {
    const o = v as { kind?: unknown; message?: unknown; genesis?: unknown; cels?: unknown; defn?: unknown; name?: unknown; __mount?: unknown; __client?: unknown; provider?: unknown; status?: unknown; error?: unknown };
    if (o.kind === "error") return T(/undefined symbol|not a function/.test(String(o.message)) ? "#NAME?" : "#ERR!");
    // a captured llm CLIENT handle (makeclient) — show provider + status, never
    // the key: "claude ✓ ready" when armed, "grok ✗ no key" on error.
    if (o.__client === true) return T(`${String(o.provider ?? "client")} ${o.status === "ready" ? "✓ ready" : String(o.error ?? "✗ error")}`);
    if (o.genesis === true) return el("pre", { class: "cell-pre", style: SX.pre }, [T(genesisSummary(o.cels as Record<string, unknown> | undefined))]);
    if (o.defn === true) return T(`ƒ ${String(o.name ?? "")}`);
    if (isSecretHandleRef(v)) return T(`🔑 ${(v as { name: string }).name}`); // wallet handle (or persisted ref) — never the secret
    if (typeof o.__mount === "string") return T(""); // content renders elsewhere (mounted) — the cell stays clean
    // a plain object/array (a message list, a row set, …) renders as readable,
    // pretty-printed JSON in a wrapping <pre> — NOT String()'d to "[object
    // Object]" nor a 60-char one-liner. The full text is reachable: the cell
    // resizes/expands and the <pre> wraps + scrolls.
    try { return el("pre", { class: "cell-pre", style: SX.pre }, [T(JSON.stringify(v, null, 2))]); } catch { return T("#ERR!"); }
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
  cfg: unknown, editing: unknown, draft: unknown, mount: unknown, error: unknown, keys: unknown, vals: unknown, srcs: unknown, geom?: unknown, selected?: unknown, tabdrag?: unknown,
) => {
  const c = (cfg ?? {}) as { base?: string; draftCel?: string; editHandler?: string; keyHandler?: string; selectHandler?: string; fireHandler?: string };
  const BASE = c.base ?? "元", DRAFT = c.draftCel ?? "元.draft", EDIT = c.editHandler ?? "origin.edit", KEYH = c.keyHandler ?? "origin.key";
  const SELH = c.selectHandler ?? "origin.select", FIREH = c.fireHandler ?? "origin.fire";
  const selectedKey = typeof selected === "string" ? selected : null;   // the SELECTED cell key (Excel single-click; value stays in the grid)
  const GM = (geom && typeof geom === "object" && !Array.isArray(geom)) ? geom as Record<string, { x?: number; y?: number; w?: number; h?: number; z?: number; min?: number; closed?: number; host?: string; tab?: string; max?: number; order?: number; glow?: number; savemenu?: number }> : {};
  // the tab chip currently being dragged (winsheet.tabdrag = {host, tab}); its
  // chip lights up in the SAME blue as a window's drop-target glow.
  const draggedTab = (tabdrag && typeof tabdrag === "object" && !Array.isArray(tabdrag)) ? (tabdrag as { tab?: unknown }).tab : undefined;
  // wrap a worksheet's table in a draggable window frame, positioned by win.geom
  // (default staggered by index). Drag/resize/raise/minimize dispatch to the
  // winsheet.* handlers; the table inside is unchanged, so cells stay editable.
  const gnum = (v: unknown, d: number): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const BTN = "border:0;background:transparent;cursor:pointer;font:600 .9rem ui-monospace,monospace;padding:0 .28rem;line-height:1";
  // ONE of ◱ (mid/restore) and ⛶ (maximize) shows, by state: maximized → ◱
  // (go medium), not maximized → ⛶ (maximize). Never both.
  // a titlebar button that does NOT start a window drag (pointerdown stops, like
  // the existing ◱⛶–✕ controls).
  const tbBtn = (cls: string, glyph: string, title: string, dispatch: string, payload: unknown): V =>
    el("button", { class: cls, title, style: BTN }, [T(glyph)], { pointerdown: { dispatch: "winsheet.stop" }, click: { dispatch, payload } });
  const titlebar = (host: string, maxed: boolean): V => el("div", { class: "pl-titlebar", style: "flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:.4rem;padding:.25rem .55rem;background:#8881;cursor:move;user-select:none;touch-action:none;font:600 .8rem ui-monospace,monospace" }, [
    el("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, [T(host)]),
    el("div", { style: "display:flex;flex:0 0 auto;gap:.05rem" }, [
      tbBtn("pl-save-btn", "💾", "save", "winsheet.savefmt", host),
      tbBtn("pl-open-btn", "📁", "open", "winsheet.open", host),
      tbBtn("pl-new-btn", "🆕", "new sheet", "winsheet.newsheet", host),
      maxed
        ? tbBtn("pl-win-btn", "◱", "mid size", "winsheet.mid", host)
        : tbBtn("pl-win-btn", "⛶", "maximize", "winsheet.maximize", host),
      tbBtn("pl-min-btn", "–", "minimize", "winsheet.minimize", host),
      el("button", { class: "pl-close-btn", title: "close", style: BTN + ";color:#d4453e" }, [T("✕")], { pointerdown: { dispatch: "winsheet.stop" }, click: { dispatch: "winsheet.close", payload: host } }),
    ]),
  ], { pointerdown: { dispatch: "winsheet.grab", payload: host }, pointermove: { dispatch: "winsheet.move" }, pointerup: { dispatch: "winsheet.drop" } });
  // the inline save-format chooser (shown under the titlebar when win.geom[seg]
  // .savemenu is set): 3 buttons — CSV / XLSX / .甲 — each dispatching
  // winsheet.saveas with { seg, fmt }. CSV = values; XLSX = values (excel);
  // .甲 = the rich archive (cels + formulas).
  const saveMenu = (host: string): V => {
    const b = (label: string, fmt: string): V => el("button", { class: "pl-savefmt", "data-fmt": fmt, style: "flex:0 0 auto;border:1px solid #8884;border-radius:.3rem;background:Canvas;color:CanvasText;cursor:pointer;font:600 .74rem ui-monospace,monospace;padding:.2rem .55rem" }, [T(label)], { pointerdown: { dispatch: "winsheet.stop" }, click: { dispatch: "winsheet.saveas", payload: { seg: host, fmt } } });
    return el("div", { class: "pl-savemenu", style: "flex:0 0 auto;display:flex;gap:.3rem;align-items:center;padding:.25rem .5rem;background:#8881;border-bottom:1px solid #8883;font:600 .72rem ui-monospace,monospace" }, [
      el("span", { style: "color:#888;margin-right:.1rem" }, [T("save as:")]), b("CSV", "csv"), b("XLSX", "xlsx"), b(".甲", "甲"),
    ]);
  };
  // a window may HOST others as TABS (win.geom[seg].host === this). It renders a
  // tab strip + the active tab's table; the others' standalone windows are gone.
  // does cell `key` belong to worksheet segment `seg`? (base 元 is its own
  // segment; a grid cell is `<seg>.A1`.)
  const keyInSeg = (key: string, seg: string): boolean => key === seg || key.startsWith(seg + ".");
  // the resizable formula bar under a window's titlebar — the Excel edit surface.
  // It shows the SELECTED cell's source (元.selectedSrc, seeded into 元.draft on
  // select) when that cell belongs to one of this window's tabs, so the grid keeps
  // rendering the value while the bar shows the formula. The textarea binds 元.draft
  // and commits on Enter (origin.key) to the selected cell. Left-to-right: a W wiki
  // button, a gun (SVG) fire button, then the formula textarea.
  const formulaBar = (tabSegs: string[]): V => {
    const barKey = selectedKey && tabSegs.some((s) => keyInSeg(selectedKey!, s)) ? selectedKey : null;
    const shown = barKey ? String(draft ?? "") : "";
    const input = barKey
      ? el("textarea", { class: "pl-fxbar-input", style: SX.fxinput, rows: 1, value: shown, "data-key": barKey }, [], {
          input: { set: DRAFT, extract: "value" },
          keydown: { dispatch: KEYH, payload: barKey },   // origin.key commits on Enter to the selected cell
        })
      : el("textarea", { class: "pl-fxbar-input", style: SX.fxinput + ";color:#888;font-style:italic", rows: 1, readonly: "", placeholder: "click a cell to see and edit its formula here" }, []);
    // a lightning bolt — inline SVG filled lightning yellow (#f5c518) to match
    // the readme's ⚡ try-it buttons: the formula bar's ⚡ runs (re-evaluates)
    // the selected cell. (svg/path render via the painter's createElementNS path.)
    const boltIcon = el("svg", { class: "pl-fxbar-bolt-svg", width: "22", height: "22", viewBox: "0 0 24 24", fill: "#f5c518", "aria-hidden": "true", style: "display:block" }, [
      el("path", { d: "M7 2v11h3v9l7-12h-4l4-8z" }, []),
    ]);
    const fireBtn = el("button", { class: "pl-fxbar-fire", title: "fire — re-evaluate this cell", style: SX.glyphBtn + ";align-self:center;display:flex;align-items:center" }, [boltIcon], { click: { dispatch: FIREH, payload: barKey ?? "" } });
    const wikiBtn = el("button", { class: "pl-fxbar-wiki", title: "wiki — what is this cell?", style: SX.glyphBtn + ";align-self:center;font-family:Georgia,serif;color:CanvasText" }, [T("W")], { click: { dispatch: "wiki.open", payload: barKey ?? tabSegs[0] ?? "元" } });
    // 🛡 trust badge — cycle THIS sheet's segment through locked→compute→net→
    // trusted; the new level surfaces in the status line (origin.trust handler).
    const barSeg = barKey ? barKey.split(".")[0]! : (tabSegs[0] ?? "元");
    const trustBtn = el("button", { class: "pl-fxbar-trust", title: "trust — cycle this sheet's capabilities (locked → compute → net → trusted)", style: SX.glyphBtn + ";align-self:center" }, [T("🛡")], { click: { dispatch: "origin.trust", payload: barSeg } });
    return el("div", { class: "pl-fxbar", style: SX.fxbar }, [
      trustBtn,
      wikiBtn,
      fireBtn,
      input,
    ]);
  };
  const windowed = (host: string, tabs: string[], activeTable: V, active: string, i: number): V => {
    const g = GM[host] ?? {};
    if (g.closed) return el("div", { class: "pl-window-closed", "data-win": host, style: "display:none" }, []);
    if (g.min) return el("div", { class: "pl-window-min", "data-win": host, style: "display:none" }, []);
    const x = gnum(g.x, 40 + i * 34), y = gnum(g.y, 40 + i * 34), w = gnum(g.w, 380), h = gnum(g.h, 260), z = gnum(g.z, 1);
    // the tab strip — a "+" that genesis-creates a new blank sheet tabbed into
    // THIS window (winsheet.newtab), plus one chip per sheet WHEN tabbed (>1). A
    // single-sheet window shows just "+" (no self-chip), so the chips still read
    // [host, …tabs] only when there's a real tab group.
    const plusBtn = el("button", { class: "pl-tab-add", title: "new sheet (tab)", style: "flex:0 0 auto;border:1px solid #8884;border-bottom:0;border-radius:.3rem .3rem 0 0;background:#8882;color:CanvasText;cursor:pointer;font:600 .82rem ui-monospace,monospace;padding:.18rem .5rem;line-height:1" }, [T("+")], { pointerdown: { dispatch: "winsheet.stop" }, click: { dispatch: "winsheet.newtab", payload: host } });
    // render tabs by their win.geom[seg].order (the explicit tab-order a drag
    // rewrites); ties / unset fall back to the incoming order. A tab chip is
    // draggable: pointerdown starts a tab-drag (winsheet.tabGrab), pointermove
    // reorders among siblings or marks a tear-off, pointerup commits.
    const ordered = tabs.length > 1 ? [...tabs].sort((a, b) => gnum(GM[a]?.order, tabs.indexOf(a)) - gnum(GM[b]?.order, tabs.indexOf(b))) : tabs;
    const tabChips = ordered.length > 1 ? ordered.map((seg) => {
      const dragging = seg === draggedTab;   // the dragged chip glows blue (matches .drop-target)
      const dragGlow = dragging ? ";outline:3px solid #4a90d9;outline-offset:1px;box-shadow:0 0 0 3px #4a90d955" : "";
      return el("button", { class: "pl-tab" + (seg === active ? " active" : "") + (dragging ? " drop-target" : ""), "data-tab": seg, style: `flex:0 0 auto;border:1px solid #8884;border-bottom:0;border-radius:.3rem .3rem 0 0;background:${dragging ? "#4a90d922" : (seg === active ? "Canvas" : "#8882")};color:CanvasText;cursor:grab;touch-action:none;user-select:none;font:600 .74rem ui-monospace,monospace;padding:.18rem .55rem;white-space:nowrap;opacity:${dragging ? "1" : (seg === active ? "1" : ".7")}${dragGlow}` }, [T(seg)], { pointerdown: { dispatch: "winsheet.tabGrab", payload: { host, tab: seg } }, pointermove: { dispatch: "winsheet.tabMove", payload: { host, tab: seg } }, pointerup: { dispatch: "winsheet.tabDrop", payload: { host, tab: seg } }, click: { dispatch: "winsheet.tab", payload: { host, tab: seg } }, dblclick: { dispatch: "winsheet.tearoff", payload: seg } });
    }) : [];
    const tabStrip = el("div", { class: "pl-tabs", style: "flex:0 0 auto;display:flex;gap:.15rem;padding:.25rem .3rem 0;background:#8881;overflow-x:auto" }, [...tabChips, plusBtn], { pointerup: { dispatch: "winsheet.tabDrop", payload: { host } } });
    // a drop-target GLOW (win.geom[host].glow) while a window/tab is dragged
    // over this one, so the user sees where it will land (tab/stack).
    const glow = g.glow ? ";outline:3px solid #4a90d9;outline-offset:1px;box-shadow:0 0 0 3px #4a90d955,0 4px 16px #0004" : ";box-shadow:0 4px 16px #0004";
    return el("div", { class: "pl-window" + (g.glow ? " drop-target" : ""), "data-win": host, style: `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:${z};display:flex;flex-direction:column;border:1px solid #8886;border-radius:6px;background:Canvas${glow};overflow:hidden` }, [
      titlebar(host, !!g.max),
      ...(g.savemenu ? [saveMenu(host)] : []),
      ...(tabStrip ? [tabStrip] : []),
      formulaBar(tabs),
      el("div", { class: "pl-window-body", style: "flex:1 1 auto;overflow:auto;padding:.25rem;min-height:0" }, [activeTable]),
      el("div", { class: "pl-resize", style: "position:absolute;right:0;bottom:0;width:15px;height:15px;cursor:nwse-resize;touch-action:none;background:linear-gradient(135deg,transparent 45%,#8886 45%,#8886 55%,transparent 55%)" }, [], { pointerdown: { dispatch: "winsheet.grabResize", payload: host }, pointermove: { dispatch: "winsheet.resizeMove" }, pointerup: { dispatch: "winsheet.drop" } }),
    ], { pointerdown: { dispatch: "winsheet.raise", payload: host } });
  };
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

  // the inner of a cell: inline editor when active (double-click), else the VALUE.
  // A cell whose value renders ELSEWHERE (a mount — e.g. the readme in 元) shows
  // its SOURCE here, so the formula is visible. Single-click SELECTS (origin.select
  // — the value stays, the formula bar shows the source); double-click opens the
  // inline editor (origin.edit).
  const body = (key: string, value: unknown): V => {
    if (active === key) return editor(key);
    const shown = isMountVal(value) ? el("pre", { class: "cell-pre cell-src", style: SX.src }, [T(srcOf.get(key) ?? "")]) : displayCell(value);
    const valEl = shown.type === "text" ? el("span", { class: "cell-val-text", style: SX.valFirst }, [shown]) : shown;
    return el("div", { class: "cell-value", title: "click to select; double-click to edit", style: SX.cellValue }, [valEl],
      { click: { dispatch: SELH, payload: key }, dblclick: { dispatch: EDIT, payload: key } });
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
          const isSelected = selectedKey === k;
          // mount cells (showing a long source) get a roomier min-width; the active
          // (editing) cell gets the blue outline; a SELECTED-but-not-editing cell
          // gets a lighter selection outline — the value still renders.
          const outline = isActive ? ";outline:2px solid #4a90d9;outline-offset:-2px"
            : (isSelected ? ";outline:2px solid #4a90d999;outline-offset:-2px" : "");
          const tdStyle = `${SX.td};position:relative;min-width:${isMountVal(v) ? "26rem" : "4.5rem"}${outline}`;
          const td = el("td", { class: isActive ? "cell editing" : (isSelected ? "cell selected" : "cell"), "data-key": k, style: tdStyle }, [body(k, v)]);
          // memo hint → dom's diff skips an unchanged cell's deep compare
          // (O(changed), library-level). The ACTIVE/SELECTED cell gets NO memo — its
          // editor/outline depends on draft/selection — so it's always deep-diffed.
          return (isActive || isSelected) ? td : (memo(td as unknown as VElement, [v, srcOf.get(k)]) as unknown as V);
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

  // each worksheet's table, then group by host: a hosted worksheet is a TAB.
  const tableOf = new Map<string, V>();
  if (base.length) tableOf.set(BASE, sheetTable(BASE, base.map((k, i) => ({ key: k, col: 0, row: i }))));
  for (const [layer, members] of layers) {
    const entries = members.map((k) => { const a = addrOf(k); return a ? { key: k, col: a.col, row: a.row } : null; }).filter((e): e is { key: string; col: number; row: number } => !!e);
    if (entries.length) tableOf.set(layer, sheetTable(layer, entries));
  }
  const childrenOf = new Map<string, string[]>(); const topLevel: string[] = [];
  for (const seg of tableOf.keys()) {
    const host = GM[seg]?.host as string | undefined;
    if (typeof host === "string" && host !== seg && tableOf.has(host)) (childrenOf.get(host) ?? childrenOf.set(host, []).get(host)!).push(seg);
    else topLevel.push(seg);
  }
  const sections: V[] = [];
  let wi = 0;
  for (const H of topLevel) {
    const tabs = [H, ...(childrenOf.get(H) ?? [])];
    const tabSel = GM[H]?.tab as string | undefined;
    const active = (typeof tabSel === "string" && tabs.includes(tabSel)) ? tabSel : H;
    sections.push(windowed(H, tabs, tableOf.get(active)!, active, wi++));
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

  // taskbar — worksheet windows (winsheet.restore) AND state-cel windows
  // (winapp/chatapp/winframe → winx.show). (A lineage TREE replaces this flat
  // strip — see window-lineage-launcher.md.)
  // Worksheet windows: TABBED ones (win.geom[seg].host pointing at another
  // window) ride INSIDE their host's tab strip — they must NOT get their own
  // taskbar entry. Only top-level (un-hosted) worksheet windows show.
  const allWins = [...(base.length ? [BASE] : []), ...[...layers.keys()].filter((seg) => layers.get(seg)!.some((k) => addrOf(k)))]
    .filter((seg) => { const h = GM[seg]?.host; return !(typeof h === "string" && h !== seg); });
  // State-cel windows: collected with their `linked` membership so a LINKED
  // group collapses to one entry. `linked` holds SEGMENT names (segOf(ref));
  // a window's own segment is `ref` minus ".state".
  interface SW { ref: string; seg: string; title: string; off: boolean; linked: string[] }
  const stateWins: SW[] = [];
  for (const k of ks) {
    if (!k.endsWith(".state")) continue;
    const v = valOf.get(k) as { ref?: string; title?: string; closed?: number; min?: number; linked?: string[] } | undefined;
    if (v && typeof v === "object" && typeof v.ref === "string") {
      const seg = v.ref.replace(/\.state$/, "");
      stateWins.push({ ref: v.ref, seg, title: String(v.title ?? k), off: !!(v.closed || v.min), linked: Array.isArray(v.linked) ? v.linked.map(String) : [] });
    }
  }
  // Union-find over windows whose `linked` sets intersect (connected components).
  // Each window unions its own segment with every segment it links to; windows
  // sharing any linked member land in one group. Robust to chains (a↔b, b↔c).
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  const union = (a: string, b: string): void => { parent.set(find(a), find(b)); };
  for (const w of stateWins) { if (parent.get(w.seg) === undefined) parent.set(w.seg, w.seg); for (const l of w.linked) { if (parent.get(l) === undefined) parent.set(l, l); union(w.seg, l); } }
  // collapse to one entry per component (only present windows; a `linked` name
  // with no live window just merges the components it bridges). First member in
  // ks order is the representative the entry shows + acts on.
  const groups = new Map<string, SW[]>();
  for (const w of stateWins) { const root = find(w.seg); (groups.get(root) ?? groups.set(root, []).get(root)!).push(w); }
  const stateEntries = [...groups.values()].map((members) => {
    const rep = members[0]!;
    const off = members.every((m) => m.off);                 // grey only if EVERY member is hidden
    const label = members.length > 1 ? `🔗 ${rep.title}` : rep.title;
    return { ref: rep.ref, title: label, off };
  });
  const taskItem = (label: string, ref: string, off: boolean, handler: string): V => el("button", { class: "pl-task" + (off ? " off" : ""), "data-win": ref, style: `flex:0 0 auto;padding:.2rem .6rem;border:1px solid #8884;border-radius:.3rem;background:${off ? "#8882" : "Canvas"};cursor:pointer;font:600 .76rem ui-monospace,monospace;opacity:${off ? ".55" : "1"};white-space:nowrap` }, [T(label)], { click: { dispatch: handler, payload: ref } });
  const taskbar = el("div", { class: "pl-taskbar", style: "position:fixed;left:0;right:0;bottom:0;display:flex;gap:.4rem;padding:.3rem .5rem;background:#8881;border-top:1px solid #8883;z-index:99999;overflow-x:auto;align-items:center" },
    [el("span", { style: "font:600 .72rem ui-monospace,monospace;color:#888;flex:0 0 auto;margin-right:.2rem" }, [T("windows:")]),
     ...allWins.map((seg) => taskItem(seg, seg, !!(GM[seg]?.min || GM[seg]?.closed), "winsheet.restore")),
     ...stateEntries.map((w) => taskItem(w.title, w.ref, w.off, "winx.show"))]);
  // .origin is the positioned desktop the windows float on; the taskbar pins to the bottom.
  const originNode = el("div", { class: "origin", style: "position:relative;min-height:90vh;width:100%;padding-bottom:3rem" }, [...sections, taskbar]);

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

// ── windowed worksheets ──────────────────────────────────────────────────────
// Every worksheet renders in a draggable window (sheetView wraps each table in a
// frame). Geometry for ALL windows lives in ONE map cel — win.geom = { seg:
// {x,y,w,h,z,min} } — so the cell set isn't cluttered with per-axis cels and
// sheetView gets it as one input. The handlers update that map; the cells inside
// a window are unchanged, so editing/selection still work as before.
interface WGeom { x?: number; y?: number; w?: number; h?: number; z?: number; min?: number; closed?: number; host?: string; tab?: string; max?: number; order?: number; glow?: number; savemenu?: number }
interface WWinEl { offsetLeft?: number; offsetTop?: number }
interface WEvt { clientX?: number; clientY?: number; pointerId?: number; currentTarget?: { setPointerCapture?: (id: number) => void; closest?: (s: string) => WWinEl | null }; stopPropagation?: () => void }
// win.geom is in 元.view's inputMap, so a geom change re-fires the view — but
// that re-fire must propagate through the cycle BEFORE we paint, or the first
// drain repaints the stale frame (a just-closed/minimized window not yet swapped
// for its stub) and no second paint is scheduled. runCycle first so one gesture
// lands. (drag fires repeatedly so it always caught up; close/min are one-shot.)
const wrepaint = async (state: State): Promise<unknown> => {
  await Promise.resolve((resolveFn(state, "runCycle") as Fn)(state));
  return Promise.resolve((resolveFn(state, "drain") as Fn)(state, "dom.paint"));
};
const geomMap = (state: State): Record<string, WGeom> => { const v = state.cels.get("win.geom")?.v; return (v && typeof v === "object" && !Array.isArray(v)) ? { ...(v as Record<string, WGeom>) } : {}; };
const setGeom = (state: State, m: Record<string, WGeom>): Promise<unknown> => Promise.resolve((resolveFn(state, "setValue") as Fn)(state, "win.geom", m)).then(() => wrepaint(state));
const wdrag = (state: State): { seg: string; ox: number; oy: number; resize?: boolean } | null | undefined => state.cels.get("winsheet.drag")?.v as { seg: string; ox: number; oy: number; resize?: boolean } | null | undefined;
const setWdrag = (state: State, v: unknown): Promise<unknown> => Promise.resolve((resolveFn(state, "setValue") as Fn)(state, "winsheet.drag", v));
const wnum = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const wcap = (e?: WEvt): void => { try { e?.currentTarget?.setPointerCapture?.(wnum(e?.pointerId)); } catch { /* off-DOM */ } };
// the data-win of a worksheet window whose titlebar/tab-strip sits under (x,y),
// excluding `selfSeg` (and its ultimate host) — the consolidate/stack target.
const winAtPoint = (x: number, y: number, selfSeg?: string): string | undefined => {
  const doc = (globalThis as { document?: { elementsFromPoint?: (x: number, y: number) => Array<{ closest?: (s: string) => { getAttribute?: (a: string) => string | null } | null }> } }).document;
  for (const e of doc?.elementsFromPoint?.(x, y) ?? []) {
    if (!e.closest?.(".pl-titlebar") && !e.closest?.(".pl-tabs")) continue;
    const w = e.closest?.(".pl-window"); const dw = (w as { getAttribute?: (a: string) => string | null } | null)?.getAttribute?.("data-win") ?? undefined;
    if (dw && dw !== selfSeg) return dw;
  }
  return undefined;
};
// mark exactly one window's geom.glow (the live drop target) and clear the rest,
// so the view paints a single highlight. Returns the patched map (caller persists).
const markGlow = (m: Record<string, WGeom>, target?: string): boolean => {
  let changed = false;
  for (const k of Object.keys(m)) {
    const want = k === target ? 1 : undefined;
    if ((m[k]?.glow ? 1 : undefined) !== want) { m[k] = { ...m[k], glow: want }; changed = true; }
  }
  if (target && !m[target]) { m[target] = { glow: 1 }; changed = true; }
  return changed;
};
interface TabDrag { host: string; tab: string }
const wtabdrag = (state: State): TabDrag | null | undefined => state.cels.get("winsheet.tabdrag")?.v as TabDrag | null | undefined;
// winsheet.tabdrag is in 元.view's inputMap (the dragged chip glows blue), so
// writing it must propagate through the cycle and repaint — the highlight lands
// on grab and clears on drop.
const setWtabdrag = (state: State, v: unknown): Promise<unknown> => Promise.resolve((resolveFn(state, "setValue") as Fn)(state, "winsheet.tabdrag", v)).then(() => wrepaint(state));
// the data-tab of a tab chip under (x,y), if any.
const tabAtPoint = (x: number, y: number): string | undefined => {
  const doc = (globalThis as { document?: { elementsFromPoint?: (x: number, y: number) => Array<{ closest?: (s: string) => { getAttribute?: (a: string) => string | null } | null }> } }).document;
  for (const e of doc?.elementsFromPoint?.(x, y) ?? []) { const chip = e.closest?.(".pl-tab"); const dt = (chip as { getAttribute?: (a: string) => string | null } | null)?.getAttribute?.("data-tab"); if (dt) return dt; }
  return undefined;
};
// the live tab-order of a host's tab clique (host + its hosted children), sorted
// by win.geom[seg].order with the incoming sibling order as the tiebreak.
const tabOrderOf = (m: Record<string, WGeom>, host: string): string[] => {
  const sibs = [host, ...Object.keys(m).filter((k) => m[k]?.host === host)];
  return sibs.sort((a, b) => wnum(m[a]?.order, sibs.indexOf(a)) - wnum(m[b]?.order, sibs.indexOf(b)));
};
// SHARED z fountain: the same `win.topz` cel the windows segment's winx.*
// handlers bump, so a worksheet window raised here can rise above state-cel
// windows (and vice-versa). Default 100. (No private counter — both kinds read
// the one cel; segments can't import, but they CAN share a cel.)
const nextZ = async (state: State): Promise<number> => {
  const z = (Number(state.cels.get("win.topz")?.v) || 100) + 1;
  if (state.cels.get("win.topz")) await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, "win.topz", z));
  else await Promise.resolve((resolveFn(state, "setCel") as Fn)(state, "win.topz", { celType: "ValueCel", v: z, metadata: { key: "win.topz", segment: "win" } }));
  return z;
};

// read the window's ACTUAL position from the DOM (a geom-less window renders
// staggered by index, not at the grab default), so the drag offset is measured
// from where the window SITS — no jump on the first move. offsetLeft/offsetTop
// are relative to the positioned .origin container, the SAME frame win.geom.x/y
// (the `left:${x}px` the move writes) uses — so the math stays consistent.
// Falls back to win.geom (default 60) when there's no DOM (tests).
const winOriginAt = (state: State, seg: string, event?: WEvt): { x: number; y: number } => {
  const w = event?.currentTarget?.closest?.(".pl-window");
  if (w && Number.isFinite(w.offsetLeft) && Number.isFinite(w.offsetTop)) return { x: Number(w.offsetLeft), y: Number(w.offsetTop) };
  const g = geomMap(state)[seg] ?? {};
  return { x: wnum(g.x, 60), y: wnum(g.y, 60) };
};
const wsGrab: Fn = (async (state: State, seg: unknown, event?: WEvt): Promise<void> => { wcap(event); const o = winOriginAt(state, String(seg), event); await setWdrag(state, { seg: String(seg), ox: wnum(event?.clientX) - o.x, oy: wnum(event?.clientY) - o.y }); }) as Fn;
const wsMove: Fn = (async (state: State, _p: unknown, event?: WEvt): Promise<void> => { const d = wdrag(state); if (!d || d.resize) return; const m = geomMap(state); m[d.seg] = { ...(m[d.seg] ?? {}), x: wnum(event?.clientX) - d.ox, y: wnum(event?.clientY) - d.oy }; markGlow(m, winAtPoint(wnum(event?.clientX), wnum(event?.clientY), d.seg)); await setGeom(state, m); }) as Fn;
const wsGrabResize: Fn = (async (state: State, seg: unknown, event?: WEvt): Promise<void> => { wcap(event); const g = geomMap(state)[String(seg)] ?? {}; await setWdrag(state, { seg: String(seg), ox: wnum(event?.clientX) - wnum(g.w, 360), oy: wnum(event?.clientY) - wnum(g.h, 260), resize: true }); }) as Fn;
const wsResizeMove: Fn = (async (state: State, _p: unknown, event?: WEvt): Promise<void> => { const d = wdrag(state); if (!d?.resize) return; const m = geomMap(state); m[d.seg] = { ...(m[d.seg] ?? {}), w: Math.max(160, wnum(event?.clientX) - d.ox), h: Math.max(90, wnum(event?.clientY) - d.oy) }; await setGeom(state, m); }) as Fn;
// dropping a window ONTO another consolidates it as a tab; a host's own children
// re-home to the new ultimate host. Dropped in empty space → just repositioned.
const wsDrop: Fn = (async (state: State, _p: unknown, event?: WEvt & { clientX?: number; clientY?: number }): Promise<void> => {
  const d = wdrag(state); await setWdrag(state, null);
  if (!d || d.resize || !event) { const m0 = geomMap(state); if (markGlow(m0)) await setGeom(state, m0); return; }
  const target = winAtPoint(wnum(event.clientX), wnum(event.clientY), d.seg);
  const m = geomMap(state);
  markGlow(m);                                          // clear any drop-target glow
  if (!target) { await setGeom(state, m); return; }     // no window under the drop → keep the new position
  const ult = (m[target]?.host as string | undefined) ?? target;   // tab into the target's ultimate host
  for (const sgk of Object.keys(m)) if (m[sgk]?.host === d.seg) m[sgk] = { ...m[sgk], host: ult };  // d.seg's children re-home
  m[d.seg] = { ...(m[d.seg] ?? {}), host: ult };
  m[ult] = { ...(m[ult] ?? {}), tab: d.seg, min: 0 };
  await setGeom(state, m);
  // tabbing IS sharing context: the stacked windows form a BUNDLE (a clique —
  // mutual get/set among all tabs), so a minted worksheet can write its
  // tab-mates' cels. Sealing still wins. (Tearoff leaving the bundle: next.)
  const members = [ult, ...Object.keys(m).filter((k) => m[k]?.host === ult)];
  bundleSegments(state, members);
}) as Fn;
const wsTab: Fn = (async (state: State, payload: unknown): Promise<void> => { const p = payload as { host?: string; tab?: string }; if (!p?.host || !p?.tab) return; const m = geomMap(state); m[p.host] = { ...(m[p.host] ?? {}), tab: p.tab }; await setGeom(state, m); }) as Fn;
// ── tab drag: reorder among siblings, or tear OFF into a standalone window ────
// pointerdown on a tab chip records {host, tab} (so a click is still a click —
// tabDrop with no move re-selects the tab). pointermove over a SIBLING chip
// rewrites win.geom[seg].order so the strip re-renders in the dragged order;
// pointerup OUTSIDE the host window tears the tab off (reuse winsheet.tearoff).
const wsTabGrab: Fn = (async (state: State, payload: unknown, event?: WEvt): Promise<void> => {
  const p = payload as TabDrag | undefined; if (!p?.host || !p?.tab) return; wcap(event);
  await setWtabdrag(state, { host: p.host, tab: p.tab });
}) as Fn;
const wsTabMove: Fn = (async (state: State, _payload: unknown, event?: WEvt & { clientX?: number; clientY?: number }): Promise<void> => {
  const d = wtabdrag(state); if (!d) return;
  const over = tabAtPoint(wnum(event?.clientX), wnum(event?.clientY));
  if (!over || over === d.tab) return;                  // not over a different sibling → nothing to reorder
  const m = geomMap(state);
  const order = tabOrderOf(m, d.host);
  const from = order.indexOf(d.tab), to = order.indexOf(over);
  if (from < 0 || to < 0 || from === to) return;
  order.splice(to, 0, order.splice(from, 1)[0]!);       // move the dragged tab into the hovered slot
  order.forEach((seg, i) => { m[seg] = { ...(m[seg] ?? {}), order: i }; });
  await setGeom(state, m);
}) as Fn;
const wsTabDrop: Fn = (async (state: State, _payload: unknown, event?: WEvt & { clientX?: number; clientY?: number }): Promise<void> => {
  const d = wtabdrag(state); await setWtabdrag(state, null);
  if (!d) return;
  // released OFF the host window (not over its titlebar/tabs/body) → tear off.
  const overWin = winAtPoint(wnum(event?.clientX), wnum(event?.clientY));
  const doc = (globalThis as { document?: { elementsFromPoint?: (x: number, y: number) => Array<{ closest?: (s: string) => unknown }> } }).document;
  const overOwnHost = (doc?.elementsFromPoint?.(wnum(event?.clientX), wnum(event?.clientY)) ?? []).some((e) => {
    const w = e.closest?.(".pl-window") as { getAttribute?: (a: string) => string | null } | null; return w?.getAttribute?.("data-win") === d.host;
  });
  if (!overOwnHost && (overWin === undefined || overWin !== d.host)) { await (wsTearoff as unknown as (s: State, seg: unknown) => Promise<void>)(state, d.tab); return; }
  // dropped in place over the host → keep the (already-applied) order; ensure active.
  const m = geomMap(state); m[d.host] = { ...(m[d.host] ?? {}), tab: d.tab }; await setGeom(state, m);
}) as Fn;
const wsTearoff: Fn = (async (state: State, seg: unknown): Promise<void> => { const k = String(seg); const m = geomMap(state); const g = m[k] ?? {}; m[k] = { ...g, host: undefined, x: wnum(g.x, 80) + 40, y: wnum(g.y, 80) + 40, z: await nextZ(state) }; await setGeom(state, m); }) as Fn;
const wsRaise: Fn = (async (state: State, seg: unknown): Promise<void> => { const z = await nextZ(state); const m = geomMap(state); m[String(seg)] = { ...(m[String(seg)] ?? {}), z }; await setGeom(state, m); }) as Fn;
const wsMin: Fn = (async (state: State, seg: unknown): Promise<void> => { const m = geomMap(state); m[String(seg)] = { ...(m[String(seg)] ?? {}), min: 1 }; await setGeom(state, m); }) as Fn;
// close hides the window (closed flag), like minimize but distinct — the taskbar
// still lists it so winsheet.restore (clear closed + min) brings it back. A
// worksheet window is NEVER destroyed (元 must stay restorable).
const wsClose: Fn = (async (state: State, seg: unknown): Promise<void> => { const m = geomMap(state); m[String(seg)] = { ...(m[String(seg)] ?? {}), closed: 1 }; await setGeom(state, m); }) as Fn;
const wsRestore: Fn = (async (state: State, seg: unknown): Promise<void> => { const z = await nextZ(state); const m = geomMap(state); m[String(seg)] = { ...(m[String(seg)] ?? {}), min: 0, closed: 0, z }; await setGeom(state, m); }) as Fn;
const wsMax: Fn = (async (state: State, seg: unknown): Promise<void> => { const g = globalThis as { innerWidth?: number; innerHeight?: number }; const z = await nextZ(state); const m = geomMap(state); m[String(seg)] = { x: 0, y: 0, w: wnum(g.innerWidth, 1200), h: Math.max(160, wnum(g.innerHeight, 800) - 46), z, min: 0, max: 1 }; await setGeom(state, m); }) as Fn;
const wsMid: Fn = (async (state: State, seg: unknown): Promise<void> => { const z = await nextZ(state); const m = geomMap(state); m[String(seg)] = { x: 90, y: 70, w: 540, h: 380, z, min: 0, max: 0 }; await setGeom(state, m); }) as Fn;
const wsStop: Fn = ((_state: State, _p: unknown, event?: WEvt): void => { try { event?.stopPropagation?.(); } catch { /* off-DOM */ } }) as Fn;

// winsheet.syncBundles — make a SEEDED tab relationship grant shared memory, the
// same way a runtime drop (wsDrop) does. A sheet minted private-get is a closure;
// when win.geom seeds seg.host = other (e.g. the boot tabs turtlecharts INTO
// turtles), the two are visually tabbed but still isolated until bundled. This
// scans win.geom and bundles every {host, tabs…} clique so a tabbed sheet can read
// its host's cels (turtlecharts reads turtles!). The host (boot/commit) calls it
// after the desktop genesis materializes; idempotent (re-bundling is harmless).
const wsSyncBundles: Fn = (async (state: State): Promise<void> => {
  const m = geomMap(state);
  const hosts = new Map<string, Set<string>>();
  for (const seg of Object.keys(m)) {
    const host = m[seg]?.host;
    if (typeof host === "string" && host !== seg) (hosts.get(host) ?? hosts.set(host, new Set([host])).get(host)!).add(seg);
  }
  let bundled = false;
  for (const members of hosts.values()) if (members.size > 1) { bundleSegments(state, [...members]); bundled = true; }
  // a tabbed sheet's formula captured the #DENIED sentinel at first eval (before
  // the bundle existed). precompute re-resolves each inputMap ref through the now-
  // open gate; the real cel has a different object identity than the deniedCel, so
  // the incremental check invalidates the formula → it re-fires (with the value)
  // on the caller's next runCycle. Without this the chart stays #DENIED.
  if (bundled) precompute(state);
}) as Fn;

// winsheet.newtab — the "+" on a worksheet window's tab strip. Genesis-creates a
// BLANK 10×10 sheet, mints it as its own private closure, and TABS it into the
// clicked window (win.geom[new].host = host + host.tab = new), then bundles the
// host clique so the new tab shares memory with its host (the turtles pattern).
// The sheet is owned by a stable generator cel (<seg>.maker) so its cells render
// (generatedBy-stamped) and persist; the maker itself stays off the grid.
const colA = (n: number): string => { let s = "", x = n + 1; while (x > 0) { s = String.fromCharCode(65 + (x - 1) % 26) + s; x = Math.floor((x - 1) / 26); } return s; };

// a fresh, unused sheet segment name with the given prefix (sheet1, sheet2, …).
const freshSeg = (state: State, prefix: string): string => {
  let n = 1; while (state.cels.get(`${prefix}${n}.maker`) || geomMap(state)[`${prefix}${n}`]) n++;
  return `${prefix}${n}`;
};

// materializeSheet — the shared "make a worksheet segment from a cels record"
// engine behind newtab/newsheet/openAsSheet. `cells` maps full cel keys
// (`<seg>.A1`) to CelSpecs ({celType, v|f, metadata}). It builds a maker cel
// holding the genesis request, feeds it to genesis.drain (which stamps each cell
// generatedBy=<maker>, mints the closure, materializes the grid), then asserts
// the closure policy. The maker stays off the grid. Caller positions the window
// + repaints. A blank N×N sheet is just blankCells(seg, n).
const blankCells = (seg: string, rows: number, cols: number): Record<string, unknown> => {
  const cells: Record<string, unknown> = {};
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const addr = `${colA(c)}${r + 1}`;
    cells[`${seg}.${addr}`] = { celType: "ValueCel", v: "", metadata: { segment: seg, name: addr, parser: "infix" } };
  }
  return cells;
};
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
  setAccessPolicy(state, seg, { get: ["origin"], set: "private" });
};

const wsNewtab: Fn = (async (state: State, host: unknown): Promise<void> => {
  const h = String(host ?? "");
  if (!h) return;
  const seg = freshSeg(state, "tab");
  await materializeSheet(state, seg, blankCells(seg, 10, 10));
  // tab the new sheet into the clicked host + bundle the clique (shared memory)
  const ult = (geomMap(state)[h]?.host as string | undefined) ?? h;
  const m = geomMap(state);
  m[seg] = { ...(m[seg] ?? {}), host: ult };
  m[ult] = { ...(m[ult] ?? {}), tab: seg, min: 0, closed: 0 };
  await setGeom(state, m);
  bundleSegments(state, [ult, ...Object.keys(m).filter((k) => m[k]?.host === ult)]);
  // rebuild the view's cell list so the new sheet's cells show, then repaint.
  if (state.cels.get("view.refresh")) await Promise.resolve((resolveFn(state, "view.refresh") as Fn)(state));
  await wrepaint(state);
}) as Fn;

// place a freshly-materialized sheet segment as a STANDALONE window (untabbed),
// staggered so it doesn't sit exactly under the host. Then refresh the view +
// repaint so its cells render.
const placeStandalone = async (state: State, seg: string): Promise<void> => {
  const m = geomMap(state);
  const i = Object.keys(m).length;
  m[seg] = { ...(m[seg] ?? {}), host: undefined, x: 60 + (i % 6) * 34, y: 60 + (i % 6) * 34, z: await nextZ(state), min: 0, closed: 0 };
  await setGeom(state, m);
  if (state.cels.get("view.refresh")) await Promise.resolve((resolveFn(state, "view.refresh") as Fn)(state));
  await wrepaint(state);
};

// winsheet.newsheet — the 🆕 titlebar button: a NEW standalone blank 10×10 sheet
// window (its own segment + closure), NOT tabbed into anything.
const wsNewsheet: Fn = (async (state: State): Promise<void> => {
  const seg = freshSeg(state, "sheet");
  await materializeSheet(state, seg, blankCells(seg, 10, 10));
  await placeStandalone(state, seg);
}) as Fn;

// ── format serialization: CSV / XLSX / .甲 (the shared saveSheet) ─────────────
// the grid cels of a worksheet segment as { addr → {v, f} }, plus the grid's
// extent. A grid cel is `<seg>.A1` (an A1-addressed Value/Formula cel).
const A1RE = /^([A-Z]+)(\d+)$/;
const colNum = (letters: string): number => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
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

// CSV — a cell's VALUE per row×col (A1 order); a formula serializes its evaluated
// VALUE (CSV is values-only). RFC-4180 quoting: wrap in quotes when the field
// holds a comma, quote, or newline; double interior quotes.
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
// a CSV's rows → a worksheet cels record: each non-empty field a value cel at its
// A1 address; numeric-looking fields become numbers (the grid's value model).
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

// .甲 (single-sheet plastron archive) — a zip carrying the RICH form: every grid
// cel's celType + value + formula + metadata, so formulas + types round-trip
// (unlike CSV/XLSX which are values-only). Reuses the zero-dep zip core from
// segment-archive. Layout: sheet.json = { format, cells: [{addr, celType, v, f}] }.
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

// saveSheet(seg, fmt) — serialize a worksheet segment to bytes + a string name.
// fmt ∈ {csv, xlsx, 甲}. Returns { bytes, filename, text? } so the host can write
// OPFS and/or offer a download. xlsx reuses the xlsx segment's exporter.
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

// openAsSheet(bytes, name) — detect the format by the name's extension, build a
// worksheet cels record, materialize it as a NEW standalone sheet window. csv →
// values grid; xlsx → fromXlsx; 甲 → the rich archive reader (cels + formulas).
// Returns the new segment name.
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

// ── browser file I/O for the titlebar save/open ──────────────────────────────
type DomFile = {
  document?: { createElement: (t: string) => { type?: string; accept?: string; href?: string; download?: string; files?: ArrayLike<{ name: string; arrayBuffer(): Promise<ArrayBuffer> }>; onchange?: () => void; click(): void } };
  URL?: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void };
  Blob?: new (parts: unknown[], opts?: unknown) => unknown;
};
const triggerDownload = (bytes: Uint8Array, filename: string): void => {
  const g = globalThis as DomFile;
  if (!g.document || !g.URL || !g.Blob) return;
  const a = g.document.createElement("a");
  a.href = g.URL.createObjectURL(new g.Blob([bytes], {}));
  a.download = filename; a.click();
  g.URL.revokeObjectURL(a.href!);
};

// winsheet.savefmt — the 💾 button toggles an inline format chooser on the
// window (win.geom[seg].savemenu); the 3 buttons dispatch winsheet.saveas.
const wsSavefmt: Fn = (async (state: State, seg: unknown): Promise<void> => {
  const s = String(seg ?? ""); if (!s) return;
  const m = geomMap(state); m[s] = { ...(m[s] ?? {}), savemenu: m[s]?.savemenu ? 0 : 1 }; await setGeom(state, m);
}) as Fn;
// winsheet.saveas — { seg, fmt }: serialize the segment, write it to OPFS
// (/<seg>.<ext>) AND offer a browser download, then close the chooser.
const wsSaveas: Fn = (async (state: State, payload: unknown): Promise<void> => {
  const p = payload as { seg?: string; fmt?: string } | undefined;
  const seg = String(p?.seg ?? ""), fmt = String(p?.fmt ?? "");
  if (!seg || !fmt) return;
  const out = await saveSheet(state, seg, fmt);
  // write to OPFS (best-effort: file-store may be absent off-DOM/in tests)
  const fsWrite = resolveFn(state, "fs.write") as Fn | undefined;
  const ensure = resolveFn(state, "ensureSegments") as Fn | undefined;
  if (fsWrite) { try { if (ensure) await ensure(state, ["file-store"]); await fsWrite(`/${out.filename}`, out.bytes); } catch { /* no fs here */ } }
  triggerDownload(out.bytes, out.filename);
  // refresh the explorer (if open) so the new file shows, and close the chooser.
  const m = geomMap(state); m[seg] = { ...(m[seg] ?? {}), savemenu: 0 }; await setGeom(state, m);
  const refresh = resolveFn(state, "origin.explorerRefresh") as Fn | undefined;
  if (refresh && state.cels.get("explorer.cwd")) await Promise.resolve(refresh(state));
  await wrepaint(state);
}) as Fn;
// winsheet.open — the 📁 button: pick a file from disk and openAsSheet it.
const wsOpen: Fn = ((state: State): void => {
  const g = globalThis as DomFile;
  if (!g.document) return;
  const input = g.document.createElement("input"); input.type = "file"; input.accept = ".csv,.xlsx,.甲";
  input.onchange = async (): Promise<void> => {
    const file = input.files?.[0]; if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await openAsSheet(state, bytes, file.name);
  };
  input.click();
}) as Fn;

export const name = "sheet-host" as const;

// direct surface for hosts (e.g. the explorer double-click) + tests, skipping
// cel dispatch — they already hold the bytes / want the new segment name back.
export { saveSheet, openAsSheet };

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sheetView", sheetView],
  ["winsheet.grab", wsGrab], ["winsheet.move", wsMove], ["winsheet.grabResize", wsGrabResize], ["winsheet.resizeMove", wsResizeMove],
  ["winsheet.drop", wsDrop], ["winsheet.tab", wsTab], ["winsheet.tearoff", wsTearoff], ["winsheet.raise", wsRaise], ["winsheet.minimize", wsMin], ["winsheet.close", wsClose], ["winsheet.restore", wsRestore], ["winsheet.maximize", wsMax], ["winsheet.mid", wsMid], ["winsheet.stop", wsStop],
  ["winsheet.tabGrab", wsTabGrab], ["winsheet.tabMove", wsTabMove], ["winsheet.tabDrop", wsTabDrop],
  ["winsheet.syncBundles", wsSyncBundles], ["winsheet.newtab", wsNewtab],
  ["winsheet.newsheet", wsNewsheet], ["winsheet.savefmt", wsSavefmt], ["winsheet.saveas", wsSaveas], ["winsheet.open", wsOpen],
]));
