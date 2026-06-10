import type { Fn, State } from "../types/index.js";

// ============================================================================
// fetch — the kernel's single sanctioned network door, sibling to loadScript.
// Stateless (the kernel stays stateless — tier-boundary doctrine): it performs
// the host fetch and nothing else. The STATEFUL governance — logging, the
// allowlist, the provenance/wiretap — lives in the `net` LIBRARY segment, which
// wraps globalThis.fetch so every call (including this door's) is observed.
//
// Why a door at all if net patches the global? It's the sanctioned API segments
// call instead of reaching for globalThis.fetch directly — raw fetch in segment
// code is a review error; this is the one place network IO is named. It also
// gives a stable seam to thread provenance through later (Layer 5).
//
// Off-browser (Bun/Node) globalThis.fetch exists natively, so this works in
// both runtimes unchanged.
// ============================================================================

/** netFetch(url, init?) → Promise<Response>. The sanctioned network call. */
export const netFetch = (input: string, init?: unknown): Promise<Response> => {
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  if (!f) return Promise.reject(new Error("fetch: no fetch in this environment"));
  return f(input, init as RequestInit | undefined);
};

/** Cel-bound form (kernel fns take `state` first; the door ignores it). */
export const netFetchFn: Fn = ((_state: State | undefined, url: unknown, init?: unknown): Promise<Response> =>
  netFetch(String(url ?? ""), init)) as Fn;
