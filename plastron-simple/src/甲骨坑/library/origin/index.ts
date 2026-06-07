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
// Boot contract: createInitialState() + hydrate(state, [], []) leaves
// 元.view mounted at 元.mount ("#app") painting FREESPACE: the origin
// cel (its v IS the plain-text readme — owner-edited, no markdown) and
// every user cel created through the entry gesture, as clickable boxes.
//
// The freespace index is the VIEW'S OWN inputMap: origin.commit creates
// `c1, c2, …` (segment "freespace") and rewires 元.view's inputMap via
// a metadata-only setCel — the two-tier write design carrying the UI.
// Kernel/firmware cels are never listed, so the floor stays invisible
// (sparseness is a visibility rule, not a count).
//
// The view is DELIBERATELY minimal and unlocked — built to be edited
// and entirely reworked in place; it renders through plastron-dom like
// every other view (no bespoke paint path).
// ============================================================================

type V = { type: "el" | "text"; tag?: string; key?: string; attrs?: Record<string, unknown>; events?: Record<string, unknown>; children?: V[]; text?: string };
const T = (s: unknown): V => ({ type: "text", text: String(s ?? "") });
const el = (tag: string, attrs: Record<string, unknown>, children: V[], events?: Record<string, unknown>): V =>
  ({ type: "el", tag, attrs, children, ...(events ? { events } : {}) });

const short = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "object") {
    const o = v as { kind?: unknown; message?: unknown; defn?: unknown; genesis?: unknown; name?: unknown };
    if (o.kind === "error") return /undefined symbol|is not defined/.test(String(o.message)) ? "#NAME?" : "#ERR!";
    if (o.defn === true) return `f ${String(o.name ?? "")}`;
    if (o.genesis === true) return "(structure)";
    try { return JSON.stringify(v).slice(0, 60); } catch { return "#ERR!"; }
  }
  return String(v).slice(0, 60);
};

/** The freespace renderer — a plain RenderSpec producer (parser "f").
 *  (readme expanded draft mount idx vals banner) → render-spec. The
 *  optional `banner` is a vnode spliced ABOVE the cels — set by a
 *  generated `freespace.banner` cel (the `readme()` vocabulary), and
 *  gone the moment that cel is swept (genesis lifecycle → the div
 *  vanishes with its formula). */
const originView: Fn = (
  readme: unknown, expanded: unknown, draft: unknown, mount: unknown,
  idx: unknown, vals: unknown, banner: unknown,
) => {
  const keys = Array.isArray(idx) ? (idx as string[]) : [];
  const values = Array.isArray(vals) ? (vals as unknown[]) : [];
  const open = typeof expanded === "string" ? expanded : null;
  const bannerNode = banner && typeof banner === "object" && "type" in (banner as object)
    ? (banner as V) : null;

  const box = (key: string, body: V[], isOpen: boolean): V =>
    el("div", { class: isOpen ? "cel open" : "cel", "data-key": key }, body,
      { click: { dispatch: "origin.expand", payload: key } });

  const editor = (key: string): V =>
    el("input", { class: "entry", value: String(draft ?? ""), placeholder: "type a formula, press enter" }, [], {
      input: { set: "元.draft", extract: "value" },
      keydown: { dispatch: "origin.key", payload: key },
      click: { dispatch: "origin.noop" }, // keep box-click from re-toggling while typing
    });

  const boxes: V[] = [];
  const originOpen = open === "元";
  boxes.push(box("元", originOpen
    ? [el("pre", { class: "readme" }, [T(readme)]), editor("元")]
    : [el("span", { class: "k" }, [T("元")])], originOpen));

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const isOpen = open === key;
    boxes.push(box(key, isOpen
      ? [el("span", { class: "k" }, [T(key)]), el("pre", { class: "val" }, [T(short(values[i]))]), editor(key)]
      : [el("span", { class: "k" }, [T(key)]), el("span", { class: "v" }, [T(short(values[i]))])], isOpen));
  }

  const children = bannerNode ? [bannerNode, el("div", { class: "freespace" }, boxes)] : [el("div", { class: "freespace" }, boxes)];
  return {
    vnode: el("div", { class: "origin-root" }, children),
    mount: typeof mount === "string" ? mount : null,
    listeners: [],
  };
};

/** readme() — a GENESIS vocabulary that makes the readme a banner div
 *  above the freespace. It emits a `freespace.banner` FormulaCel whose
 *  value is a <div> vnode of 元's text; 元.view splices it on top.
 *  Delete the `=readme()` formula and the genesis sweep retires
 *  freespace.banner → the banner input goes undefined → the div
 *  disappears. (The whole point: the chrome is made of the same stuff
 *  it edits, and unmaking the formula unmakes the view.) */
const readmeFn: Fn = () => ({
  genesis: true,
  layer: "origin",
  cels: {
    "freespace.banner": {
      celType: "FormulaCel",
      f: "(readmeBanner readme)",
      fStructural: true,
      metadata: { parser: "f", inputMap: { readme: "元" } },
    },
  },
});

/** The banner vnode builder (referenced by the generated cel). */
const readmeBanner: Fn = (readme: unknown): V =>
  el("div", { class: "readme-banner" }, [el("pre", { class: "readme" }, [T(readme)])]);

// ── the entry gesture ────────────────────────────────────────────────────────

