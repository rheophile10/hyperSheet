import type { Fn, EventBinding } from "../../../../types/index.js";
import { text as T } from "./build.js";

// ============================================================================
// dom / style / attr / on — the vnode-authoring VOCABULARY, as formula verbs.
// Moved here from origin (application) per the tier-boundary doctrine: building
// a vnode is a reusable capability, not an app-specific choice. Now ANY segment
// that depends on `dom` can author UI as a (dom …) formula — including library
// capabilities like unsafe-wallet. Output shape is preserved exactly (the
// painter reads a top-level `style` object and an `events` bag).
// ============================================================================

type V = { type: "el" | "text"; tag?: string; text?: string; attrs?: Record<string, unknown>; style?: unknown; events?: Record<string, unknown>; children?: V[] };

const isVnode = (v: unknown): v is V =>
  !!v && typeof v === "object" && ((v as V).type === "el" || (v as V).type === "text");
const isStyle = (c: unknown): c is { __style: Record<string, unknown> } =>
  !!c && typeof c === "object" && typeof (c as { __style?: unknown }).__style === "object";
const isAttr = (c: unknown): c is { __attr: Record<string, unknown> } =>
  !!c && typeof c === "object" && typeof (c as { __attr?: unknown }).__attr === "object";
const isOn = (c: unknown): c is { __on: { event: string; binding: EventBinding } } =>
  !!c && typeof c === "object" && typeof (c as { __on?: unknown }).__on === "object";

/** dom(tag, ...children) — a presentation vnode VALUE. `tag` accepts an
 *  emmet-ish class ("div.readme" → <div class="readme">). Children: strings →
 *  text, nested dom(...) → elements, (style …)/(attr …)/(on …) → that element's
 *  inline style / attributes / event bindings. */
export const dom: Fn = (tag: unknown, ...children: unknown[]): V => {
  const spec = String(tag ?? "div");
  const dot = spec.indexOf(".");
  const name = dot === -1 ? spec : spec.slice(0, dot);
  const cls = dot === -1 ? undefined : spec.slice(dot + 1).replace(/\./g, " ");
  let style: Record<string, unknown> | undefined;
  const attrs: Record<string, unknown> = cls ? { class: cls } : {};
  const events: Record<string, unknown> = {};
  const kids: V[] = [];
  for (const c of children) {
    if (isStyle(c)) { style = { ...style, ...c.__style }; continue; }
    if (isAttr(c)) { Object.assign(attrs, c.__attr); continue; }
    if (isOn(c)) { events[c.__on.event] = c.__on.binding; continue; }
    kids.push(isVnode(c) ? c : T(c) as V);
  }
  return {
    type: "el", tag: name || "div",
    ...(Object.keys(attrs).length ? { attrs } : {}),
    ...(style ? { style } : {}),
    ...(Object.keys(events).length ? { events } : {}),
    children: kids,
  };
};

/** style(prop, value, …) — inline styles. Pass as a child of dom():
 *  (dom "h1" (style "color" "tomato") "hi"). */
export const style: Fn = (...pairs: unknown[]): { __style: Record<string, unknown> } => {
  const s: Record<string, unknown> = {};
  for (let i = 0; i + 1 < pairs.length; i += 2) s[String(pairs[i])] = pairs[i + 1];
  return { __style: s };
};

/** attr(name, value, …) — HTML attributes (href, target, type, id, …). Pass as
 *  a child of dom(): (dom "a" (attr "href" "https://…") "link"). */
export const attr: Fn = (...pairs: unknown[]): { __attr: Record<string, unknown> } => {
  const a: Record<string, unknown> = {};
  for (let i = 0; i + 1 < pairs.length; i += 2) a[String(pairs[i])] = pairs[i + 1];
  return { __attr: a };
};

/** on(event, handlerKey [, payload]) — bind a dom event to a handler cel. Pass
 *  as a child of dom(): (dom "button" (on "click" "wallet.lock") "lock"). The
 *  handler runs (state, payload, event). This is what makes interactive UI —
 *  buttons, inputs — authorable as a formula. */
/** img(src… [, style()/attr()/on() children]) — an image element. String
 *  args form a src FALLBACK CHAIN (first non-empty wins). A "/path" src is
 *  an OPFS REFERENCE: the painter hydrates it to an objectURL via
 *  file-store after each paint (the canvas data-ops replay pattern), so a
 *  formula can point at any file in the page's filesystem —
 *  (img desktop.A2 windows.wallpaper …). data:/http(s)/blob srcs pass
 *  straight through. */
