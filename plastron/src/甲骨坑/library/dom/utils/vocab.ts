import type { Fn, EventBinding } from "../../../../types/index.js";
import { text as T } from "./build.js";

// ============================================================================
// dom / style / attr / on — the vnode-authoring VOCABULARY, as formula verbs.
// Moved here from origin (application) per the tier-boundary doctrine: building
// a vnode is a reusable capability, not an app-specific choice. Now ANY segment
// that depends on `dom` can author UI as a (dom …) formula — including library
// capabilities like vault. Output shape is preserved exactly (the
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
 *  inline style / attributes / event bindings. An ARRAY child is flattened in
 *  place, so a collection built with MAP/FILTER renders as sibling children:
 *  (dom "div" (MAP tasks!A1:A6 (LAMBDA t (dom "div.card" t)))). null/""/false
 *  items are dropped (so MAP+IF can omit a child by yielding ""). */
export const dom: Fn = (tag: unknown, ...children: unknown[]): V => {
  const spec = String(tag ?? "div");
  const dot = spec.indexOf(".");
  const name = dot === -1 ? spec : spec.slice(0, dot);
  const cls = dot === -1 ? undefined : spec.slice(dot + 1).replace(/\./g, " ");
  let style: Record<string, unknown> | undefined;
  const attrs: Record<string, unknown> = cls ? { class: cls } : {};
  const events: Record<string, unknown> = {};
  const kids: V[] = [];
  const pushChild = (c: unknown): void => {
    if (isStyle(c)) { style = { ...style, ...c.__style }; return; }
    if (isAttr(c)) { Object.assign(attrs, c.__attr); return; }
    if (isOn(c)) { events[c.__on.event] = c.__on.binding; return; }
    if (c === null || c === undefined || c === "" || c === false) return; // omitted child
    kids.push(isVnode(c) ? c : T(c) as V);
  };
  for (const c of children) {
    if (Array.isArray(c)) { for (const item of c.flat(8)) pushChild(item); continue; }
    pushChild(c);
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
  return { __style: pairsOrObject(pairs) };
};

/** attr(name, value, …) — HTML attributes (href, target, type, id, …). Pass as
 *  a child of dom(): (dom "a" (attr "href" "https://…") "link"). */
export const attr: Fn = (...pairs: unknown[]): { __attr: Record<string, unknown> } => {
  return { __attr: pairsOrObject(pairs) };
};

// style/attr accept EITHER flat pairs ("color","tomato") OR an object value
// ({color:"tomato"} — from an infix object literal or a cel) — or a mix. Object
// args splat their entries; the rest are read as positional pairs.
const pairsOrObject = (args: unknown[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  const scalars: unknown[] = [];
  for (const a of args) {
    if (a && typeof a === "object" && !Array.isArray(a)) Object.assign(out, a);
    else scalars.push(a);
  }
  for (let i = 0; i + 1 < scalars.length; i += 2) out[String(scalars[i])] = scalars[i + 1];
  return out;
};

/** on(event, handlerKey [, payload]) — bind a dom event to a handler cel. Pass
 *  as a child of dom(): (dom "button" (on "click" "vault.lock") "lock"). The
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

export const on: Fn = (event: unknown, handler: unknown, payload?: unknown): { __on: { event: string; binding: EventBinding } } => {
  const binding = (payload === undefined
    ? { dispatch: String(handler ?? "") }
    : { dispatch: String(handler ?? ""), payload }) as unknown as EventBinding;
  return { __on: { event: String(event ?? ""), binding } };
};
