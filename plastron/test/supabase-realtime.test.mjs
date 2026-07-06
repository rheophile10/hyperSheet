import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createInitialState, resolveFn } from "../dist/index.js";

// supabase realtime — LIVE Phoenix-channel WebSocket against the local stack.
// The key test isolates the realtime push from the local-write bump by using TWO
// clients: the OBSERVER subscribes (its rev cel moves ONLY via a WS push); a
// separate MUTATOR does a REST insert. If realtime works, the observer's
// sb.test.todos.rev bumps from the broadcast. Skips when the stack is down.

const cfg = JSON.parse(readFileSync(new URL("./supabase-test/test-config.json", import.meta.url)));
const URL_ = process.env.SUPABASE_TEST_URL ?? cfg.url;
const ANON = process.env.SUPABASE_TEST_ANON_KEY ?? cfg.anonKey;
const EMAIL = process.env.SUPABASE_TEST_EMAIL ?? cfg.testEmail;
const PASS = process.env.SUPABASE_TEST_PASSWORD ?? cfg.testPassword;

let reachable = false;
try { await fetch(`${URL_}/auth/v1/health`); reachable = true; } catch { /* down */ }
const live = reachable ? test : test.skip;
if (!reachable) console.warn(`[supabase-realtime] local stack ${URL_} unreachable — skipping live tests`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 9000, step = 150) => {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred()) return true; await sleep(step); }
  return false;
};

const boot = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["supabase-auth", "supabase"]);
  await resolveFn(state, "setCel")(state, "sb.test.url", { celType: "ValueCel", v: URL_, metadata: { key: "sb.test.url", segment: "app" } });
  await resolveFn(state, "setCel")(state, "sb.test.anonkey", { celType: "ValueCel", v: ANON, metadata: { key: "sb.test.anonkey", segment: "app" } });
  await resolveFn(state, "supabase.auth")(state, "signin", "test", { email: EMAIL, password: PASS });
  return state;
};

// supabase.realtime is an async verb → every call returns a Promise; status
// MUST be awaited. waitForConnected polls the awaited status.
const waitForConnected = async (rt, state, ms = 6000) =>
  waitFor(async () => (await rt(state, "status", "test")).connected, ms);

live("subscribe → a server-side insert pushes over realtime and bumps the observer's rev cel", async () => {
  const observer = await boot();
  const rt = resolveFn(observer, "supabase.realtime");
  const sub = await rt(observer, "subscribe", "test", { table: "todos" });
  assert.match(sub, /subscribed/, sub);

  // let the channel JOIN before mutating
  assert.ok(await waitForConnected(rt, observer), "realtime socket connected");
  await sleep(500);
  const before = Number(observer.cels.get("sb.test.todos.rev")?.v ?? 0);

  // a SEPARATE client mutates → observer.rev can only move via the WS push
  const mutator = await boot();
  const ins = await resolveFn(mutator, "supabase.data")(mutator, "insert", "test", { table: "todos", rows: { title: `rt-${Date.now()}` } });
  assert.ok(Array.isArray(ins), `insert failed: ${JSON.stringify(ins)}`);
  const id = ins[0].id;

  const bumped = await waitFor(() => Number(observer.cels.get("sb.test.todos.rev")?.v ?? 0) > before);
  assert.ok(bumped, "realtime push bumped the observer's sb.test.todos.rev");

  // cleanup
  await resolveFn(mutator, "supabase.data")(mutator, "delete", "test", { table: "todos", match: `id=eq.${id}` });
  await rt(observer, "unsubscribe", "test", { table: "todos" });
}, 20000);

live("status reflects connect + channels, and unsubscribe tears down", async () => {
  const state = await boot();
  const rt = resolveFn(state, "supabase.realtime");
  await rt(state, "subscribe", "test", { table: "todos" });
  assert.ok(await waitForConnected(rt, state), "connected");
  const st = await rt(state, "status", "test");
  assert.equal(st.connected, true);
  assert.ok(st.channels.includes("public.todos"));
  const msg = await rt(state, "unsubscribe", "test", { table: "todos" });
  assert.match(msg, /unsubscribed/);
  assert.equal((await rt(state, "status", "test")).channels.length, 0);
}, 20000);

test("missing config → graceful error (no socket)", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["supabase"]);
  const out = await resolveFn(state, "supabase.realtime")(state, "subscribe", "nope", { table: "todos" });
  assert.match(out, /missing supabase config .* sb\.nope/);
});
