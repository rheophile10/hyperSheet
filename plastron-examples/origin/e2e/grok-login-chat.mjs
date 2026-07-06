// ============================================================================
// e2e: a SLICK LOGIN + GROK CHAT card, built entirely from dom() FORMULAS, living
// in a workbook's cardBook (the dom-view pane). Proves the whole flow:
//   1. a card in the cardBook renders a slick login screen authored as dom formulas
//      (header, email/password inputs, a Log-in button) — no app-specific chrome;
//   2. typing into the inputs captures into cels (grok.field) and the Log-in button
//      signs in via Supabase auth (grok.signin → supabase.auth) → status flips;
//   3. a question + Send runs grok.fetch — a LAMBDA that does a fetch to the URL in
//      the grok.url cel (seeded from a gitignored .env), authorised with the user's
//      Supabase JWT — and the assistant's reply renders back in the card.
//
// Config: with a gitignored e2e/.env.local present (CCFR_URL / CCFR_EMAIL / …) the
// test hits that REAL project; otherwise it runs against an in-process stub server
// (GoTrue token + a grok endpoint) so it needs NO real project or key.
//
//   bun e2e/grok-login-chat.mjs
// ============================================================================
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8983;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const URLP = `http://localhost:${PORT}/index.html`;

// ── config: real project from .env.local, or the in-process stub ────────────
const E = (typeof Bun !== "undefined" ? Bun.env : process.env);
const REAL = E.CCFR_URL && E.CCFR_EMAIL
  ? { url: E.CCFR_URL.replace(/\/+$/, ""), anon: E.CCFR_ANONKEY ?? "", project: E.CCFR_PROJECT ?? "ccfr",
      email: E.CCFR_EMAIL, password: E.CCFR_PASSWORD ?? "", grokUrl: E.GROK_CHAT_URL ?? `${E.CCFR_URL.replace(/\/+$/, "")}/functions/v1/grok` }
  : null;

let stub = null, lastGrok = null;
if (!REAL) {
  const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
      if (u.pathname === "/auth/v1/token") {
        return Response.json({ access_token: "fake.jwt.zzz", refresh_token: "fake-refresh", expires_in: 3600, token_type: "bearer", user: { id: "u-9", email: "you@example.com" } }, { headers: CORS });
      }
      if (u.pathname === "/functions/v1/grok") {
        const auth = req.headers.get("authorization") || "";
        const body = await req.json().catch(() => ({}));
        lastGrok = { auth, body };
        const q = String(body?.messages?.find?.((m) => m.role === "user")?.content ?? "").slice(0, 40);
        return Response.json({ reply: `grok says: I heard "${q}"` }, { headers: CORS });
      }
      return new Response("not found", { status: 404, headers: CORS });
    },
  });
}
const cfg = REAL ?? { url: `http://127.0.0.1:${stub.port}`, anon: "stub-anon-key", project: "demo",
  email: "you@example.com", password: "hunter2", grokUrl: `http://127.0.0.1:${stub.port}/functions/v1/grok` };
console.log(REAL ? `→ REAL project (${cfg.url}) from .env.local` : `→ in-process stub (${cfg.url})`);
// the card itself is rendered by grok.ui (slick, inline-styled) and mounted into
// the cardBook by =chatcard(...) — no test-injected markup or CSS.

