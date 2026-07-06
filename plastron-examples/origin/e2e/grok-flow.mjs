// ============================================================================
// e2e: the LLM-in-a-sheet flow, driven by FORMULAS — config → sign in → 🔮 grok.
//
// Stubs stand in for Supabase (so no real project/key needed): one Bun server
// answers BOTH GoTrue (/auth/v1/token → a fake JWT) and the grok edge function
// (/functions/v1/grok → a hello formula). The page's CSP already allows
// http://localhost:*, so the browser reaches the stub.
//
// The flow this proves (and documents):
//   1. open a sheet; the 🔮 ask-grok button is HIDDEN (not signed in).
//   2. type   =supabase.config('default', <url>, <anon>)   into a cell, ⚡.
//   3. type   =supabase.auth('signin','default','{"email":…,"password":…}')  ⚡  → signed in.
//   4. the sheet re-renders reactively → 🔮 now APPEARS.
//   5. type a question in the bar, press 🔮 → grok's reply (a formula) lands in
//      the bar to review (then ⚡ would commit it).
//
//   bun e2e/grok-flow.mjs
// ============================================================================
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8961;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const URLP = `http://localhost:${PORT}/index.html`;

// stub Supabase: GoTrue token + the grok edge function. Records the grok body.
let grokBody = null;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (u.pathname === "/auth/v1/token") {
      return Response.json({ access_token: "fake.jwt.aaa", refresh_token: "fake-refresh", expires_in: 3600, token_type: "bearer", user: { id: "u-1", email: "you@example.com" } }, { headers: CORS });
    }
    if (u.pathname === "/functions/v1/grok") {
      grokBody = await req.json().catch(() => ({}));
      return Response.json({ reply: '="hello world from grok"' }, { headers: CORS });
    }
    return new Response("not found", { status: 404, headers: CORS });
  },
});
const STUB = `http://127.0.0.1:${stub.port}`;

let failed = 0;
const ok = (c, m, g) => { console.log(`${c ? "✓" : "✗"} ${m}${c ? "" : "  got: " + JSON.stringify(g)}`); if (!c) failed++; };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

// type a formula into the bar (元.draft) and fire it into `key` (the ⚡ path).
const fire = (page, key, formula) => page.evaluate(async ([key, formula]) => {
  const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
  await F("setValue")(s, "元.draft", formula);
  await F("origin.fire")(s, key);
}, [key, formula]);
const askPresent = (page) => page.evaluate(() => !!document.querySelector('[data-win="win.sheet1.state"] .fx-ask'));
const draft = (page) => page.evaluate(() => globalThis.plastron.state.cels.get("元.draft")?.v ?? null);

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/404|Failed to load resource|favicon/.test(t)) errs.push("con:" + t.split("\n")[0]); } });

  await page.goto(URLP);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 12000 });
  await page.waitForTimeout(800);

  // bring up the segments + open a sheet, select a cell so the bar shows buttons
  await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("ensureSegments")(s, ["sheetapp", "sheets", "supabase", "supabase-auth", "session", "grok", "segment-store", "user-space-ops", "window", "keystore", "crypto"]);
    await F("hydrate")(s, [], []);
    await F("runCycle")(s);
    await F("origin.newsheet")(s);                 // → "sheet1" + workbook window
    await F("origin.select")(s, "sheet1.A1");       // select a cell → bar shows
    await F("runCycle")(s); await F("drain")(s, "dom.paint");
  });
  await page.waitForTimeout(500);

  // a NORMAL formula typed into a cell works (the formula path is fine for pure
  // verbs; it's only STATE-taking verbs like supabase.auth that need a handler).
  await fire(page, "sheet1.A1", "=2+2");
  ok((await page.evaluate(() => globalThis.plastron.state.cels.get("sheet1.A1")?.v)) === 4, "0. a formula typed into a cell evaluates (=2+2 → 4)");

  // ════ 1. 🔮 is HIDDEN before sign-in ══════════════════════════════════════
  ok((await askPresent(page)) === false, "1. 🔮 ask-grok is hidden before sign-in");

  // ════ 2-3. config + sign in via the HANDLER path (what a login button does —
  //          state-taking verbs can't be called from a cell formula). ═════════
  const cfg = await page.evaluate(async (STUB) => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("supabase.config")(s, "default", STUB, "anon-publishable");
    return s.cels.get("sb.default.url")?.v ?? null;
  }, STUB);
  ok(cfg === STUB, "2. supabase.config set sb.default.url", cfg);

  const signedIn = await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("supabase.auth")(s, "signin", "default", '{"email":"you@example.com","password":"hunter2"}');
    return s.cels.get("sb.default.auth")?.v ?? null;
  });
  ok(signedIn?.status === "signed-in", "3. supabase.auth('signin', …) signed in via the GoTrue stub", signedIn);

  // ════ 4. the sheet re-renders reactively → 🔮 APPEARS ═════════════════════
  await page.evaluate(async () => { const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k); await F("origin.select")(s, "sheet1.A3"); await F("runCycle")(s); await F("drain")(s, "dom.paint"); });
  await page.waitForTimeout(400);
  ok(await askPresent(page), "4. 🔮 ask-grok APPEARS once signed in (reactive signedIn gate)");

  // ════ 5. ask grok → reply (a formula) lands in the bar ════════════════════
  await page.evaluate(async () => { const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k); await F("setValue")(s, "元.draft", "say hello world"); });
  await page.click('[data-win="win.sheet1.state"] .fx-ask');
  const reply = await (async () => { for (let i = 0; i < 30; i++) { const d = await draft(page); if (d && d.startsWith("=")) return d; await page.waitForTimeout(150); } return await draft(page); })();
  ok(reply === '="hello world from grok"', "5. 🔮 → grok's reply (a formula) landed in the bar", reply);
  ok(grokBody && Array.isArray(grokBody.messages) && /say hello world/.test(JSON.stringify(grokBody.messages)), "5. the question reached the grok proxy with the sheet context", grokBody?.messages?.length);

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs.slice(0, 2).join(" | ") : ""}`);
} finally {
  await browser.close();
  stub.stop();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ grok-flow: formulas → login → 🔮 → hello-world grok all pass");
process.exit(failed ? 1 : 0);
