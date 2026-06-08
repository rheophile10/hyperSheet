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
    const o = v as { kind?: unknown; message?: unknown; genesis?: unknown; defn?: unknown; name?: unknown };
    if (o.kind === "error") return T(/undefined symbol|not a function/.test(String(o.message)) ? "#NAME?" : "#ERR!");
    if (o.genesis === true) return T("ƒ grid");
    if (o.defn === true) return T(`ƒ ${String(o.name ?? "")}`);
    try { return T(JSON.stringify(v).slice(0, 60)); } catch { return T("#ERR!"); }
  }
  return T(String(v));
};

/** The spreadsheet renderer (parser "f"): (editing draft mount keys vals)
 *  → render-spec. Every cel in `keys` is an editable spreadsheet cell —
 *  it shows its evaluated value; click its label to edit the source;
 *  Enter re-evaluates. 元 is just the first cell (A1); grid() adds more.
 *  The ONLY thing past an ordinary spreadsheet: a cell's formula may
 *  evaluate to a dom object / make cels / make worksheets, and that
 *  renders right in the cell. */
const originView: Fn = (
  editing: unknown, draft: unknown, mount: unknown, keys: unknown, vals: unknown,
) => {
  const ks = Array.isArray(keys) ? (keys as string[]) : ["元"];
  const vs = Array.isArray(vals) ? (vals as unknown[]) : [];
  const active = typeof editing === "string" ? editing : null;

  const cell = (key: string, value: unknown): V => {
    const isOn = active === key;
    const label = key === "元" ? "A1" : key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
    const head = el("div", { class: "cell-label" }, [T(label)], { click: { dispatch: "origin.edit", payload: key } });
    const body = isOn
      ? el("input", { class: "cell-input", value: String(draft ?? "") }, [], {
          input: { set: "元.draft", extract: "value" },
          keydown: { dispatch: "origin.key", payload: key }, // origin.key commits only on Enter
        })
      : el("div", { class: "cell-value" }, [displayCell(value)]);
    return el("div", { class: isOn ? "cell editing" : "cell", "data-key": key }, [head, body]);
  };

  const cells = ks.map((k, i) => cell(k, vs[i]));
  return {
    vnode: el("div", { class: "sheet" }, cells),
    mount: typeof mount === "string" ? mount : null,
    listeners: [],
  };
};

/** grid(rows, cols [, name]) — a genesis vocabulary that adds rows×cols
 *  editable cels, each identical to 元. `=grid(3,3)` in any cell makes a
 *  3×3 worksheet; the cels are real (name.A1 … data ValueCels), each a
 *  spreadsheet cell you type formulas/values into. Delete the formula
 *  and the genesis sweep removes them. */
const grid: Fn = (rows: unknown, cols: unknown, nameArg?: unknown): unknown => {
  const r = Math.max(1, Math.min(50, Math.floor(Number(rows) || 1)));
  const c = Math.max(1, Math.min(26, Math.floor(Number(cols) || 1)));
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

/** edit — start editing a cell: seed the draft with its source, mark it
 *  active. Clicking the label of the active cell again closes it. */
const edit: Fn = async (state: State, payload?: unknown) => {
  const key = typeof payload === "string" ? payload : null;
  const cur = state.cels.get("元.editing")?.v;
  const next = cur === key ? null : key;
  let draft = "";
  if (next) {
    const c = state.cels.get(next);
    const f = (c as { f?: string } | undefined)?.f;
    draft = f ?? (c?.v === undefined || c?.v === null ? "" : String(c.v));
  }
  await (resolveFn(state, "setValueBatch") as Fn)(state, [["元.editing", next], ["元.draft", draft]]);
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

  await (resolveFn(state, "setValueBatch") as Fn)(state, [["元.editing", null], ["元.draft", ""]]);
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

const loadFn: Fn = (name: unknown) => ({ originLoad: true, name: String(name ?? "") });
const celsFn: Fn = (name: unknown) => ({ originCels: true, segment: String(name ?? "") });

const effectsDrain: Fn = async (items: ChannelEnqueue[], stateArg?: unknown): Promise<void> => {
  const state = (stateArg ?? items[0]?.state) as State | undefined;
  if (!state) return;
  const setCel = resolveFn(state, "setCel") as Fn;
  for (const { cel } of items) {
    const req = cel.v as { originLoad?: boolean; originCels?: boolean; name?: string; segment?: string } | undefined;
    if (!req || typeof req !== "object") continue;
    // load/cels are ACTIONS: the result is plain text. Replace the
    // requesting FORMULA cel with a ValueCel holding the result —
    // otherwise the next runCycle re-evaluates the formula and clobbers
    // the result with the request object again. (defn/genesis differ:
    // their generator's value STAYS the request; they create OTHER cels.)
    let result: unknown;
    try {
      if (req.originLoad && req.name) {
        await ensureSegments(state, [req.name]);
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
  ["origin.commit",  commit],
  ["origin.edit",    edit],
  ["origin.key",     key],
  ["grid",           grid],
  ["origin.drain",   effectsDrain],
  ["load",           loadFn],
  ["cels",           celsFn],
]));
