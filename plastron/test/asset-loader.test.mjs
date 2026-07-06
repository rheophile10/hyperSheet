import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// asset-loader — asset.fetch(state, name, {base, cache, onProgress}) → bytes,
// OPFS-cached. Tier-B with a mocked fetch: the fetch path + base + error, and
// the cache-hit (second call served from OPFS, network hit once).

const u8 = (arr) => new Uint8Array(arr);
const resp = (bytes, ok = true, status = 200) => ({
  ok, status,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

// swap globalThis.fetch for the body of a test, always restoring it after
const withFetch = async (impl, body) => {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return impl(String(url), calls.length); };
  try { return await body(calls); } finally { globalThis.fetch = orig; }
};

const load = async (segs = ["asset-loader"]) => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, segs);
  return state;
};

test("fetches base + name and returns the bytes (cache off)", async () => {
  const state = await load();
  const af = resolveFn(state, "asset.fetch");
  await withFetch(() => resp(u8([1, 2, 3, 4])), async (calls) => {
    const out = await af(state, "x.bin", { base: "http://h/", cache: false });
    assert.deepEqual([...out], [1, 2, 3, 4]);
    assert.equal(calls[0], "http://h/x.bin", "base + name fetched verbatim");
  });
});

test("throws on a non-ok HTTP status", async () => {
  const state = await load();
  const af = resolveFn(state, "asset.fetch");
  await withFetch(() => resp(u8([]), false, 404), async () => {
    await assert.rejects(() => af(state, "missing.bin", { base: "http://h/", cache: false }), /HTTP 404/);
  });
});

test("defaults base to the asset.base cel ('/')", async () => {
  const state = await load();
  assert.equal(state.cels.get("asset.base").v, "/", "seeded default base");
  const af = resolveFn(state, "asset.fetch");
  await withFetch(() => resp(u8([9])), async (calls) => {
    await af(state, "y.bin", { cache: false });
    assert.equal(calls[0], "/y.bin");
  });
});

test("onProgress reports status strings", async () => {
  const state = await load();
  const af = resolveFn(state, "asset.fetch");
  const msgs = [];
  await withFetch(() => resp(u8([1])), async () => {
    await af(state, "p.bin", { base: "http://h/", cache: false, onProgress: (m) => msgs.push(m) });
  });
  assert.ok(msgs.some((m) => String(m).includes("fetching")), "a fetching status was reported");
});

test("caches in OPFS: a second fetch is served from cache (network hit exactly once)", async () => {
  const state = await load(["asset-loader", "file-store"]);
  const af = resolveFn(state, "asset.fetch");
  const fsDelete = resolveFn(state, "fs.delete");
  const name = "__assettest__/cached.bin";
  try {
    await withFetch(() => resp(u8([7, 7, 7])), async (calls) => {
      const a = await af(state, name, { base: "http://h/" }); // miss → fetch + cache
      const b = await af(state, name, { base: "http://h/" }); // hit  → OPFS, no fetch
      assert.deepEqual([...a], [7, 7, 7]);
      assert.deepEqual([...b], [7, 7, 7], "cached bytes match");
      assert.equal(calls.length, 1, "network hit exactly once; the second read came from OPFS");
    });
  } finally {
    try { await fsDelete(`/plastron/assets/${name}`); } catch { /* best-effort cleanup */ }
  }
});
