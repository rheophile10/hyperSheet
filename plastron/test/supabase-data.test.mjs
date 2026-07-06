import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createInitialState, resolveFn } from "../dist/index.js";

// supabase (data plane) — LIVE PostgREST round-trips against the local stack
// (test/supabase-test). Exercises select/insert/update/delete with the user JWT
// borrowed from the session store, RLS scoping, and the sb.<proj>.<table>.rev
// reactivity counter. Skips when the stack is unreachable.

const cfg = JSON.parse(readFileSync(new URL("./supabase-test/test-config.json", import.meta.url)));
const URL_ = process.env.SUPABASE_TEST_URL ?? cfg.url;
const ANON = process.env.SUPABASE_TEST_ANON_KEY ?? cfg.anonKey;
const EMAIL = process.env.SUPABASE_TEST_EMAIL ?? cfg.testEmail;
const PASS = process.env.SUPABASE_TEST_PASSWORD ?? cfg.testPassword;

let reachable = false;
try { await fetch(`${URL_}/auth/v1/health`); reachable = true; } catch { /* down */ }
const live = reachable ? test : test.skip;
if (!reachable) console.warn(`[supabase-data] local stack ${URL_} unreachable — skipping live tests`);

const boot = async (signIn = true) => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["supabase-auth", "supabase"]);
  await resolveFn(state, "setCel")(state, "sb.test.url", { celType: "ValueCel", v: URL_, metadata: { key: "sb.test.url", segment: "app" } });
  await resolveFn(state, "setCel")(state, "sb.test.anonkey", { celType: "ValueCel", v: ANON, metadata: { key: "sb.test.anonkey", segment: "app" } });
  if (signIn) await resolveFn(state, "supabase.auth")(state, "signin", "test", { email: EMAIL, password: PASS });
  return state;
};
const data = (state) => resolveFn(state, "supabase.data");

live("insert → select round-trips through PostgREST with the user JWT (RLS owner set)", async () => {
  const state = await boot();
  const title = `plastron-test-${Date.now()}`;
  const inserted = await data(state)(state, "insert", "test", { table: "todos", rows: { title } });
  assert.ok(Array.isArray(inserted), `insert should return rows, got: ${JSON.stringify(inserted)}`);
  assert.equal(inserted[0].title, title);
  assert.ok(inserted[0].owner, "owner stamped from auth.uid()");
  const id = inserted[0].id;

  const rows = await data(state)(state, "select", "test", { table: "todos", query: `select=id,title,done&id=eq.${id}` });
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, title);

  await data(state)(state, "delete", "test", { table: "todos", match: `id=eq.${id}` }); // cleanup
});

live("a write bumps sb.test.todos.rev (the realtime reactivity counter)", async () => {
  const state = await boot();
  const ids = [];
  const ins = async () => {
    const r = await data(state)(state, "insert", "test", { table: "todos", rows: { title: `rev-${Date.now()}` } });
    ids.push(r[0].id); return r;
  };
  await ins();
  const rev1 = Number(state.cels.get("sb.test.todos.rev")?.v);
  assert.ok(rev1 >= 1, "rev cel created + bumped on first write");
  await ins();
  const rev2 = Number(state.cels.get("sb.test.todos.rev")?.v);
  assert.equal(rev2, rev1 + 1, "rev increments per write");
  for (const id of ids) await data(state)(state, "delete", "test", { table: "todos", match: `id=eq.${id}` });
});

live("update mutates the row and returns the representation", async () => {
  const state = await boot();
  const r = await data(state)(state, "insert", "test", { table: "todos", rows: { title: `upd-${Date.now()}`, done: false } });
  const id = r[0].id;
  const upd = await data(state)(state, "update", "test", { table: "todos", match: `id=eq.${id}`, values: { done: true } });
  assert.ok(Array.isArray(upd));
  assert.equal(upd[0].done, true, "done flipped to true");
  await data(state)(state, "delete", "test", { table: "todos", match: `id=eq.${id}` });
});

live("RLS: anon (not signed in) cannot see another user's rows", async () => {
  const owner = await boot();                 // project "test", signed in
  const r = await data(owner)(owner, "insert", "test", { table: "todos", rows: { title: `rls-${Date.now()}` } });
  const id = r[0].id;

  // NOTE: the session store is PROCESS-GLOBAL (module-scope Map, by design — like
  // net/peer). So an anon client must use a project key nobody signed into;
  // reusing "test" would borrow the owner's token from the shared store.
  const anon = createInitialState();
  await resolveFn(anon, "ensureSegments")(anon, ["supabase"]);
  await resolveFn(anon, "setCel")(anon, "sb.anon.url", { celType: "ValueCel", v: URL_, metadata: { key: "sb.anon.url", segment: "app" } });
  await resolveFn(anon, "setCel")(anon, "sb.anon.anonkey", { celType: "ValueCel", v: ANON, metadata: { key: "sb.anon.anonkey", segment: "app" } });
  const rows = await data(anon)(anon, "select", "anon", { table: "todos", query: `select=id&id=eq.${id}` });
  assert.ok(Array.isArray(rows), `expected rows array, got: ${JSON.stringify(rows)}`);
  assert.equal(rows.length, 0, "RLS hides the row from a truly-anon client");

  await data(owner)(owner, "delete", "test", { table: "todos", match: `id=eq.${id}` }); // cleanup
});

test("missing config → graceful error string (no network)", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["supabase"]);
  const out = await resolveFn(state, "supabase.data")(state, "select", "nope", { table: "todos" });
  assert.equal(typeof out, "string");
  assert.match(out, /missing supabase config .* sb\.nope/);
});
