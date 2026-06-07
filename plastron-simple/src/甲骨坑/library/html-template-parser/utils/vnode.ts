import type {
  AttrValue, EventBinding, RenderSpec, VElement, VNode, VText,
} from "../../../../types/index.js";

// Comparators + builders for the platform VNode types (types/vnode.ts).
// This segment OWNS the comparison semantics; siblings reach them via
// the cels vnode.equals / vnode.bindings-equal, never by import.

// Re-export the platform types so segment-internal modules keep one
// import site.
export type { AttrValue, EventBinding, RenderSpec, VElement, VNode, VText };

// ── builders ────────────────────────────────────────────────────────────────

export const text = (s: string | number | boolean): VText => ({
  type: "text",
  text: String(s),
});

// ── structural equality ───────────────────────────────────────────────────

const recordEqual = (
  a: Record<string, AttrValue> | undefined,
  b: Record<string, AttrValue> | undefined,
): boolean => {
  const ak = a ? Object.keys(a) : [];
  const bk = b ? Object.keys(b) : [];
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a![k] !== b?.[k]) return false;
  return true;
};

export const bindingsEqual = (a: EventBinding, b: EventBinding): boolean =>
  a.f === b.f
  && a.set === b.set
  && Object.is(a.value, b.value)
  && a.extract === b.extract
  && a.dispatch === b.dispatch
  && Object.is(a.payload, b.payload);

const eventsEqual = (
  a: Record<string, EventBinding> | undefined,
  b: Record<string, EventBinding> | undefined,
): boolean => {
  const ak = a ? Object.keys(a) : [];
  const bk = b ? Object.keys(b) : [];
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    const bv = b?.[k];
    if (!bv) return false;
    if (!bindingsEqual(a![k]!, bv)) return false;
  }
  return true;
};

const childrenEqual = (
  a: VNode[] | undefined,
  b: VNode[] | undefined,
): boolean => {
  const ac = a ?? [];
  const bc = b ?? [];
  if (ac.length !== bc.length) return false;
  for (let i = 0; i < ac.length; i++) {
    if (!vnodeEquals(ac[i]!, bc[i]!)) return false;
  }
  return true;
};

/** Deep structural equality over two vnode trees. Fast-paths reference
 *  equality at every level so memoSafe composition (ref-stable subtrees)
 *  short-circuits in O(1). */
export const vnodeEquals = (a: VNode, b: VNode): boolean => {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  if (a.type === "text") return a.text === (b as VText).text;
  const be = b as VElement;
  if (a.tag !== be.tag) return false;
  if (a.key !== be.key) return false;
  if (!recordEqual(a.attrs, be.attrs)) return false;
  if (!recordEqual(a.style, be.style)) return false;
  if (!eventsEqual(a.events, be.events)) return false;
  return childrenEqual(a.children, be.children);
};


/** Budgeted deep equality — counts element/text nodes visited; once the
 *  budget is exhausted, reports NOT equal ("changed"). This keeps the
 *  isChanged protocol O(budget) on monolithic trees (where the paint
 *  diff is the efficient path) while giving small fragment trees full
 *  suppression. See vnode-valuecel-collapse.md "budgeted depth". */
export const vnodeEqualsWithin = (a: VNode, b: VNode, budget: number): boolean => {
  let remaining = budget;
  const walk = (x: VNode, y: VNode): boolean => {
    if (x === y) return true;
    if (--remaining < 0) return false;            // budget bail ⇒ "changed"
    if (x.type !== y.type) return false;
    if (x.type === "text") return x.text === (y as VText).text;
    const ye = y as VElement;
    if (x.tag !== ye.tag || x.key !== ye.key) return false;
    // node-local field compare via the unbudgeted helper on a childless
    // clone would allocate; reuse vnodeEquals shallow parts directly:
    const xa = { ...x, children: undefined } as VNode;
    const ya = { ...ye, children: undefined } as VNode;
    if (!vnodeEquals(xa, ya)) return false;
    const xc = x.children ?? [], yc = ye.children ?? [];
    if (xc.length !== yc.length) return false;
    for (let i = 0; i < xc.length; i++) if (!walk(xc[i]!, yc[i]!)) return false;
    return true;
  };
  return walk(a, b);
};
