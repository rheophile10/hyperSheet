import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createInitialState, resolveFn } from "../dist/index.js";

// supabase-auth — GoTrue provider on top of the session store. These are LIVE
// integration tests against the dedicated local Supabase stack in
// test/supabase-test/ (captcha-free; `supabase start` + `./setup.sh`). If the
// stack isn't reachable, the live tests SKIP (so the suite stays green offline);
// the config-error test always runs (no network).
//
// Contract: sign-in puts the JWT in the SESSION store (never a cel value / never
// an archive) and flips the non-secret sb.<proj>.auth cel; refresh rotates;
// sign-out clears.

const cfg = JSON.parse(readFileSync(new URL("./supabase-test/test-config.json", import.meta.url)));
const URL_ = process.env.SUPABASE_TEST_URL ?? cfg.url;
const ANON = process.env.SUPABASE_TEST_ANON_KEY ?? cfg.anonKey;
const EMAIL = process.env.SUPABASE_TEST_EMAIL ?? cfg.testEmail;
const PASS = process.env.SUPABASE_TEST_PASSWORD ?? cfg.testPassword;

let reachable = false;
try { await fetch(`${URL_}/auth/v1/health`); reachable = true; } catch { /* stack down */ }
const live = reachable ? test : test.skip;
if (!reachable) console.warn(`[supabase-auth] local stack ${URL_} unreachable — skipping live tests`);

const boot = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["supabase-auth"]);
  // seed the PUBLIC config cels, as a genesis verb / the user would
  await resolveFn(state, "setCel")(state, "sb.test.url", { celType: "ValueCel", v: URL_, metadata: { key: "sb.test.url", segment: "app" } });
  await resolveFn(state, "setCel")(state, "sb.test.anonkey", { celType: "ValueCel", v: ANON, metadata: { key: "sb.test.anonkey", segment: "app" } });
  return state;
};

const accessOf = (state) => resolveFn(state, "session.handle")(state, "supabase.test").resolve();

test("ensureSegments pulls in the session dependency + seeds supabase.auth", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["supabase-auth"]);
  assert.ok(state.cels.get("supabase.auth"), "supabase.auth verb seeded");
  assert.ok(state.cels.get("session.put"), "session dependency auto-loaded");
});

test("missing config cels → graceful error, no network", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["supabase-auth"]);
  const msg = await resolveFn(state, "supabase.auth")(state, "signin", "nope", { email: "x", password: "y" });
  assert.match(msg, /missing sb\.nope\.url/);
});

live("password sign-in → token in session, sb.test.auth = signed-in", async () => {
  const state = await boot();
  const msg = await resolveFn(state, "supabase.auth")(state, "signin", "test", { email: EMAIL, password: PASS });
  assert.match(msg, /signed in/, msg);
  const a = state.cels.get("sb.test.auth")?.v;
  assert.equal(a.status, "signed-in");
  assert.equal(a.email, EMAIL);
  assert.ok(a.userId, "userId surfaced");
  const token = accessOf(state);
  assert.ok(typeof token === "string" && token.length > 20, "access token resolvable from the session store");
});

live("THE INVARIANT: the JWT never lands in a cel value or a dehydrated archive", async () => {
  const state = await boot();
  await resolveFn(state, "supabase.auth")(state, "signin", "test", { email: EMAIL, password: PASS });
  const token = accessOf(state);
  assert.ok(token, "have a token to look for");

  for (const [k, cel] of state.cels) {
    let v;
    try { v = JSON.stringify(cel.v ?? null); } catch { continue; } // skip unserializable cel values
    if (typeof v !== "string") continue; // function-valued cels (lambdas) stringify to undefined
    assert.equal(v.includes(token), false, `cel "${k}" leaks the access token`);
  }
  const archive = JSON.parse(JSON.stringify(await resolveFn(state, "dehydrate")(state)));
  assert.equal(JSON.stringify(archive).includes(token), false, "the archive leaks the access token");
});

live("refresh rotates the access token; stays signed-in", async () => {
  const state = await boot();
  const auth = resolveFn(state, "supabase.auth");
  await auth(state, "signin", "test", { email: EMAIL, password: PASS });
  const t1 = accessOf(state);
  await new Promise((r) => setTimeout(r, 1100)); // JWT iat is per-second → ensure a distinct token
  const msg = await auth(state, "refresh", "test");
  assert.match(msg, /refreshed/, msg);
  const t2 = accessOf(state);
  assert.ok(typeof t2 === "string" && t2.length > 20, "refreshed token present");
  assert.notEqual(t2, t1, "access token actually rotated");
  assert.equal(state.cels.get("sb.test.auth")?.v?.status, "signed-in");
});

live("sign-out clears the session + flips sb.test.auth to signed-out", async () => {
  const state = await boot();
  const auth = resolveFn(state, "supabase.auth");
  await auth(state, "signin", "test", { email: EMAIL, password: PASS });
  assert.ok(accessOf(state), "signed in first");
  await auth(state, "signout", "test");
  assert.equal(state.cels.get("sb.test.auth")?.v?.status, "signed-out");
  assert.equal(accessOf(state), undefined, "token gone from the session store");
});

live("wrong password → error status, no token stored", async () => {
  const state = await boot();
  const msg = await resolveFn(state, "supabase.auth")(state, "signin", "test", { email: EMAIL, password: "definitely-wrong" });
  assert.match(msg, /failed/i, msg);
  assert.equal(state.cels.get("sb.test.auth")?.v?.status, "error");
  assert.equal(accessOf(state), undefined, "no token stored on failure");
});
