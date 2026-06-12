// Focused browser verification for the rebuilt CHAT window (cells + formulas).
//   bun e2e/chat-window.mjs
import { chromium } from "playwright";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const bundle = join(repoRoot, "dist/index.html");
const CHROME = "/usr/bin/google-chrome";

let passes = 0, fails = 0;
const ok = (c, what) => { if (c) { passes++; console.log(`  ✔ ${what}`); } else { fails++; console.log(`  ✘ ${what}`); } };

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

try {
  await page.goto("file://" + bundle);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 8000 });
  await page.waitForTimeout(250);
  // materialize the boot desktop genesis (the segment(...) batch)
  await page.evaluate(async () => { const { state, resolveFn } = globalThis.plastron; await resolveFn(state, "origin.commit")(state, "元"); });
  await page.waitForTimeout(250);

  // CLIENTS sheet status cells
  const clients = await page.evaluate(() => {
    const s = globalThis.plastron.state;
    const g = (k) => s.cels.get(k)?.v;
    return {
      claude: g("clients.A1"), grok: g("clients.A2"),
      b1tag: g("clients.B1")?.tag, b2tag: g("clients.B2")?.tag,
      c1IsFormula: typeof s.cels.get("clients.C1")?.f === "string", hasD1: !!s.cels.get("clients.D1"),
      chatTag: g("chat.A1")?.tag,
      host: s.cels.get("win.geom")?.v?.chat?.host,
    };
  });
  ok(clients.grok?.status === "error" && clients.grok?.error === "✗ no key", "grok shows ✗ no key (no xai key)");
  ok(clients.claude?.provider === "claude", "claude client handle present");
  ok(clients.b1tag === "span" && clients.b2tag === "span", "clientlight cells render spans (B1/B2)");
  ok(!clients.c1IsFormula, "messages cell (C1) is a plain VALUE cell, not a FormulaCel");
  ok(clients.hasD1, "entry buffer cell (D1) exists");
  ok(clients.chatTag === "div", "chat.A1 is the chatpanel div");
  ok(clients.host === "clients", "chat tabbed into clients (one window: [clients | chat])");

  // activate the chat TAB (the window hosts [clients | chat]; clients is the
  // default active tab) so the chat sheet's panel paints.
  await page.evaluate(async () => {
    const { state, resolveFn } = globalThis.plastron;
    await resolveFn(state, "winsheet.tab")(state, { host: "clients", tab: "chat" });
  });
  await page.waitForTimeout(250);

  // the chat window renders in the DOM: bots-left + history + entry + send
  ok(await page.$(".chatpanel .chat-bots"), "bots column on the LEFT");
  ok(await page.$(".chatpanel .chat-history"), "chat history in the body");
  ok(await page.$(".chatpanel input.chat-input"), "a text entry input");
  ok(await page.$(".chatpanel button.chat-send"), "a send button");
  // a clientlight glyph rendered (🔴 since no key)
  const light = await page.evaluate(() => document.querySelector(".client-light")?.textContent ?? "");
  ok(light === "🔴" || light === "🟢", `a clientlight glyph rendered (${light})`);

  // THREE sends in a row — the D1 entry cell must survive each one (the bug:
  // setMsgs used to setCel C1 into a value, churning the clients genesis and
  // sweeping clients.D1 → "setValue: unknown cel clients.D1" on the 2nd send).
  const multi = await page.evaluate(async () => {
    const { state, resolveFn } = globalThis.plastron;
    const errs = [];
    const orig = console.error; console.error = (...a) => errs.push(a.map(String).join(" "));
    try {
      for (const msg of ["first message", "second message", "third message"]) {
        await resolveFn(state, "setValue")(state, "clients.D1", msg);
        await resolveFn(state, "chat.cellsend")(state);
      }
    } finally { console.error = orig; }
    const c1 = state.cels.get("clients.C1")?.v;
    return {
      d1Survived: !!state.cels.get("clients.D1"),
      c1Len: Array.isArray(c1) ? c1.length : -1,
      firstUser: Array.isArray(c1) ? c1[0]?.text : null,
      unknownCelErr: errs.some((e) => /unknown cel|takes a formula source/.test(e)),
      errs,
    };
  });
  ok(multi.d1Survived, "clients.D1 survived three sends (no genesis re-materialize / sweep)");
  ok(multi.c1Len === 6, `three sends appended 2 rows each → C1 has 6 messages (got ${multi.c1Len})`);
  ok(multi.firstUser === "first message", "the first user message is at the head of the list");
  ok(!multi.unknownCelErr, `no "unknown cel clients.D1" / FormulaCel error across sends${multi.errs.length ? ` (${multi.errs.slice(0, 2).join(" | ")})` : ""}`);

  // arm claude with a key → its status flips to ready (status in the value, key not)
  const armed = await page.evaluate(async () => {
    const { state, resolveFn } = globalThis.plastron;
    await resolveFn(state, "ensureSegments")(state, ["unsafe-wallet"]);
    await resolveFn(state, "wallet.unlock")(state, null, { type: "change", target: { value: "hunter2" } });
    await resolveFn(state, "wallet.set")(state, "anthropic", { type: "change", target: { value: "sk-ant-REALKEY" } });
    await resolveFn(state, "runCycle")(state);
    const v = state.cels.get("clients.A1")?.v;
    const leaked = JSON.stringify(v).includes("REALKEY");
    return { status: v?.status, leaked };
  });
  ok(armed.status === "ready", "claude flips to ready once its key exists");
  ok(!armed.leaked, "the key is NOT in the client value (status only)");

  ok(errs.length === 0, `no console/page errors${errs.length ? ` (${errs.slice(0, 2).join(" | ")})` : ""}`);
} catch (e) {
  ok(false, `chat-window e2e threw: ${String(e).slice(0, 200)}`);
} finally {
  await page.close();
  await browser.close();
}

console.log(`\n${fails === 0 ? "🟢" : "🔴"} ${passes} passing, ${fails} failing`);
process.exit(fails === 0 ? 0 : 1);
