// vnode builders — the canonical way to author plastron-dom render specs, so
// apps (origin, krausest, …) don't re-roll their own. `el`/`text` produce the
// shared VElement/VText; `memo` attaches the diff's memo hint (see diff.ts).

import type { AttrValue, EventBinding, VElement, VNode, VText } from "../../../../types/index.js";

export const text = (s: unknown): VText => ({ type: "text", text: String(s ?? "") });

export const el = (
  tag: string,
  attrs?: Record<string, AttrValue> | null,
  children?: VNode[],
  events?: Record<string, EventBinding>,
): VElement => ({
  type: "el",
  tag,
  ...(attrs ? { attrs } : {}),
  ...(children ? { children } : {}),
  ...(events ? { events } : {}),
});

/** Attach a memo hint so the diff skips this subtree when `sig` is unchanged
 *  (=== or shallow-array equal). Returns the SAME node (mutates) — vnodes are
 *  freshly built per render, so this is safe and avoids a copy. */
export const memo = (node: VElement, sig: unknown): VElement => { node.memo = sig; return node; };
