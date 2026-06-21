import type { Fn, State } from "../types/index.js";

// ============================================================================
// loadScript — the kernel's one host-capability for pulling an EXTERNAL
// resource at runtime. External libraries (Pyodide, wabt) can't ride
// in a bundle that marks them `external`; a browser host loads them from a CDN
// instead. Rather than bake a <script> into each host's HTML, loading is an
// explicit, idempotent call so it's visible in the graph and reusable.
//
// In a browser it injects a <script src=url> and resolves once it loads (for
// global/UMD libraries like pyodide.js, which define a global). Off-browser
// (Node/Bun) it resolves immediately — those hosts import the package directly.
// ============================================================================

interface ScriptEl { src: string; async: boolean; onload: (() => void) | null; onerror: (() => void) | null; }
interface DocLike { createElement(tag: string): ScriptEl; head: { appendChild(n: unknown): void }; }

const _inflight = new Map<string, Promise<void>>();

/** loadScript(url) → Promise<void>. Idempotent per URL. */
export const loadScript = (url: string): Promise<void> => {
  const src = String(url ?? "");
  if (!src) return Promise.resolve();
  const doc = (globalThis as { document?: DocLike }).document;
  if (!doc?.head) return Promise.resolve(); // off-browser: nothing to inject
  const cached = _inflight.get(src);
  if (cached) return cached;
  const p = new Promise<void>((resolve, reject) => {
    const s = doc.createElement("script");
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`loadScript: failed to load ${src}`));
    doc.head.appendChild(s);
  });
  _inflight.set(src, p);
  return p;
};

/** Cel-bound form (kernel fns take `state` first; loadScript ignores it). */
export const loadScriptFn: Fn = ((_state: State | undefined, url: unknown): Promise<void> =>
  loadScript(String(url ?? ""))) as Fn;
