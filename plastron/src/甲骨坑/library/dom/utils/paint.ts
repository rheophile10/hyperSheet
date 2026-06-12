import type { ChannelEnqueue, RenderSpec, State } from "../../../../types/index.js";
import { resolveFn } from "../../../../kernel/index.js";
import { diffVNodes, type DiffEq, type Patch } from "./diff.js";
import { applyPatch, type DocLike } from "./apply.js";
import { drawCanvases } from "./canvas.js";

// ── OPFS image hydration ────────────────────────────────────────────────────
// img[data-opfs-src] (the `img` verb's "/path" form) resolves to an objectURL
// from file-store bytes after each paint — the canvas data-ops replay
// pattern. Guarded: no file-store / missing file leaves the element src-less;
// never breaks a flush. objectURLs cache per path for the page's lifetime.
const opfsUrlCache = new Map<string, string>();
const OPFS_MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", avif: "image/avif",
};
const hydrateOpfsImgs = (root: unknown, state: State): void => {
  const r = root as { querySelectorAll?: (sel: string) => ArrayLike<{ getAttribute(n: string): string | null; setAttribute(n: string, v: string): void }> } | null;
  if (!r || typeof r.querySelectorAll !== "function") return;
  const imgs = r.querySelectorAll("img[data-opfs-src]:not([src])");
  for (let i = 0; i < imgs.length; i++) {
    const el = imgs[i]!;
    const path = el.getAttribute("data-opfs-src");
    if (!path) continue;
    const hit = opfsUrlCache.get(path);
    if (hit) { el.setAttribute("src", hit); continue; }
    void (async () => {
      try {
        const ensure = resolveFn(state, "ensureSegments") as ((s: State, names: string[]) => Promise<unknown>) | undefined;
        if (ensure) await ensure(state, ["file-store"]);
        const read = resolveFn(state, "fs.read") as ((p: string) => Promise<Uint8Array>) | undefined;
        if (!read) return;
        const bytes = await read(path);
        if (!bytes || (bytes as { length?: number }).length === 0) return;
        const G = globalThis as { Blob?: new (parts: unknown[], o?: { type?: string }) => unknown; URL?: { createObjectURL?: (b: unknown) => string } };
        if (!G.Blob || !G.URL?.createObjectURL) return;
        const ext = path.split(".").pop()?.toLowerCase() ?? "";
        const url = G.URL.createObjectURL(new G.Blob([bytes], OPFS_MIME[ext] ? { type: OPFS_MIME[ext] } : undefined));
        opfsUrlCache.set(path, url);
        el.setAttribute("src", url);
      } catch { /* absent backend or file — the img stays empty */ }
    })();
  }
};
import {
  applyListenerDelta, defaultResolveTarget,
  type GlobalRegistry, type ListenerRegistry, type ResolveTarget,
} from "./events.js";

// ============================================================================
// The painter — a RAF-batched consumer of render-specs. The kernel's
// ChannelCel buffers fired view cels; the paint channel's drain forwards each
// render-spec to this painter, which coalesces N enqueues into ONE flush at
// the next animation frame. Each flush diffs vnode trees to JSON patches,
// applies them to the DOM (browser only), and reconciles the global listener
// registry. See docs/1-design/2-in-evaluation/raf-channel.md.
//
// Off-browser (Bun CLI / SSR), the patch is still produced and recorded
// (observable via lastPatch) but applyPatch is skipped — there is no DOM to
// mutate. RAF falls back to setTimeout(16).
// ============================================================================

interface ElementLike {
  childNodes: ArrayLike<{ nodeType: number }>;
  replaceChildren(...c: unknown[]): void;
}

export interface PainterOpts {
  /** Schedule a frame callback; returns a cancel handle. Default: rAF in
   *  browser, setTimeout(16) elsewhere. Tests inject a mock queue. */
  raf?: (cb: () => void) => number;
  caf?: (id: number) => void;
  /** Whether to mutate the DOM. Default: a document is present. */
  isBrowser?: boolean;
  /** Document used by applyPatch. Default: globalThis.document. */
  doc?: DocLike;
  /** Resolve a mount selector to a host element. Default: document.querySelector. */
  resolveMount?: (mount: string | null) => ElementLike | null;
  /** Resolve a global-listener target name. Default: defaultResolveTarget. */
  resolveTarget?: ResolveTarget;
}

export interface Painter {
  enqueue(spec: RenderSpec): void;
  flush(): void;
  drain(): void;
  dispose(): void;
  /** The patch produced for a mount on its last flush — inspectable in tests
   *  and off-browser, where the DOM mutation is skipped but the diff runs. */
  lastPatch(mount: string | null): Patch | undefined;
  /** Whether a frame is currently scheduled (for batching assertions). */
  pending(): boolean;
}

const hasDocument = (): boolean =>
  typeof (globalThis as { document?: unknown }).document !== "undefined";

const mountKeyOf = (mount: string | null): string => mount ?? "__default__";

const resolveDiffEq = (state: State): DiffEq => {
  const vnodeEquals = resolveFn(state, "vnode.equals") as DiffEq["vnodeEquals"] | undefined;
  const bindingsEqual = resolveFn(state, "vnode.bindings-equal") as DiffEq["bindingsEqual"] | undefined;
  if (!vnodeEquals || !bindingsEqual) {
    throw new Error(
      "dom: comparator cels (vnode.equals / vnode.bindings-equal) are not installed — the html-template-parser segment must be loaded.",
    );
  }
  return { vnodeEquals, bindingsEqual };
};

