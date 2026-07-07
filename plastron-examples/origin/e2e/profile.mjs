// e2e: 👤 Profile — the identity sheetapp document (apps/docs/identity.json;
// the old app:profileapp origin-application is retired). Three =view panes:
// ⚙ config (the usercfg kv sheet — the persistent user key-value surface;
// sb.default DERIVES from its supabase rows), 🔐 login (loginpane →
// grok.signin; tokens land in the session store behind a SecretHandle, never
// a cel — once the wallet is unlocked the refresh token persists as a
// wallet-wrapped OPFS sidecar), and 👤 wallet (profileui over keystore). This
// drives the CONFIG kv sheet + the WALLET through real browser events in a
// fresh context (clean OPFS → keystore.status 'none').
//
//   bun e2e/profile.mjs        (spawns its own dev server on :8967)
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 8967;
const originDir = new URL("..", import.meta.url).pathname;
const srv = spawn("bun", ["serve.ts"], { cwd: originDir, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://localhost:${PORT}/index.html`); if (r.ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const errs = []; p.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));

let pass = 0, fail = 0; const ok = (c, w, g) => { if (c) { pass++; console.log("  ✔", w); } else { fail++; console.log("  ✘", w, "got:", JSON.stringify(g)?.slice(0, 200)); } };
const ks = (k) => p.evaluate((kk) => globalThis.plastron.state.cels.get(kk)?.v ?? null, k);

await p.goto(`http://localhost:${PORT}/index.html`);
await p.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });
await p.waitForTimeout(1200);

// fresh context → no wallet
ok((await ks("keystore.status")) === "none", "fresh context starts with no wallet (status none)", await ks("keystore.status"));
ok(await p.$('button.pl-desk-icon:has-text("Profile")'), "👤 Profile desktop icon present");

// open via origin.opendoc — what the 👤 Profile icon (doc:identity) dispatches
await p.evaluate(async () => { const { state, resolveFn } = globalThis.plastron; await resolveFn(state, "origin.opendoc")(state, "identity"); });
await p.waitForTimeout(1200);

let last = await p.evaluate(() => globalThis.plastron.state.cels.get("win.identity.state")?.v ?? null);
ok(!!last && last.closed !== 1, "the identity workbook opened", last);
const vt = (last?.views ?? []).map((t) => t.title);
ok(vt.length === 3 && /config/.test(vt[0]) && /login/.test(vt[1]) && /wallet/.test(vt[2]), `config + login + wallet =view panes grew (${JSON.stringify(vt)})`);

// sb.default DERIVES from the usercfg kv rows (the chat-app-expected names)
last = await p.evaluate(() => ({
  sb: globalThis.plastron.state.cels.get("sb.default")?.v,
  url: globalThis.plastron.state.cels.get("usercfg.supabase_url")?.v,
  key: globalThis.plastron.state.cels.get("usercfg.supabase_anonkey")?.v,
}));
ok(!!last.sb?.url && last.sb.url === last.url && last.sb.anonkey === last.key, "sb.default = {url, anonkey} derived from the usercfg kv rows");

// the ⚙ config kv sheet: seeded rows + the composer ADDS a new key for real
await p.click("text=⚙ config");
await p.waitForTimeout(400);
ok(await p.evaluate(() => document.querySelectorAll(".pl-wb-right #config .kv-row").length) === 2, "the kv sheet lists the seeded config rows");
await p.fill(".pl-wb-right #config .kv-name", "greeting");
await p.fill(".pl-wb-right #config .kv-value", "hello");
await p.click(".pl-wb-right #config .kv-add");
await p.waitForTimeout(600);
last = await p.evaluate(() => ({ v: globalThis.plastron.state.cels.get("usercfg.greeting")?.v ?? null, keys: globalThis.plastron.state.cels.get("usercfg.keys")?.v }));
ok(last.v === "hello" && last.keys?.includes("greeting"), `the composer minted a NEW usercfg key (${JSON.stringify(last)})`);

// the login pane renders the signed-out card
await p.click("text=🔐 login");
await p.waitForTimeout(400);
ok(await p.$(".pl-wb-right #login input"), "login card renders inputs (signed out)");

// the wallet pane: create an identity through real browser events
await p.click("text=👤 wallet");
await p.waitForTimeout(400);
ok(await p.$(".pl-wb-right #wallet .profile-app"), "profileui rendered in the wallet pane");
await p.fill('.pl-wb-right #wallet input[placeholder="Ada Lovelace"]', "Grace");
await p.fill('.pl-wb-right #wallet input[placeholder="passcode"]', "hunter2!");
await p.fill('.pl-wb-right #wallet input[placeholder="confirm passcode"]', "hunter2!");
await p.click('.pl-wb-right #wallet button.pf-btn:has-text("Create identity")');
await p.waitForTimeout(800);

ok((await ks("keystore.status")) === "unlocked", "Create minted + unlocked the wallet", await ks("keystore.status"));
ok((await ks("keystore.name")) === "Grace", "display name stored", await ks("keystore.name"));
ok(((await ks("keystore.identity")) || "").length > 20, "public identity surfaced (a cel — public keys only)");
ok(((await ks("profile.phrase")) || "").split(" ").length === 12, "a 12-word recovery phrase was revealed", await ks("profile.phrase"));
ok(await p.evaluate(() => /Reshuffle|Lock/.test(document.querySelector(".pl-wb-right #wallet")?.textContent || "")), "unlocked controls (Reshuffle/Lock) render after create");

// the secrecy contract: no private key or token in ANY cel
last = await p.evaluate(() => {
  const hits = [];
  for (const [k, c] of globalThis.plastron.state.cels) {
    const s = JSON.stringify(c.v ?? "");
    if (/ecdhPriv|signPriv|access_token|refresh_token/.test(s)) hits.push(k);
  }
  return hits;
});
ok(Array.isArray(last) && last.length === 0, "no cel anywhere holds private-key or token material", last);

ok(errs.filter((e) => !/reading 'get'/.test(e)).length === 0, "no page errors", errs.slice(0, 3));
console.log(`\n${fail === 0 ? "✅" : "❌"} profile e2e: ${pass} passed, ${fail} failed`);
await b.close();
srv.kill();
process.exit(fail === 0 ? 0 : 1);
