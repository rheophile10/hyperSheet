import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// session — the service-agnostic token store (the home the removed `vault` left
// open). It holds live tokens in module scope and mints SecretHandles over them.
// Contract exercised here (CLI tier — session-only persistence, no browser):
//   1. put → handle resolves the access token IN-SESSION.
//   2. the reactive session.<name>.status cel flips active → none.
//   3. peek mirrors the status without ever returning the token.
//   4. THE INVARIANT: the access token never lands in a cel value or in a
//      dehydrated archive — a stored handle persists as NAME-ONLY.

const mk = (name, dependencies = []) => ({ name, version: "0.0.1", description: "test", dependencies });

const boot = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["session"]);
  return state;
};

const JWT = "eyJhbG.SUPER-SECRET-ACCESS-TOKEN.sig";

test("session seeds its verbs", async () => {
  const state = await boot();
  for (const k of ["session.put", "session.handle", "session.peek", "session.forget"]) {
    assert.ok(state.cels.get(k), `${k} cel missing`);
  }
});

test("put → handle resolves the access token in-session; handle is a SecretHandle", async () => {
  const state = await boot();
  const put = resolveFn(state, "session.put");
  const handle = resolveFn(state, "session.handle");

  await put(state, "supabase", { access: JWT, refresh: "refresh-xyz", exp: 1893456000, meta: { email: "a@b.ca" } });

  const h = handle(state, "supabase");
  assert.equal(h.__secretHandle, true);
  assert.equal(h.name, "session.supabase");
  assert.equal(typeof h.resolve, "function");
  assert.equal(h.resolve(), JWT, "handle resolves the live access token");
});

test("put accepts a JSON string too", async () => {
  const state = await boot();
  const put = resolveFn(state, "session.put");
  const handle = resolveFn(state, "session.handle");
  await put(state, "svc2", JSON.stringify({ access: "tok2" }));
  assert.equal(handle(state, "svc2").resolve(), "tok2");
});

test("put rejects tokens with no access string", async () => {
  const state = await boot();
  const put = resolveFn(state, "session.put");
  await assert.rejects(() => put(state, "bad", { refresh: "only" }), /access .* required/);
});

test("the session.<name>.status cel reflects active → none reactively", async () => {
  const state = await boot();
  const put = resolveFn(state, "session.put");
  const forget = resolveFn(state, "session.forget");

  await put(state, "supabase", { access: JWT, exp: 1893456000, meta: { email: "a@b.ca" } });
  const active = state.cels.get("session.supabase.status")?.v;
  assert.equal(active?.status, "active");
  assert.equal(active?.exp, 1893456000);
  assert.deepEqual(active?.meta, { email: "a@b.ca" });
  // the status carries NO token
  assert.equal(JSON.stringify(active).includes(JWT), false, "status cel must not carry the token");

  await forget(state, "supabase");
  assert.equal(state.cels.get("session.supabase.status")?.v?.status, "none");
  // handle now resolves to nothing
  assert.equal(resolveFn(state, "session.handle")(state, "supabase").resolve(), undefined);
});

test("peek returns a non-secret snapshot, never the token", async () => {
  const state = await boot();
  const put = resolveFn(state, "session.put");
  const peek = resolveFn(state, "session.peek");
  assert.deepEqual(peek(state, "none-yet"), { status: "none" });
  await put(state, "svc3", { access: "secret-tok", refresh: "r", exp: 42 });
  const snap = peek(state, "svc3");
  assert.equal(snap.status, "active");
  assert.equal(snap.hasRefresh, true);
  assert.equal(snap.exp, 42);
  assert.equal(JSON.stringify(snap).includes("secret-tok"), false);
});

test("INVARIANT: a stored handle dehydrates to NAME-ONLY — the token never enters the archive", async () => {
  const state = await boot();
  const put = resolveFn(state, "session.put");
  const handle = resolveFn(state, "session.handle");

  // an app segment holds the handle in one of its cels (as supabase-auth will)
  await resolveFn(state, "hydrate")(state, [{
    name: "app",
    cels: [{ key: "app.token", celType: "ValueCel", metadata: { key: "app.token", segment: "app", v: null } }],
  }], [mk("app")]);

  await put(state, "supabase", { access: JWT });
  await resolveFn(state, "setValue")(state, "app.token", handle(state, "supabase"));

  // in memory the cel carries a live handle that CAN resolve…
  assert.equal(state.cels.get("app.token")?.v?.resolve?.(), JWT);

  // …but a dehydrated archive carries neither the token nor the resolver.
  const archive = JSON.parse(JSON.stringify(await resolveFn(state, "dehydrate")(state)));
  const flat = JSON.stringify(archive);
  assert.equal(flat.includes(JWT), false, "the access token must NOT appear in the archive");

  const cel = archive.segments.find((s) => s.name === "app").cels.find((c) => c.key === "app.token");
  const persisted = cel.metadata.v;
  assert.equal(persisted.__secretHandle, true, "persists as a SecretHandle ref");
  assert.equal(persisted.name, "session.supabase", "name only");
  assert.equal(persisted.resolve, undefined, "no resolver persisted");
  assert.deepEqual(Object.keys(persisted).sort(), ["__secretHandle", "name"], "ONLY the marker + name persist");
});
