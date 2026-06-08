import type { Fn } from "../../../../types/index.js";
import type { RenderSpec } from "./vnode.js";
import { vnodeEqualsWithin } from "./vnode.js";

// Per the vnode-valuecel-collapse spec: deep compares are cheap on
// fragment-sized trees and a bounded tax on monoliths (bail ⇒ changed).
const FRAGMENT_EQ_BUDGET = 64;

// ============================================================================
// isChanged protocols for the view-layer schemas. Each pairs with a
// `memoSafe: true` SchemaCel: the producer maintains reference stability,
// and these comparators let cascade suppression preserve the prior ref
// when nothing material changed — which is what makes the view cel's L1
// cache (and the painter's ref-eq diff bail-outs) pay off.
// ============================================================================

const stringArrayEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** string[] equality, element-by-element. Used by the global-listener
 *  registry cel (event-registries) and any list-of-strings view input. */
export const stringList_isChanged: Fn = (a, b) => !stringArrayEqual(a, b);

/** Deep structural vnode equality (ref-eq short-circuited at every level). */
export const vnode_isChanged: Fn = (a, b) => {
  if (a === b) return false;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return a !== b;
  return !vnodeEqualsWithin(a as RenderSpec["vnode"], b as RenderSpec["vnode"], FRAGMENT_EQ_BUDGET);
};

/** render-spec equality: same vnode (structural), same mount, same global
 *  listener specs. */
export const renderSpec_isChanged: Fn = (a, b) => {
  if (a === b) return false;
  const ra = a as RenderSpec | undefined;
  const rb = b as RenderSpec | undefined;
  if (!ra || !rb) return true;
  if (ra.mount !== rb.mount) return true;
  if (!stringArrayEqual(ra.listeners, rb.listeners)) return true;
  return !vnodeEqualsWithin(ra.vnode, rb.vnode, FRAGMENT_EQ_BUDGET);
};
