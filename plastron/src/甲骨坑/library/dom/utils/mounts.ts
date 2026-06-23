// mounts — the placement registry behind `mount(target, content)`.
//
// `mount` returns the SELECTOR STRING of the element it placed (a human-
// readable handle), not the placement object — so another cel can target it:
// `B := mount(A1, …)` mounts INSIDE whatever A1 placed. The vnode itself can't
// ride on a bare-string cel value, so it lives here, keyed by that selector;
// sheetView looks placements up by the cel's string value (read-filtered by
// the CURRENT values, so a stale entry never paints — foreign/old keys are
// simply never looked up).
//
// The handle is the content root's explicit id (`#id`) when present, else an
// auto class `.m-<hash>` keyed by (target+content) — stable across re-evals of
// the same mount, so a downstream reference stays valid; an edit yields a new
// handle and the graph propagates it.

interface V {
  type: "el" | "text"; tag?: string; text?: string;
  attrs?: Record<string, unknown>; style?: unknown;
  events?: Record<string, unknown>; children?: V[];
}

export interface Placement { target: string; vnode: V }

const MOUNTS = new Map<string, Placement>();

const isVnode = (v: unknown): v is V =>
  !!v && typeof v === "object" && ((v as V).type === "el" || (v as V).type === "text");

const hash = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

// A stable-ish signature of a vnode for the auto-handle (tag + class + shallow
// text), enough to distinguish distinct mounts without hashing live handlers.
const sig = (n: V): string => {
  const cls = typeof n.attrs?.class === "string" ? n.attrs.class : "";
  const txt = n.type === "text" ? (n.text ?? "") : (n.children ?? []).map((c) => c.text ?? c.tag ?? "").join(",");
  return `${n.tag ?? n.type}|${cls}|${txt}`;
};

/** Place `content` under `target`; register and return the handle selector of
 *  the placed element (#id if it has one, else an injected .m-<hash> class). */
export const registerMount = (target: string, content: unknown): string => {
  // ensure an addressable ELEMENT (wrap bare text so it can carry the handle).
  const node: V = isVnode(content) && content.type === "el"
    ? content
    : { type: "el", tag: "div", children: [isVnode(content) ? content : { type: "text", text: String(content ?? "") }] };

  const explicitId = typeof node.attrs?.id === "string" ? node.attrs.id : undefined;
  if (explicitId) {
    const sel = `#${explicitId}`;
    MOUNTS.set(sel, { target, vnode: node });
    return sel;
  }

  const id = `m-${hash(`${target}|${sig(node)}`)}`;
  node.attrs = node.attrs ?? {};
  const cls = typeof node.attrs.class === "string" ? node.attrs.class : "";
  if (!cls.split(/\s+/).includes(id)) node.attrs.class = cls ? `${cls} ${id}` : id;
  const sel = `.${id}`;
  MOUNTS.set(sel, { target, vnode: node });
  return sel;
};

/** The placement a cel's string value refers to (or undefined). */
export const lookupMount = (sel: unknown): Placement | undefined =>
  typeof sel === "string" ? MOUNTS.get(sel) : undefined;

/** True when a value is a live mount handle (so the host renders the cell clean). */
export const isMountSel = (v: unknown): v is string =>
  typeof v === "string" && MOUNTS.has(v);