export const createPainter = (state: State, opts: PainterOpts = {}): Painter => {
  const isBrowser = opts.isBrowser ?? hasDocument();
  const raf = opts.raf
    ?? (isBrowser && typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame === "function"
      ? (cb: () => void) => (globalThis as unknown as { requestAnimationFrame: (c: () => void) => number }).requestAnimationFrame(cb)
      : (cb: () => void) => setTimeout(cb, 16) as unknown as number);
  const caf = opts.caf
    ?? ((id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>));
  const doc = opts.doc ?? (globalThis as { document?: DocLike }).document;
  const resolveTarget = opts.resolveTarget ?? defaultResolveTarget;
  const resolveMount = opts.resolveMount ?? ((m: string | null): ElementLike | null => {
    const d = (globalThis as { document?: { querySelector?: (s: string) => ElementLike | null } }).document;
    return m && d?.querySelector ? d.querySelector(m) : null;
  });

  const dirty = new Map<string, RenderSpec>();
  const lastEnqueued = new Map<string, RenderSpec>();
  const lastApplied = new Map<string, RenderSpec>();
  const mountedNode = new Map<string, { nodeType: number } | null>();
  const patches = new Map<string, Patch>();
  const perElement: ListenerRegistry = new WeakMap();
  const globalReg: GlobalRegistry = new Map();
  let rafId: number | null = null;
  let disposed = false;

  const flush = (): void => {
    rafId = null;
    if (disposed) return;
    // Comparator cels resolved ONCE per drain (not per node) — the
    // semantics live with html-template-parser; the edge is a cel.
    const eq = resolveDiffEq(state);
    for (const [key, next] of dirty) {
      const prev = lastApplied.get(key);
      const patch = diffVNodes(prev?.vnode ?? null, next.vnode, eq);
      patches.set(key, patch);
      if (isBrowser && doc) {
        const target = resolveMount(next.mount);
        if (target) {
          const node = applyPatch(target as never, mountedNode.get(key) ?? null, patch, perElement, state, doc);
          mountedNode.set(key, node as { nodeType: number } | null);
          // replay any <canvas data-ops> draw-specs onto their 2d contexts
          // (plastron-canvas vocabulary). Guarded — never breaks a flush.
          drawCanvases(target);
          hydrateOpfsImgs(target, state);
        }
      }
      // Specs without a listeners array (e.g. window-frame mounts) skip the
      // global-listener reconciliation entirely — passing undefined through
      // would throw, and an empty array would wrongly REMOVE the view's
      // registered listeners under another mount key.
      if (Array.isArray(next.listeners)) {
        applyListenerDelta(prev?.listeners, next.listeners, globalReg, state, resolveTarget);
      }
      lastApplied.set(key, next);
    }
    dirty.clear();
  };

  return {
    enqueue(spec) {
      if (disposed) return;
      // In the browser a null mount can never apply — deactivated views
      // (mount-gate → null) would collide under the "__default__" key and
      // cross-talk in lastApplied/listener reconciliation. Off-browser, null
      // mounts stay observable via lastPatch(null) (diff-only mode).
      if (isBrowser && spec.mount === null) return;
      const key = mountKeyOf(spec.mount);
      // Ref-eq short-circuit — a view cel's L1 cache hit hands us the same
      // render-spec reference; nothing to schedule.
      if (lastEnqueued.get(key) === spec) return;
      lastEnqueued.set(key, spec);
      dirty.set(key, spec);
      if (rafId === null) rafId = raf(flush);
    },
    flush,
    drain() {
      if (rafId !== null) { caf(rafId); rafId = null; }
      flush();
    },
    dispose() {
      disposed = true;
      if (rafId !== null) { caf(rafId); rafId = null; }
      // Tear down global listeners by reconciling to an empty spec set.
      applyListenerDelta([...globalReg.values()].map((e) => e.spec), [], globalReg, state, resolveTarget);
      dirty.clear();
    },
    lastPatch(mount) { return patches.get(mountKeyOf(mount)); },
    pending() { return rafId !== null; },
  };
};

// ── per-state painter registry + the paint channel drain ────────────────────

const painters = new WeakMap<State, Painter>();

/** Install a painter for a state (tests inject a mock-raf painter here). */
export const setPainter = (state: State, painter: Painter): void => { painters.set(state, painter); };

/** The painter for a state, lazily created with host defaults. */
export const getPainter = (state: State): Painter => {
  let p = painters.get(state);
  if (!p) { p = createPainter(state); painters.set(state, p); }
  return p;
};

/** Drain handler for the `dom.paint` ChannelCel: forward each
 *  buffered view cel's render-spec to the painter's (batched) enqueue. */
export const paintDrain = (items: ChannelEnqueue[], state: State): void => {
  const painter = getPainter(state);
  for (const { cel } of items) {
    const spec = cel.v as RenderSpec | undefined;
    if (spec && typeof spec === "object" && "vnode" in spec) painter.enqueue(spec);
  }
};
