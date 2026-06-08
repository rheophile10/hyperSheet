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
const dom: Fn = (tag: unknown, ...children: unknown[]): V => {
  const spec = String(tag ?? "div");
  const dot = spec.indexOf(".");
  const name = dot === -1 ? spec : spec.slice(0, dot);
  const cls = dot === -1 ? undefined : spec.slice(dot + 1).replace(/\./g, " ");
  const kids: V[] = children.map((c) => (isVnode(c) ? c : T(c)));
  const attrs = cls ? { class: cls } : undefined;
  return { type: "el", tag: name || "div", ...(attrs ? { attrs } : {}), children: kids };
};

/** How a cell's VALUE shows when not being edited: a dom vnode renders
 *  live; a number/string shows as text; a structure request (genesis /
 *  defn) shows a ƒ marker (it made cels/functions elsewhere); errors
 *  show Excel-style. Empty shows nothing. */
const displayCell = (v: unknown): V => {
  if (isVnode(v)) return v as V;
  if (v === null || v === undefined || v === "") return T("");
  if (typeof v === "object") {
    const o = v as { kind?: unknown; message?: unknown; genesis?: unknown; defn?: unknown; name?: unknown; __at?: unknown };
    if (o.kind === "error") return T(/undefined symbol|not a function/.test(String(o.message)) ? "#NAME?" : "#ERR!");
    if (o.genesis === true) return T("ƒ grid");
    if (o.defn === true) return T(`ƒ ${String(o.name ?? "")}`);
    if (typeof o.__at === "string") return T(`→ ${o.__at}`); // mounted to a region; renders there, not here
    try { return T(JSON.stringify(v).slice(0, 60)); } catch { return T("#ERR!"); }
  }
  return T(String(v));
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
  editing: unknown, expanded: unknown, draft: unknown, mount: unknown, keys: unknown, vals: unknown,
) => {
  const ks = Array.isArray(keys) ? (keys as string[]) : ["元"];
  const vs = Array.isArray(vals) ? (vals as unknown[]) : [];
  const active = typeof editing === "string" ? editing : null;
  const open = typeof expanded === "string" ? expanded : null;
  const valOf = new Map<string, unknown>(); ks.forEach((k, i) => valOf.set(k, vs[i]));

  const editor = (key: string, big: boolean): V =>
    el(big ? "textarea" : "input", { class: big ? "cell-edit big" : "cell-edit", value: String(draft ?? "") }, [], {
      input: { set: "元.draft", extract: "value" },
      keydown: { dispatch: "origin.key", payload: key }, // origin.key commits on Enter
    });
  const expandBtn = (key: string): V =>
    el("button", { class: "cell-expand", title: "expand formula" }, [T("⤢")],
      { click: { dispatch: "origin.expand", payload: key } });

  // the inner of a cell: inline editor when active, else the value + ⤢
  const body = (key: string, value: unknown): V =>
    active === key
      ? editor(key, false)
      : el("div", { class: "cell-value" }, [displayCell(value), expandBtn(key)]);

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

  // expanded editor panel (full formula for one cell)
  if (open) {
    const label = open === "元" ? "元" : open.includes(".") ? open.slice(open.indexOf(".") + 1) : open;
    sections.push(el("div", { class: "expand-panel" }, [
      el("div", { class: "expand-head" }, [T(label), el("button", { class: "expand-close", title: "close" }, [T("×")], { click: { dispatch: "origin.expand", payload: open } })]),
      editor(open, true),
      el("div", { class: "expand-value" }, [displayCell(valOf.get(open))]),
    ]));
  }

  // PLACED dom — a cell whose value is mount(region, content). The dom
  // renders in that REGION (the origin lays it out around the sheet),
  // not in its cell; delete the formula and it's gone. Region "bottom"
  // renders below the sheet, anything else above (in name order).
  const placed = new Map<string, V[]>();
  for (const k of ks) {
    const v = valOf.get(k) as { __at?: unknown; vnode?: unknown } | undefined;
    if (v && typeof v === "object" && typeof v.__at === "string" && isVnode(v.vnode)) {
      const r = v.__at; (placed.get(r) ?? placed.set(r, []).get(r))!.push(v.vnode as V);
    }
  }
  const region = (name: string): V => el("div", { class: `region region-${name}` }, placed.get(name)!);
  const above = [...placed.keys()].filter((r) => r !== "bottom").sort().map(region);
  const below = placed.has("bottom") ? [region("bottom")] : [];

  return {
    vnode: el("div", { class: "origin" }, [...above, el("div", { class: "sheet" }, sections), ...below]),
    mount: typeof mount === "string" ? mount : null,
    listeners: [],
  };
};

