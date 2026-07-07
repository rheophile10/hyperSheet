import { test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// session persistence (session-token-persistence.md): once the wallet is
// unlocked, session.put ALSO writes a wallet-wrapped REFRESH-token sidecar to
// /plastron/session/<name>.tok (never the access token, never plaintext);
// session.forget deletes it; session.restore unwraps the sidecars back into
// the module Map after keystore.unlock, and profile.unlock fans each restored
// supabase.<p> name out to supabase.auth's refresh op — unlocking the wallet
// IS logging in to plastron.

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-session-persist";
const { createInitialState, precomputeOptional, resolveFn } = await import("../dist/index.js");

const root = createInitialState().cels.get("file-store.root").v;
const sideDir = path.resolve(root, "plastron", "session");
beforeEach(async () => { await fs.rm(sideDir, { recursive: true, force: true }); });

const boot = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["keystore", "session", "file-store", "crypto", "profile", "dom"]);
  await resolveFn(s, "hydrate")(s, [], []);
  await precomputeOptional(s);
  await resolveFn(s, "runCycle")(s);
  return s;
};
const R = (s, k) => resolveFn(s, k);

test("session.put persists a wallet-wrapped refresh sidecar; forget deletes it; restore brings it back", async () => {
  const s = await boot();
  await R(s, "keystore.create")(s, "hunter2!", "Ada");

  await R(s, "session.put")(s, "supabase.t1", { access: "ACCESS-1", refresh: "REFRESH-1", meta: { email: "a@x" } });
  const sidecar = await fs.readFile(path.join(sideDir, "supabase.t1.tok"), "utf8");
  const sc = JSON.parse(sidecar);
  assert.equal(sc.name, "supabase.t1", "sidecar written on put (wallet unlocked)");
  assert.ok(sc.env?.includes(".") && sc.pub?.length > 20, "sidecar holds the ECDH envelope + the wrapping pub");
  assert.ok(!/REFRESH-1|ACCESS-1/.test(sidecar), "neither token appears in plaintext on disk");

  // simulate a reload: the module Map forgets, the DISK keeps the sidecar.
  // (session.forget also deletes the sidecar — a sign-out is a sign-out — so
  // stash the file, forget, put it back.)
  const stash = sidecar;
  await R(s, "session.forget")(s, "supabase.t1");
  await fs.access(path.join(sideDir, "supabase.t1.tok")).then(() => { throw new Error("sidecar survived forget"); }, () => {});
  await fs.mkdir(sideDir, { recursive: true });
  await fs.writeFile(path.join(sideDir, "supabase.t1.tok"), stash);

  const restored = await R(s, "session.restore")(s);
  assert.deepEqual(restored, ["supabase.t1"], "restore unwrapped the sidecar");
  assert.equal(R(s, "session.handle")(s, "supabase.t1", "refresh").resolve(), "REFRESH-1", "the refresh token is back behind its handle");
  assert.equal(R(s, "session.handle")(s, "supabase.t1").resolve(), "", "no ACCESS claim — the provider's refresh op re-mints it");

  // a second restore is a no-op for a live name
  assert.deepEqual(await R(s, "session.restore")(s), [], "restore skips names already live in the Map");
});

test("no wallet (locked) → session-only: put writes no sidecar; unlock + session.persist backfills", async () => {
  const s = await boot();
  await R(s, "keystore.create")(s, "hunter2!", "Ada");
  await R(s, "keystore.lock")(s);

  await R(s, "session.put")(s, "supabase.t2", { access: "A", refresh: "R2" });
  await fs.access(path.join(sideDir, "supabase.t2.tok")).then(() => { throw new Error("sidecar written while locked"); }, () => {});

  await R(s, "keystore.unlock")(s, "hunter2!");
  const persisted = await R(s, "session.persist")(s);
  assert.ok(persisted.includes("supabase.t2"), "persist backfills the live session's sidecar after unlock");
  const sc = JSON.parse(await fs.readFile(path.join(sideDir, "supabase.t2.tok"), "utf8"));
  assert.equal(sc.name, "supabase.t2");
  await R(s, "session.forget")(s, "supabase.t2");
});

test("profile.unlock restores sessions and fans out to the REAL supabase.auth refresh op", async () => {
  // a tiny GoTrue stub: grant_type=refresh_token → fresh tokens
  const hits = [];
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      hits.push(`${u.pathname}?${u.searchParams.get("grant_type")}`);
      return Response.json({ access_token: "FRESH", refresh_token: "R-ROTATED", expires_in: 3600, user: { id: "u1", email: "g@x" } });
    },
  });
  try {
    const s = await boot();
    await R(s, "keystore.create")(s, "hunter2!", "Grace");
    await R(s, "setCel")(s, "sb.t3", { celType: "ValueCel", v: { url: `http://localhost:${srv.port}`, anonkey: "anon" }, metadata: { key: "sb.t3", segment: "usercfg", name: "sb.t3" } });
    await R(s, "session.put")(s, "supabase.t3", { access: "OLD", refresh: "R-DEF" });

    // simulate the reload: drop the live entry, keep the sidecar (stash/restore)
    const p = path.join(sideDir, "supabase.t3.tok");
    const stash = await fs.readFile(p, "utf8");
    await R(s, "session.forget")(s, "supabase.t3");
    await fs.mkdir(sideDir, { recursive: true });
    await fs.writeFile(p, stash);
    await R(s, "keystore.lock")(s);

    await R(s, "setValue")(s, "profile.p1", "hunter2!");
    await R(s, "profile.unlock")(s);

    assert.deepEqual(hits, ["/auth/v1/token?refresh_token"], "unlock fanned the restored name out to the provider's refresh endpoint");
    assert.equal(R(s, "session.handle")(s, "supabase.t3").resolve(), "FRESH", "the access token was re-minted through the refresh op");
    assert.equal(R(s, "session.handle")(s, "supabase.t3", "refresh").resolve(), "R-ROTATED", "the rotated refresh token replaced the old one (and re-persisted)");
    assert.equal(s.cels.get("sb.t3.auth")?.v?.status, "signed-in", "the non-secret auth cel flipped — gated views unlock");
    assert.match(String(s.cels.get("profile.msg")?.v ?? ""), /Unlocked\. 1 session restored\./, "the wallet message reports the restored session");
    await R(s, "session.forget")(s, "supabase.t3");
  } finally { srv.stop(true); }
});
