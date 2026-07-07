// e2e: 💬 Chatrooms — the appkit-rooms document (apps/docs/chatrooms.json).
// One workbook: LEFT the chatrooms recipe sheet (B1 the non-secret auth-status
// probe, B2/B3 the two =view formulas); RIGHT two view tabs — "rooms"
// (roomspane: the appkit conversations, click to go into chat) and "roomchat"
// (chatpane wired to the room cels). LOGIN + the supabase config live in the
// 👤 Profile doc (doc:identity — it defines sb.default; chatrooms depends on
// it). Signed out, every surface is gated (sign-in hint / login card) — that's
// what this drives headlessly.
// LIVE extras (appkit's local Supabase stack + CHATROOMS_EMAIL/PASSWORD in the
// env) sign in for real and expect actual room rows; absent, they WARN only.
//
//   bun e2e/chatrooms.mjs        (spawns its own dev server on :8897)
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 8897;
const originDir = new URL("..", import.meta.url).pathname;
const srv = spawn("bun", ["serve.ts"], { cwd: originDir, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://localhost:${PORT}/index.html`); if (r.ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

// the live extras' gate: appkit's local stack + credentials from the env
const E = (typeof Bun !== "undefined" ? Bun.env : process.env);
const SB_URL = "https://sdggffldxjmwlhlznvli.supabase.co";   // the usercfg default (identity doc)
const stackUp = await fetch(`${SB_URL}/auth/v1/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
const CREDS = E.CHATROOMS_EMAIL ? { email: E.CHATROOMS_EMAIL, password: E.CHATROOMS_PASSWORD ?? "" } : null;

let pass = 0, fail = 0, last;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); if (!c) console.log("      last:", JSON.stringify(last)?.slice(0, 260)); };
const warn = (w) => console.log(`  ⚠ ${w}`);

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1360, height: 880 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));

try {
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });
  await page.waitForTimeout(800);

  // 1) the doc is INSTALLED at boot and the 📂 picker lists it
  last = await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("ensureSegments")(s, ["segment-store"]);
    const entries = await F("store.list")(s);
    return entries.find((e) => e.name === "chatrooms") ?? null;
  });
  ok(!!last && !!last.app, "chatrooms is in the segment store with an app stamp (the 📂 picker's source)");

  // 2) open it the way the picker does (origin.opendoc) + settle
  await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("origin.opendoc")(s, "chatrooms");
    for (let i = 0; i < 6; i++) {
      await F("runCycle")(s);
      if (s.cels.get("genesis.commit")) await F("drain")(s, "genesis.commit");
      if (s.cels.get("origin.effects")) await F("drain")(s, "origin.effects");
    }
    await F("drain")(s, "dom.paint");
  });
  await page.waitForTimeout(900);

  last = await page.evaluate(() => globalThis.plastron.state.cels.get("win.chatrooms.state")?.v ?? null);
  ok(!!last && last.closed !== 1, "the chatrooms workbook opened (win.chatrooms.state live)");
  ok((last?.sheets ?? []).some((t) => /chatrooms/.test(String(t.ref))), "the recipe sheet is a worksheet tab on the left");
  const viewTitles = (last?.views ?? []).map((t) => t.title);
  ok(viewTitles.length === 2 && ["rooms", "roomchat"].every((n) => viewTitles.includes(n)),
    `TWO view tabs — rooms / roomchat; login lives in doc:identity (${JSON.stringify(viewTitles)})`);

  // 3) OWNERSHIP: sb.default belongs to the 👤 Profile doc — chatrooms neither
  //    defines it nor depends on it, so before Profile opens it is simply absent
  last = await page.evaluate(() => globalThis.plastron.state.cels.get("sb.default")?.v ?? null);
  ok(last === null, "sb.default is NOT defined by chatrooms (it lives in doc:identity)");
  // opening the Profile doc births it — and chatrooms' probe follows reactively
  await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("origin.opendoc")(s, "identity");
    for (let i = 0; i < 6; i++) { await F("runCycle")(s); if (s.cels.get("genesis.commit")) await F("drain")(s, "genesis.commit"); if (s.cels.get("origin.effects")) await F("drain")(s, "origin.effects"); }
    await F("drain")(s, "dom.paint");
  });
  await page.waitForTimeout(600);
  last = await page.evaluate(() => ({ sb: globalThis.plastron.state.cels.get("sb.default")?.v ?? null, url: globalThis.plastron.state.cels.get("usercfg.supabase_url")?.v ?? null }));
  ok(!!last.sb && /^https:/.test(String(last.sb.url)) && /^sb_publishable_/.test(String(last.sb.anonkey)),
    "opening 👤 Profile defined sb.default (the hosted supabase config)");
  ok(last.sb.url === last.url, "…derived from the usercfg kv sheet rows");
  // back to the chatrooms workbook for the gated-view checks
  await page.evaluate(async () => { const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k); await F("window.raise")(s, "win.chatrooms.state"); await F("drain")(s, "dom.paint"); });
  await page.waitForTimeout(300);

  // 4) signed out, each view is gated — click through the REAL tabs
  const tab = (name) => page.click(`.pl-wb-right .pl-wb-tab[data-tab="win.chatrooms.view.${name}"]`);
  await tab("rooms"); await page.waitForTimeout(400);
  last = await page.locator(".pl-wb-vbody .gk-rooms").innerText().catch(() => "");
  ok(/Sign in \(login view\)/.test(last), "rooms view: gated with the sign-in hint while signed out");
  await tab("roomchat"); await page.waitForTimeout(400);
  ok(await page.locator(".pl-wb-vbody .gk-login").count() === 1, "roomchat view: login-gated (the same signedIn cel gates both)");

  // 5) the recipe stays visible: B3 keeps its =view(chatpane(…)) formula, and
  //    B1 is the auth-status probe referencing the identity doc's sb.default
  last = await page.evaluate(() => globalThis.plastron.state.cels.get("chatrooms.B3")?.f ?? "");
  ok(/^=view\("roomchat", chatpane\(grok\.roomlog/.test(String(last)), "B3's chatpane formula IS the cell content (visible in the bar)");
  last = await page.evaluate(() => globalThis.plastron.state.cels.get("chatrooms.B1")?.f ?? "");
  ok(String(last) === "=sb.default.auth", "B1 probes the non-secret auth-status cel");

  // 6) LIVE extras — real sign-in + real rooms (warn-gated, never fail CI)
  if (!stackUp) warn("appkit local stack not running — live sign-in/rooms not exercised (supabase start in ~/projects/appkit)");
  else if (!CREDS) warn("no CHATROOMS_EMAIL/CHATROOMS_PASSWORD in env — live sign-in not exercised (gated assertions above still ran)");
  else {
    // sign in where login now lives: the 👤 Profile doc's 🔐 login view (opened above)
    await page.evaluate(async () => { const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k); await F("window.raise")(s, "win.identity.state"); await F("drain")(s, "dom.paint"); });
    await page.waitForTimeout(300);
    await page.click(`.pl-wb-right .pl-wb-tab[data-tab="win.identity.view.login"]`); await page.waitForTimeout(300);
    await page.fill(".pl-wb-vbody .gk-login input[type=email]", CREDS.email);
    await page.fill(".pl-wb-vbody .gk-login input[type=password]", CREDS.password);
    await page.click(".pl-wb-vbody .gk-login button:has-text('Sign in')");
    await page.waitForTimeout(2500);
    last = await page.evaluate(() => globalThis.plastron.state.cels.get("sb.default.auth")?.v ?? null);
    ok(last?.status === "signed-in", `LIVE: signed in as ${last?.email}`);
    ok(await page.locator(".pl-wb-vbody .gk-session").count() === 1, "LIVE: the login view flipped to the session card");
    // back to the chatrooms workbook — its gated views unlocked reactively
    await page.evaluate(async () => { const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k); await F("window.raise")(s, "win.chatrooms.state"); await F("drain")(s, "dom.paint"); });
    await page.waitForTimeout(300);
    await tab("rooms"); await page.waitForTimeout(600);
    const rows = await page.locator(".pl-wb-vbody .gk-room-row").count();
    ok(rows >= 1, `LIVE: ${rows} room row(s) listed (lounge at least)`);
    await page.locator(".pl-wb-vbody .gk-room-row").first().click();
    await page.waitForTimeout(1200);
    last = await page.evaluate(() => globalThis.plastron.state.cels.get("win.chatrooms.state")?.v?.aview ?? -1);
    ok(await page.locator(".pl-wb-vbody .gk-chat").count() === 1, "LIVE: picking a room focused the room chat (chatpane rendered)");
  }

  ok(errs.length === 0, `no page errors (${JSON.stringify(errs).slice(0, 200)})`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(`\nchatrooms e2e: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