export const img: Fn = (...args: unknown[]): V => {
  const srcs = args.filter((a): a is string => typeof a === "string");
  const rest = args.filter((a) => typeof a !== "string");
  const src = srcs.find((x) => x.trim() !== "") ?? "";
  const pair = src.startsWith("/") ? attr("data-opfs-src", src) : attr("src", src);
  return dom("img", pair, ...rest) as V;
};

// ── layout — arrange children into a responsive container ────────────────────
// layout([mode|opts,] ...children) → a container vnode that flows its children
// into a configuration. The default is MASONRY (Pinterest-style column packing).
// Children may be vnodes (dom(…)/charts/img/nested layout(…)), ranges/arrays
// (flattened), or scalars (boxed as text tiles). Each child is wrapped in a
// .pl-layout-cell so column/grid packing has a stable break unit.
//
// Mobile-responsive with NO media queries: `columns: <min>px` and
// `repeat(auto-fill, minmax(<min>px, 1fr))` are INTRINSICALLY fluid — "as many
// columns as fit at ≥min px," so a phone collapses to one column and a wide
// desktop fans out, all from the viewport width. Pure inline style, no sheet.
type LayoutMode = "masonry" | "grid" | "rows" | "columns" | "stack";
const LAYOUT_MODES = new Set<string>(["masonry", "grid", "rows", "columns", "stack"]);
const styleOf = (o: Record<string, string>): { __style: Record<string, unknown> } => ({ __style: o });

const containerStyle = (mode: LayoutMode, min: number, gap: number): Record<string, string> => {
  switch (mode) {
    case "grid":    return { display: "grid", "grid-template-columns": `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: `${gap}px`, "align-items": "start" };
    case "rows":    return { display: "flex", "flex-direction": "column", gap: `${gap}px` };
    case "columns": return { display: "flex", "flex-direction": "row", "flex-wrap": "wrap", gap: `${gap}px`, "align-items": "flex-start" };
    case "stack":   return { position: "relative", "min-height": "8rem" };
    case "masonry":
    default:        return { columns: `${min}px`, "column-gap": `${gap}px` };
  }
};
const cellStyle = (mode: LayoutMode, min: number, gap: number): Record<string, string> => {
  switch (mode) {
    case "masonry": return { "break-inside": "avoid", "-webkit-column-break-inside": "avoid", "margin-bottom": `${gap}px`, display: "block" };
    case "columns": return { flex: `1 1 ${min}px`, "min-width": `${min}px` };
    case "stack":   return { position: "absolute", top: "0", left: "0" };
    default:        return {}; // grid/rows: the item flows natively
  }
};

export const layout: Fn = (...args: unknown[]): V => {
  const rest = [...args];
  let mode: LayoutMode = "masonry";
  let min = 280, gap = 12;
  // first arg may be a mode string, or an options map { mode, min, gap }
  if (typeof rest[0] === "string" && LAYOUT_MODES.has(rest[0])) { mode = rest.shift() as LayoutMode; }
  else if (rest[0] && typeof rest[0] === "object" && !isVnode(rest[0]) && !isStyle(rest[0]) && !isAttr(rest[0]) && !isOn(rest[0]) && !Array.isArray(rest[0])) {
    const o = rest.shift() as { mode?: unknown; min?: unknown; gap?: unknown };
    if (typeof o.mode === "string" && LAYOUT_MODES.has(o.mode)) mode = o.mode as LayoutMode;
    if (Number.isFinite(Number(o.min))) min = Number(o.min);
    if (Number.isFinite(Number(o.gap))) gap = Number(o.gap);
  }
  const cs = cellStyle(mode, min, gap);
  const tiles: V[] = [];
  for (const c of rest) {
    if (isStyle(c) || isAttr(c) || isOn(c)) continue; // container styling/handlers stay on the container call site
    for (const item of (Array.isArray(c) ? (c as unknown[]).flat(8) : [c])) {
      if (item === null || item === undefined || item === "") continue;
      const node = isVnode(item) ? item : (T(String(item)) as V);
      tiles.push(dom("div.pl-layout-cell", styleOf(cs), node) as V);
    }
  }
  return dom(`div.pl-layout.pl-layout-${mode}`, styleOf(containerStyle(mode, min, gap)), ...tiles) as V;
};

export const on: Fn = (event: unknown, handler: unknown, payload?: unknown): { __on: { event: string; binding: EventBinding } } => {
  const binding = (payload === undefined
    ? { dispatch: String(handler ?? "") }
    : { dispatch: String(handler ?? ""), payload }) as unknown as EventBinding;
  return { __on: { event: String(event ?? ""), binding } };
};