const sniff = (src: string): { celType: string; f?: string; v?: unknown; parser?: string } => {
  const t = src.trim();
  if (t.startsWith("=")) return { celType: "FormulaCel", f: t, parser: "infix" };
  if (t.startsWith("(")) return { celType: "FormulaCel", f: t, parser: "f" };
  const n = Number(t);
  return { celType: "ValueCel", v: t !== "" && !Number.isNaN(n) ? n : src };
};

const VIEW_KEY = "元.view";

const freespaceKeys = (state: State): string[] => {
  const idx = state.cels.get("freespace.index")?.v;
  return Array.isArray(idx) ? [...(idx as string[])] : [];
};

// Array INPUTS resolve to VALUES, so the key list itself travels as a
// value (freespace.index) while the same keys wire the vals array ref.
const rewireView = async (state: State, keys: string[]): Promise<void> => {
  const im = { ...(state.cels.get(VIEW_KEY)?.metadata.inputMap as Record<string, Key | Key[]>) };
  im.vals = keys;
  await (resolveFn(state, "setValue") as Fn)(state, "freespace.index", keys);
  await (resolveFn(state, "setCel") as Fn)(state, VIEW_KEY, { metadata: { inputMap: im } });
};

// Commit STRUCTURE first (genesis/defn/checkpoint/effects), THEN run a
// cycle so views render against the settled graph, THEN paint. A
// structure drain calls precompute (which rebuilds channels), so any
// paint enqueued before it would be lost — draining paint LAST, after a
// fresh cycle, sidesteps that without globally preserving channel
// queues (which replays stale specs and drops listeners).
const drainAll = async (state: State, keys: string[]): Promise<void> => {
  const drain = resolveFn(state, "drain") as Fn;
  for (const ch of ["genesis.commit", "defn.commit", "checkpoint.commit", "origin.effects"]) {
    if (state.cels.get(ch)) await drain(state, ch);
  }
  const g = resolveFn(state, "genesis.drain") as Fn | undefined;
  if (g) await g([], state);          // sweep even when nothing enqueued
  const d = resolveFn(state, "defn.drain") as Fn | undefined;
  if (d) await d([], state);
  // Rewire the freespace view NOW (a fresh keys array re-fires 元.view
  // into the post-rebuild paint channel), cycle, then paint.
  await rewireView(state, keys);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await drain(state, "plastron-dom.paint");
};

/** commit the draft: on 元 → NEW freespace cel (c1, c2, …); on an open
 *  user cel → edit that cel in place. Empty draft on a user cel DELETES
 *  it (the freespace way to unmake a formula — and its bloom). */
const commit: Fn = async (state: State, payload?: unknown) => {
  const target = typeof payload === "string" ? payload : "元";
  const draft = String(state.cels.get("元.draft")?.v ?? "").trim();
  const setCel = resolveFn(state, "setCel") as Fn;
  const setValue = resolveFn(state, "setValue") as Fn;
  let keys = freespaceKeys(state);

  if (target !== "元" && draft === "") {
    // delete the cel; its bloom is swept by the empty-batch drains
    const cel = state.cels.get(target);
    if (cel && !cel.locked) {
      state.cels.delete(target);
      keys = keys.filter((k) => k !== target);
    }
  } else if (draft !== "") {
    const spec = sniff(draft);
    const key = target === "元"
      ? `c${(Number(state.cels.get("freespace.n")?.v) || 0) + 1}`
      : target;
    if (target === "元") {
      await setValue(state, "freespace.n", (Number(state.cels.get("freespace.n")?.v) || 0) + 1);
      keys.push(key);
    }
    const md: Record<string, unknown> = { segment: "freespace" };
    if (spec.parser) md.parser = spec.parser;
    await setCel(state, key, { celType: spec.celType, f: spec.f, v: spec.v, metadata: md });
  }

  await setValue(state, "元.draft", "");
  // Fire generators so they enqueue their structure requests…
  await (resolveFn(state, "runCycle") as Fn)(state);
  // …commit the structure (genesis/defn/checkpoint), settle, THEN
  // rewire the view AFTER the structure drains' precomputes — so the
  // view's paint enqueue lands in the live (post-rebuild) channel.
  await drainAll(state, keys);
  return state;
};

const expand: Fn = async (state: State, payload?: unknown) => {
  const key = typeof payload === "string" ? payload : null;
  const cur = state.cels.get("元.expanded")?.v;
  const next = cur === key ? null : key;
  // seed the draft with the cel's editable source
  let draft = "";
  if (next && next !== "元") {
    const c = state.cels.get(next);
    if (c) draft = (c as { f?: string }).f ?? (c.v === undefined || c.v === null ? "" : String(c.v));
  }
  await (resolveFn(state, "setValueBatch") as Fn)(state, [["元.expanded", next], ["元.draft", draft]]);
  await (resolveFn(state, "drain") as Fn)(state, "plastron-dom.paint");
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

const noop: Fn = () => undefined;

export const name = "origin" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["originView",     originView],
  ["origin.commit",  commit],
  ["origin.expand",  expand],
  ["origin.key",     key],
  ["origin.noop",    noop],
  ["readme",         readmeFn],
  ["readmeBanner",   readmeBanner],
  ["origin.drain",   effectsDrain],
  ["load",           loadFn],
  ["cels",           celsFn],
]));
