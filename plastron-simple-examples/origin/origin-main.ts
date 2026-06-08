// ============================================================================
// origin-main — THE boot for the origin host (origin-segment.md).
//
// The whole host: wake the origin segment, hydrate, paint. The kernel
// surfaces 元.view at "#app" — one centered cel in freespace whose value
// is the readme. Type formulas to grow an application out of it.
// ============================================================================
import {
  createInitialState, resolveFn, precomputeOptional, createPainter, setPainter,
} from "../../plastron-simple/dist/index.js";

const resolve = resolveFn as (s: unknown, k: string) => (...a: unknown[]) => Promise<unknown> | unknown;

const state = createInitialState();
setPainter(state, createPainter(state)); // real rAF + document
await (resolve(state, "ensureSegments"))(state, ["origin"]);
await (resolve(state, "hydrate"))(state, [], []);
await (resolveFn(state, "precomputeOptional") ?? precomputeOptional)(state);
await (resolve(state, "runCycle"))(state);
await (resolve(state, "drain"))(state, "plastron-dom.paint");

// ── save / restore ────────────────────────────────────────────────────────
// The page bakes the sheet into itself: each cell's SOURCE (formula/value)
// is collected and written into the downloaded file as a replay seed; on
// boot the seed is committed cell-by-cell, rebuilding the sheet. (Full graph
// dehydration is the eventual path, once the origin routes edits into a
// user-space segment; this captures the cells without that refactor.)

const cellSource = (key: string): string => {
  const c = state.cels.get(key) as { f?: string; v?: unknown } | undefined;
  if (!c) return "";
  return c.f ?? (c.v === undefined || c.v === null ? "" : String(c.v));
};
// 元.cells lists 元 first, then grid cells sorted — replaying in this order
// creates a grid (its grid() formula) before the cells that live inside it.
const collectSeed = (): [string, string][] => {
  const cells = (state.cels.get("元.cells")?.v as string[] | undefined) ?? ["元"];
  const out: [string, string][] = [];
  for (const k of cells) { const s = cellSource(k); if (s !== "") out.push([k, s]); }
  return out;
};

// replay a baked seed (if the host file carries one)
const seedEl = document.getElementById("plastron-seed");
if (seedEl?.textContent?.trim()) {
  try {
    const pairs = JSON.parse(seedEl.textContent) as [string, string][];
    const setValue = resolve(state, "setValue");
    const commit = resolve(state, "origin.commit");
    for (const [key, src] of pairs) { await setValue(state, "元.draft", src); await commit(state, key); }
  } catch (e) { console.error("plastron: bad seed", e); }
}

// download THIS app as a single self-contained index.html, with the current
// sheet baked in as the replay seed. Serializes the live document (inline
// module + styles preserved) so it works whether the page came over http or
// from a local file; #app is cleared so the saved file boots clean.
const download = (): void => {
  const html = document.documentElement.cloneNode(true) as HTMLElement;
  html.querySelector("#app")?.replaceChildren();
  html.querySelector("#plastron-seed")?.remove();
  const seed = document.createElement("script");
  seed.id = "plastron-seed"; seed.type = "application/json";
  seed.textContent = JSON.stringify(collectSeed());
  html.querySelector("body")?.appendChild(seed);
  const blob = new Blob(["<!doctype html>\n", html.outerHTML], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "plastron.html"; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// expose for console tinkering + the Save button in the host chrome
(globalThis as { plastron?: unknown }).plastron = { state, resolveFn, download, collectSeed };
