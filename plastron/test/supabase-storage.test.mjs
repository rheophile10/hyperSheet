import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createInitialState, resolveFn } from "../dist/index.js";

// supabase-storage — LIVE Storage (buckets) round-trips against the local stack.
// The fixture migration creates a private bucket "plastron-test" with RLS letting
// an authenticated user CRUD objects. Skips when the stack is unreachable.

const cfg = JSON.parse(readFileSync(new URL("./supabase-test/test-config.json", import.meta.url)));
const URL_ = process.env.SUPABASE_TEST_URL ?? cfg.url;
const ANON = process.env.SUPABASE_TEST_ANON_KEY ?? cfg.anonKey;
const EMAIL = process.env.SUPABASE_TEST_EMAIL ?? cfg.testEmail;
const PASS = process.env.SUPABASE_TEST_PASSWORD ?? cfg.testPassword;
const BUCKET = "plastron-test";

let reachable = false;
try { await fetch(`${URL_}/auth/v1/health`); reachable = true; } catch { /* down */ }
const live = reachable ? test : test.skip;
if (!reachable) console.warn(`[supabase-storage] local stack ${URL_} unreachable — skipping live tests`);

const boot = async (signIn = true) => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["supabase-auth", "supabase-storage"]);
  await resolveFn(state, "setCel")(state, "sb.test.url", { celType: "ValueCel", v: URL_, metadata: { key: "sb.test.url", segment: "app" } });
  await resolveFn(state, "setCel")(state, "sb.test.anonkey", { celType: "ValueCel", v: ANON, metadata: { key: "sb.test.anonkey", segment: "app" } });
  if (signIn) await resolveFn(state, "supabase.auth")(state, "signin", "test", { email: EMAIL, password: PASS });
  return state;
};
const store = (state) => resolveFn(state, "supabase.storage");

live("upload → download → list → remove round-trips through Storage", async () => {
  const state = await boot();
  const path = `notes/t-${Date.now()}.txt`;
  const body = "hello from plastron storage";

  const up = await store(state)(state, "upload", "test", { bucket: BUCKET, path, content: body });
  assert.ok(up && (up.Key || up.Id), `upload should return a key, got: ${JSON.stringify(up)}`);

  const got = await store(state)(state, "download", "test", { bucket: BUCKET, path });
  assert.equal(got, body, "download returns the uploaded content");

  const listed = await store(state)(state, "list", "test", { bucket: BUCKET, prefix: "notes/" });
  assert.ok(Array.isArray(listed), `list should return an array, got: ${JSON.stringify(listed)}`);
  assert.ok(listed.some((o) => path.endsWith(o.name)), "uploaded object appears in the listing");

  const rm = await store(state)(state, "remove", "test", { bucket: BUCKET, path });
  assert.ok(rm, "remove returns ok");
  const after = await store(state)(state, "download", "test", { bucket: BUCKET, path });
  assert.match(String(after), /HTTP 4\d\d/, "object is gone after remove");
});

live("listBuckets sees the test bucket", async () => {
  const state = await boot();
  const buckets = await store(state)(state, "listBuckets", "test", {});
  assert.ok(Array.isArray(buckets), `expected array, got: ${JSON.stringify(buckets)}`);
  assert.ok(buckets.some((b) => b.id === BUCKET), "the fixture bucket is listed");
});

live("RLS: anon cannot upload to the private bucket", async () => {
  const anon = createInitialState();
  await resolveFn(anon, "ensureSegments")(anon, ["supabase-storage"]);
  await resolveFn(anon, "setCel")(anon, "sb.anon.url", { celType: "ValueCel", v: URL_, metadata: { key: "sb.anon.url", segment: "app" } });
  await resolveFn(anon, "setCel")(anon, "sb.anon.anonkey", { celType: "ValueCel", v: ANON, metadata: { key: "sb.anon.anonkey", segment: "app" } });
  const out = await store(anon)(anon, "upload", "anon", { bucket: BUCKET, path: `x-${Date.now()}.txt`, content: "nope" });
  assert.equal(typeof out, "string");
  assert.match(out, /upload:/, "anon upload rejected by RLS");
});

test("missing config → graceful error (no network)", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["supabase-storage"]);
  const out = await resolveFn(state, "supabase.storage")(state, "list", "nope", { bucket: "x" });
  assert.match(out, /missing supabase config .* sb\.nope/);
});
