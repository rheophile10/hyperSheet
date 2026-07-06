import type { State, 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// asset-loader — fetch a named binary asset, cached in OPFS. Generalises doom's
// inline fetch (bytes from a base URL) by adding a fetch-once / serve-from-OPFS
// cache, so a 28 MB WAD (or rapier / maplibre / occt / three bytes) downloads
// once and reloads instantly. The one mechanism behind every heavy lazy tier.
//
//   asset.fetch(state, name [, { base?, cache?, onProgress? }]) → Uint8Array
//
// base:  URL prefix (default: the asset.base cel, else globalThis.__plastronAssets,
//        else "/"). `name` is appended verbatim → fetch(base + name).
// cache: OPFS cache at /plastron/assets/<name> (default true; best-effort — a
//        missing file-store / OPFS silently degrades to a plain fetch).
// onProgress: advisory status strings ("fetching …", "cached …", "saved …").
// ============================================================================

const ASSET_DIR = "/plastron/assets";

interface FetchOpts { base?: string; cache?: boolean; onProgress?: (m: string) => void }

const fetchAssetImpl = async (state: State, name: unknown, opts?: FetchOpts): Promise<Uint8Array> => {
  const o = opts ?? {};
  const nm = String(name ?? "").replace(/^\/+/, "");
  if (!nm) throw new Error("asset.fetch: empty name");
  const base = o.base !== undefined
    ? String(o.base)
    : String(state.cels.get("asset.base")?.v ?? (globalThis as { __plastronAssets?: string }).__plastronAssets ?? "/");
  const useCache = o.cache !== false;
  const note = (m: string): void => { try { o.onProgress?.(m); } catch { /* progress is advisory */ } };
  const cachePath = `${ASSET_DIR}/${nm}`;

  // resolve fs handles (best-effort; degrade to a plain fetch if file-store absent)
  let fsRead: Fn | undefined, fsWrite: Fn | undefined, fsExists: Fn | undefined;
  if (useCache) {
    try {
      await (resolveFn(state, "ensureSegments") as Fn)(state, ["file-store"]);
      fsRead = resolveFn(state, "fs.read") as Fn;
      fsWrite = resolveFn(state, "fs.write") as Fn;
      fsExists = resolveFn(state, "fs.exists") as Fn;
    } catch { /* no fs → no cache */ }
  }

  // 1. cache hit — serve from OPFS. fs.* are module-singleton: (path), not (state, path).
  if (fsRead && fsExists) {
    try {
      if (await fsExists(cachePath)) {
        const cached = (await fsRead(cachePath)) as Uint8Array;
        if (cached && cached.byteLength) { note(`cached ${nm}`); return cached; }
      }
    } catch { /* unreadable cache → re-fetch */ }
  }

  // 2. network
  note(`fetching ${nm}…`);
  const r = await (globalThis as { fetch: typeof fetch }).fetch(base + nm);
  if (!r.ok) throw new Error(`asset.fetch: ${nm} HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());

  // 3. cache write — best-effort (fs.write auto-creates parent dirs)
  if (fsWrite) {
    try { await fsWrite(cachePath, bytes); note(`saved ${nm}`); }
    catch { /* cache write failed → still return the bytes */ }
  }
  return bytes;
};

/** Direct typed entry for in-process callers (doom, future lazy tiers). */
export const fetchAsset = fetchAssetImpl;

const fetchFn: Fn = ((state: State, name: unknown, opts?: unknown) =>
  fetchAssetImpl(state, name, opts as FetchOpts | undefined)) as Fn;

export const name = "asset-loader" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["asset.fetch", fetchFn],
]));