let failed = 0;
const ok = (c, m, g) => { console.log(`${c ? "✓" : "✗"} ${m}${c ? "" : "  got: " + JSON.stringify(g)}`); if (!c) failed++; };
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  await page.goto(URLP);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 12000 });
  await page.waitForTimeout(600);

  // open a sheet, then drive the WHOLE setup with two FORMULAS — exactly the
  // hand-off a user pastes into a sheet:
  //   =grokconfig(project, url, anonkey, endpoint)   — loads segments + seeds config
  //   =chatcard(project)                              — drops the card into the cardBook
  await page.evaluate(async ([cfg]) => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("ensureSegments")(s, ["origin", "sheetapp", "sheets", "window", "dom"]);
    await F("hydrate")(s, [], []); await F("runCycle")(s);
    await F("origin.newsheet")(s); await F("window.raise")(s, "win.sheet1.state");
    await F("setValue")(s, "元.draft", `=grokconfig('${cfg.project}', '${cfg.url}', '${cfg.anon}', '${cfg.grokUrl}')`);
    await F("origin.fire")(s, "sheet1.A1");
    await F("runCycle")(s);
    await F("setValue")(s, "元.draft", `=chatcard('${cfg.project}')`);
    await F("origin.fire")(s, "sheet1.A2");
    for (let i = 0; i < 3; i++) { await F("view.refresh")(s); await F("runCycle")(s); await F("drain")(s, "dom.paint"); }
  }, [cfg]);
  ok(await page.evaluate((p) => globalThis.plastron.state.cels.get(`sb.${p}.url`)?.v?.length > 0
    && globalThis.plastron.state.cels.get("grok.url")?.v?.length > 0, cfg.project), "=grokconfig(...) formula seeded the backend config cels (formula-only setup)");
  await page.waitForSelector(".pl-wb-right .gk-status", { timeout: 8000 });
  await page.waitForTimeout(300);

  // ── 1. the slick login card lives in the cardBook (right view pane) ────────
  ok(await page.evaluate(() => !!document.querySelector(".pl-wb-right input[type=email]") && !!document.querySelector(".pl-wb-right input[type=password]")), "=chatcard(...) put the login card in the cardBook (right pane), not inline in a cell");
  ok(await page.evaluate(() => /sign in/i.test(document.querySelector(".pl-wb-right")?.textContent ?? "")), "the cardBook card shows the slick 'sign in' header");
  ok(await page.evaluate(() => [...document.querySelectorAll(".pl-wb-right button")].some((b) => /log in/i.test(b.textContent)) && [...document.querySelectorAll(".pl-wb-right button")].some((b) => /send/i.test(b.textContent))), "the card has Log-in + Send buttons (formula-authored)");

  // ── 2. type credentials + sign in (the card lives in the right pane) ───────
  await page.fill(".pl-wb-right input[type=email]", cfg.email);
  await page.fill(".pl-wb-right input[type=password]", cfg.password);
  ok(await page.evaluate(() => globalThis.plastron.state.cels.get("grok.email")?.v?.length > 0), "typing the email captured it into the grok.email cel (grok.field)");
  await page.click(".pl-wb-right button:has-text('Log in')");
  await page.waitForTimeout(REAL ? 2500 : 600);
  const status = await page.evaluate(() => document.querySelector(".pl-wb-right .gk-status")?.textContent ?? "");
  ok(/signed in/i.test(status), "clicking Log in signs in via Supabase auth (status flips to 'signed in')", status);

  // ── 3. ask grok via the fetch lambda → reply renders in the card ───────────
  await page.fill(".pl-wb-right textarea", "what is 2+2?");
  ok(await page.evaluate(() => globalThis.plastron.state.cels.get("grok.question")?.v === "what is 2+2?"), "typing the question captured it into grok.question");
  await page.click(".pl-wb-right button:has-text('Send')");
  await page.waitForTimeout(REAL ? 6000 : 700);
  const reply = await page.evaluate(() => document.querySelector(".pl-wb-right .gk-reply")?.textContent ?? "");
  ok(reply.length > 0 && !/^error:/.test(reply) && !/thinking/.test(reply), "grok.fetch returned a reply and it rendered in the card", reply);

  if (!REAL) {
    ok(/^Bearer fake\.jwt/.test(lastGrok?.auth ?? ""), "grok.fetch sent the Supabase JWT as the bearer (server-side key model)", lastGrok?.auth);
    ok(Array.isArray(lastGrok?.body?.messages) && lastGrok.body.messages.some((m) => m.role === "user"), "grok.fetch POSTed a messages[] body with the user question", lastGrok?.body);
  } else {
    console.log("  (real project: reply =", JSON.stringify(reply.slice(0, 80)), ")");
  }

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
  srv.kill();
  if (stub) stub.stop(true);
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ grok login + chat card (dom-formula login, supabase auth, fetch-lambda chat) all pass");
process.exit(failed ? 1 : 0);
