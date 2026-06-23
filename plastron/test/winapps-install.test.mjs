import { test, beforeAll, afterAll } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// winapps app.install / app.installed — fetch an assets manifest's files to OPFS,
// idempotently, sha-verified. The foundation for origin-applications that install
// to OPFS then load from OPFS (e.g. DOOM's WAD).
process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs";
const { createInitialState, resolveFn } = await import("../dist/index.js");

const PREFIX = `__winapps-test-${process.pid}-${Date.now().toString(36)}`;
const FAKE = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
const sha256hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)))].map((x) => x.toString(16).padStart(2, "0")).join("");

let state, root, realFetch;
beforeAll(async () => {
  state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["winapps", "file-store", "dom"]);
  await resolveFn(state, "hydrate")(state, [], []);
  root = state.cels.get("file-store.root").v;
  await fs.rm(path.resolve(root, PREFIX), { recursive: true, force: true });
  realFetch = globalThis.fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  if (root) await fs.rm(path.resolve(root, PREFIX), { recursive: true, force: true });
});

// mock fetch: asset URLs → FAKE bytes; manifest URLs (ending .json) → their JSON body.
const mockFetch = (manifestForUrl = {}) => { globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith(".json")) return { ok: true, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(manifestForUrl[u] ?? {})).buffer };
  return { ok: true, arrayBuffer: async () => FAKE.buffer.slice(0) };
}; };

test("install downloads missing assets to OPFS; installed reports presence; re-install is idempotent", async () => {
  mockFetch();
  const manifest = { name: "demo", version: "v1", assets: [{ url: "https://x/asset.bin", opfs: `${PREFIX}/asset.bin` }] };
  const installed = resolveFn(state, "app.installed"), install = resolveFn(state, "app.install");
  const read = resolveFn(state, "fs.read");

  assert.equal(await installed(state, manifest), false, "not installed yet");
  const r1 = await install(state, manifest);
  assert.match(r1, /\+ .*asset\.bin/, "downloaded the asset");
  const got = await read(`${PREFIX}/asset.bin`);
  assert.deepEqual(new Uint8Array(got), FAKE, "bytes landed in OPFS");
  assert.equal(await installed(state, manifest), true, "now installed");
  const r2 = await install(state, manifest);
  assert.match(r2, /= .*asset\.bin/, "second install skips (idempotent)");
});

test("install verifies SHA-256 when given, and throws on mismatch", async () => {
  mockFetch();
  const install = resolveFn(state, "app.install");
  const goodSha = await sha256hex(FAKE);
  await install(state, { assets: [{ url: "https://x/ok.bin", opfs: `${PREFIX}/ok.bin`, sha: goodSha }] });
  assert.deepEqual(new Uint8Array(await resolveFn(state, "fs.read")(`${PREFIX}/ok.bin`)), FAKE, "good sha installs");

  await assert.rejects(
    () => install(state, { assets: [{ url: "https://x/bad.bin", opfs: `${PREFIX}/bad.bin`, sha: "00".repeat(32) }] }),
    /sha mismatch/, "wrong sha throws",
  );
  assert.equal(await resolveFn(state, "fs.exists")(`${PREFIX}/bad.bin`), false, "mismatched asset not written");
});

test("a manifest can be a URL (its JSON is fetched first)", async () => {
  const url = "https://x/app.json";
  mockFetch({ [url]: { name: "byurl", assets: [{ url: "https://x/m.bin", opfs: `${PREFIX}/m.bin` }] } });
  await resolveFn(state, "app.install")(state, url);
  assert.equal(await resolveFn(state, "fs.exists")(`${PREFIX}/m.bin`), true, "asset from a URL-manifest installed");
});
