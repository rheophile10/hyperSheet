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
export const on: Fn = (event: unknown, handler: unknown, payload?: unknown): { __on: { event: string; binding: EventBinding } } => {
  const binding = (payload === undefined
    ? { dispatch: String(handler ?? "") }
    : { dispatch: String(handler ?? ""), payload }) as unknown as EventBinding;
  return { __on: { event: String(event ?? ""), binding } };
};
