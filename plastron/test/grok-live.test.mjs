import { test } from "bun:test";
import assert from "node:assert/strict";

// grok-live — REAL round-trips against appkit's running LOCAL Supabase stack
// (docker `supabase_*_appkit`, http://127.0.0.1:54341), configured the new way:
// ONE sb.default DICT cel {url, anonkey}. The key is the Supabase CLI's shared
// local PUBLISHABLE key (sb_publishable_… — it ships in appkit's client source;
// browser-safe by design). No provider key is touched and nothing is written to
// appkit's DB: we assert the CLEAN ERROR SURFACES — a real GoTrue sign-in
// rejection and the functions gateway's 401 — which is exactly what the chat
// card shows before Ian signs in with real credentials.
//
// The whole file SKIPS when the stack isn't running (CI safety).

const APPKIT_URL = "http://127.0.0.1:54341";
const APPKIT_KEY = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";

const stackUp = await fetch(`${APPKIT_URL}/auth/v1/health`, { signal: AbortSignal.timeout(1500) })
  .then((r) => r.ok).catch(() => false);

const { createInitialState, precomputeOptional, resolveFn } = await import("../dist/index.js");

const boot = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["grok", "supabase", "supabase-auth", "session", "sheets"]);
  await resolveFn(s, "hydrate")(s, [], []);
  await precomputeOptional(s);
  await resolveFn(s, "runCycle")(s);
  // the appkit project as ONE dict cel — the form chatdoc.json ships
  await resolveFn(s, "setCel")(s, "sb.default", {
    celType: "ValueCel", v: { url: APPKIT_URL, anonkey: APPKIT_KEY },
    metadata: { key: "sb.default", segment: "supabase", name: "default" },
  });
  return s;
};
const F = (s, k) => resolveFn(s, k);
const v = (s, k) => s.cels.get(k)?.v;

test.skipIf(!stackUp)("a real GoTrue sign-in rejection surfaces cleanly on the card (dict config, live auth)", async () => {
  const s = await boot();
  await F(s, "grok.field")(s, "grok.email", { target: { value: "plastron-nobody@test.local" } });
  await F(s, "grok.field")(s, "grok.password", { target: { value: "definitely-wrong" } });
  await F(s, "grok.signin")(s, "default");
  // the dict → two-cel bridge fed supabase-auth, which really hit the local GoTrue
  assert.equal(v(s, "sb.default.url"), APPKIT_URL, "the dict config drove the live call");
  const auth = v(s, "sb.default.auth");
  assert.equal(auth?.status, "error", "GoTrue rejected the bogus credentials");
  assert.match(String(v(s, "grok.status")), /^✗/, "the card status shows the clean failure");
  // the card stays on the login gate
  const pane = JSON.stringify(F(s, "chatpane")([], "", { project: "default", authed: false, status: v(s, "grok.status") }));
  assert.match(pane, /gk-login/, "still the login card");
  assert.match(pane, /✗/, "…with the error line rendered");
});

test.skipIf(!stackUp)("the functions gateway 401s an unauthenticated grok call — the clean pre-login surface", async () => {
  const s = await boot();
  const r = await F(s, "supabase.invoke")(s, "default", "grok", { messages: [{ role: "user", content: "hi" }] });
  assert.match(String(r.error ?? ""), /HTTP 4\d\d/, `unauthenticated invoke is a clean {error}: ${JSON.stringify(r).slice(0, 120)}`);
});

test.skipIf(!stackUp)("grok.send against the live stack lands the error as an assistant bubble, not a throw", async () => {
  const s = await boot();
  await F(s, "grok.field")(s, "grok.question", { target: { value: "hello live stack" } });
  await F(s, "grok.send")(s, "default");
  const t = v(s, "grok.transcript") ?? [];
  assert.equal(t[0]?.role, "user");
  const last = t.at(-1);
  assert.equal(last?.role, "assistant");
  assert.ok(last?.error, "the failure is marked");
  assert.match(String(last?.text ?? ""), /error:/, "…and reads as a clean error bubble in the transcript");
});
