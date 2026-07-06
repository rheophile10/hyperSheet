// e2e: 💬 Chatrooms — the appkit-rooms document (apps/docs/chatrooms.json).
// One workbook: LEFT the chatrooms recipe sheet (B1 the public-config dict →
// derived sb.default, B2/B3/B4 the three =view formulas); RIGHT three view
// tabs — "login" (loginpane: sign in to get the token / session card),
// "rooms" (roomspane: the appkit conversations, click to go into chat) and
// "roomchat" (chatpane wired to the room cels). Signed out, every surface is
// gated (login card / sign-in hint) — that's what this drives headlessly.
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
const APPKIT_URL = "http://127.0.0.1:54341";
const stackUp = await fetch(`${APPKIT_URL}/auth/v1/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false);
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
  ok(viewTitles.length === 3 && ["login", "rooms", "roomchat"].every((n) => viewTitles.includes(n)),
    `THREE view tabs — login / rooms / roomchat (${JSON.stringify(viewTitles)})`);

  // 3) the derived config: sb.default ← =chatrooms.B1 (the ONE dict cell)
  last = await page.evaluate(() => globalThis.plastron.state.cels.get("sb.default")?.v ?? null);
  ok(!!last && last.url === "http://127.0.0.1:54341" && /^sb_publishable_/.test(String(last.anonkey)),
    "sb.default derives the appkit config from the visible B1 dict");

  // 4) signed out, each view is gated — click through the REAL tabs
  const tab = (name) => page.click(`.pl-wb-right .pl-wb-tab[data-tab="win.chatrooms.view.${name}"]`);
  await tab("login"); await page.waitForTimeout(400);
  ok(await page.locator(".pl-wb-vbody .gk-login").count() === 1, "login view: the appkit login card (email/password/Sign in)");
  await tab("rooms"); await page.waitForTimeout(400);
  last = await page.locator(".pl-wb-vbody .gk-rooms").innerText().catch(() => "");
  ok(/Sign in \(login view\)/.test(last), "rooms view: gated with the sign-in hint while signed out");
  await tab("roomchat"); await page.waitForTimeout(400);
  ok(await page.locator(".pl-wb-vbody .gk-login").count() === 1, "roomchat view: login-gated too (same signedIn cel gates all three)");

  // 5) the recipe stays visible: B4 keeps its =view(chatpane(…)) formula
  last = await page.evaluate(() => globalThis.plastron.state.cels.get("chatrooms.B4")?.f ?? "");
  ok(/^=view\("roomchat", chatpane\(grok\.roomlog/.test(String(last)), "B4's chatpane formula IS the cell content (visible in the bar)");

  // 6) LIVE extras — real sign-in + real rooms (warn-gated, never fail CI)
  if (!stackUp) warn("appkit local stack not running — live sign-in/rooms not exercised (supabase start in ~/projects/appkit)");
  else if (!CREDS) warn("no CHATROOMS_EMAIL/CHATROOMS_PASSWORD in env — live sign-in not exercised (gated assertions above still ran)");
  else {
    await tab("login"); await page.waitForTimeout(300);
    await page.fill(".pl-wb-vbody .gk-login input[type=email]", CREDS.email);
    await page.fill(".pl-wb-vbody .gk-login input[type=password]", CREDS.password);
    await page.click(".pl-wb-vbody .gk-login button:has-text('Sign in')");
    await page.waitForTimeout(2500);
    last = await page.evaluate(() => globalThis.plastron.state.cels.get("sb.default.auth")?.v ?? null);
    ok(last?.status === "signed-in", `LIVE: signed in as ${last?.email}`);
    ok(await page.locator(".pl-wb-vbody .gk-session").count() === 1, "LIVE: the login view flipped to the session card");
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
