// ============================================================================
// VNode — a JSON-shaped virtual-DOM tree: the output of any view-layer
// template parser and the input to any painter. Pure data: no DOM, no
// closures, round-trips through dehydrate. PLATFORM value contract —
// these shapes describe cel VALUES that flow between segments (the
// render-spec SchemaCel names them), so they live in types/, not in a
// segment (segment-isolation class D). The comparators stay with their
// owning segment (html-template-parser) and are reached through cels.
//
// Carried forward from the legacy `segments/dom/src/vnode.ts`
// (per the htm-view-layers / raf-channel designs) and trimmed to the core
// the plastron kernel surface needs. The one substantive addition
// is the `{ f: string }` form on EventBinding — a formula-source binding
// the painter compiles lazily on first dispatch (see event-registries).
//
// tsconfig here ships no DOM lib, so this module stays free of Element /
// EventListener types; those live in the painter (apply), which narrows
// the host structurally.
// ============================================================================

export type AttrValue = string | number | boolean | null;

/** Declarative event binding carried inside a VElement's `events` bag.
 *  All four forms are JSON-shaped — they round-trip through dehydrate and
 *  carry no closures. The painter turns them into real DOM listeners. */
export interface EventBinding {
  /** Formula-source binding. The painter compiles this S-expression
   *  lazily on first dispatch and caches the closure. The primary form
   *  produced by the template parser for event slots (see the
   *  htm-view-layers "event-slot" rule). */
  f?: string;
  /** Cel key to write on the event. */
  set?: string;
  /** Fixed value to write when `set` is present. */
  value?: unknown;
  /** Read a named property off `event.target` and write it to `set`.
   *  Precedence when `set` is present: `value` > `extract` > EventInfo. */
  extract?: "value" | "checked" | "valueAsNumber" | "valueAsDate" | "files";
  /** Cel key naming a registered fn to invoke on the event. */
  dispatch?: string;
  /** Static payload passed to the dispatch fn. */
  payload?: unknown;
}

export interface VText {
  type: "text";
  text: string;
}

export interface VElement {
  type: "el";
  tag: string;
  /** Child-reconciliation hint — local to the parent's children list,
   *  UNRELATED to `cel.key`. When every child in both the old and new
   *  lists is a keyed VElement, the diff reconciles by key. */
  key?: string;
  /** Memo hint — a cheap signature the diff compares (=== or shallow-array) to
   *  skip an unchanged subtree's deep compare. A view sets it like `key`; the
   *  diff (dom) does the work, so O(changed) reconcile is a LIBRARY
   *  capability every app gets, not app-specific code. undefined → always
   *  deep-diffed. */
  memo?: unknown;
  attrs?: Record<string, AttrValue>;
  /** Inline styles, diffed and applied per-property at paint time. */
  style?: Record<string, AttrValue>;
  events?: Record<string, EventBinding>;
  children?: VNode[];
}

export type VNode = VText | VElement;

/** The view cel's output: the vnode tree, where to mount it, and the
 *  global listener specs the painter reconciles (see event-registries). */
export interface RenderSpec {
  vnode: VNode;
  mount: string | null;
  listeners: string[];
}