/** mount(region, content) — PLACE a dom object in a named region the
 *  origin lays out around the sheet (e.g. "top", "bottom"), instead of
 *  inside the cell that holds the formula. Composes cleanly (the origin
 *  view owns #app and renders the region), and vanishes when the
 *  formula is deleted — no painter-target conflict. */
const mount: Fn = (region: unknown, content: unknown): unknown =>
  ({ __at: String(region ?? "top"), vnode: isVnode(content) ? content : T(content) });

/** grid(rows, cols [, name]) — a genesis vocabulary that adds rows×cols
 *  editable cels, each identical to 元. `=grid(3,3)` in any cell makes a
 *  3×3 worksheet; the cels are real (name.A1 … data ValueCels), each a
 *  spreadsheet cell you type formulas/values into. Delete the formula
 *  and the genesis sweep removes them. */
const grid: Fn = (rows: unknown, cols: unknown, nameArg?: unknown): unknown => {
  const r = Math.max(1, Math.min(100, Math.floor(Number(rows) || 1))); // capped — true million-scale needs virtualization (excel-scale roadmap)
  const c = Math.max(1, Math.min(50, Math.floor(Number(cols) || 1)));
  const name = typeof nameArg === "string" && nameArg !== "" ? nameArg : "g";
  const cels: Record<string, unknown> = {};
  for (let row = 0; row < r; row++) {
    for (let col = 0; col < c; col++) {
      const addr = `${String.fromCharCode(65 + col)}${row + 1}`;
      cels[`${name}.${addr}`] = { celType: "ValueCel", v: "", metadata: { name: addr, parser: "infix" } };
    }
  }
  return { genesis: true, layer: name, cels };
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
const README = '(dom "div.readme" (dom "h2" "the origin") '
  + '(dom "p" "this is cell A1. put a formula or value here and it shows the result.") '
  + '(dom "p" "  =1+1            shows 2") '
  + '(dom "p" "  =grid(3, 3)     makes a 3x3 worksheet of cels like this one") '
  + '(dom "p" "  =dom(\\"h2\\" \\"hi\\")  makes a heading") '
  + '(dom "p" "click a cell\'s label to edit it; clear A1 to bring this back."))';

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
 *  clicking the active cell's label again closes it. Closes any
 *  expanded panel. */
const edit: Fn = async (state: State, payload?: unknown) => {
  const key = typeof payload === "string" ? payload : null;
  const cur = state.cels.get("元.editing")?.v;
  const next = cur === key ? null : key;
  await (resolveFn(state, "setValueBatch") as Fn)(state,
    [["元.editing", next], ["元.expanded", null], ["元.draft", next ? cellSource(state, next) : ""]]);
  await (resolveFn(state, "drain") as Fn)(state, "plastron-dom.paint");
  return state;
};

/** expand — open the expanded editor PANEL for a cell (the full formula
 *  in a textarea + its value). Toggles; shares the draft + commit with
 *  inline editing. */
const expand: Fn = async (state: State, payload?: unknown) => {
  const key = typeof payload === "string" ? payload : null;
  const cur = state.cels.get("元.expanded")?.v;
  const next = cur === key ? null : key;
  await (resolveFn(state, "setValueBatch") as Fn)(state,
    [["元.expanded", next], ["元.editing", null], ["元.draft", next ? cellSource(state, next) : ""]]);
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
  await setCel(state, key, { celType: spec.celType, f: spec.f, v: spec.v, metadata: md });

  await (resolveFn(state, "setValueBatch") as Fn)(state, [["元.editing", null], ["元.expanded", null], ["元.draft", ""]]);
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
        const c = state.cels.get(String(req.key));
        result = c
          ? JSON.stringify({ key: c.metadata.key, celType: c.celType, locked: c.locked ?? false,
              v: c.v, f: (c as { f?: string }).f, metadata: c.metadata }, null, 2)
          : `(no cel named "${req.key}")`;
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
      } else continue;
      await setCel(state, cel.metadata.key, {
        celType: "ValueCel", v: result, metadata: { segment: cel.metadata.segment },
      });
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
  ["mount",          mount],
  ["origin.commit",  commit],
  ["origin.edit",    edit],
  ["origin.expand",  expand],
  ["origin.key",     key],
  ["grid",           grid],
  ["origin.drain",   effectsDrain],
  ["load",           loadFn],
  ["cels",           celsFn],
  ["inspect",        inspectFn],
  ["segments",       segmentsFn],
  ["vocab",          vocabFn],
]));
