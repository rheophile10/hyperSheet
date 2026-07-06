// e2e: the INTERACTIVE login + kanban demo on origin/sheetApp, in real headless
// chromium. sbdemo.kanban mounts a login FORM (real <input>s + a button, authored
// as a formula). The test TYPES the demo creds, CLICKS "Log in", and asserts the
// user's kanban tasks (RLS-scoped query) render as a board — the full path a real
// user takes. Demo user: icar@rheophile.ca / PlastronFunTest.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync("/home/ian/projects/plastron/plastron/test/supabase-test/test-config.json"));
const DIST = "/home/ian/projects/plastron/plastron-examples/origin/dist";
const PORT = 8799;
const EMAIL = "icar@rheophile.ca";       // the demo user (note: rheophiLe)
const PASS = "PlastronFunTest";

let up = false;
try { await fetch(`${cfg.url}/auth/v1/health`); up = true; } catch { /* down */ }
if (!up) { console.log(`⚠ local supabase ${cfg.url} unreachable — skipping`); process.exit(0); }

const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", DIST], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); };
const celV = (k) => page.evaluate((key) => globalThis.plastron.state.cels.get(key)?.v ?? null, k);

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
await page.waitForTimeout(300);

// install + mount the interactive login+kanban demo
const installed = await page.evaluate(async ([url, anon]) => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "ensureSegments")(state, ["supabase-demo"]);
  return await resolveFn(state, "sbdemo.kanban")(state, "demo", url, anon);
}, [cfg.url, cfg.anonKey]);
ok(/workbook|opened/.test(String(installed)), `sbdemo.kanban → ${installed}`);

// the login FORM renders (formula-authored inputs + button)
await page.waitForSelector(".sb-login .sb-email", { timeout: 8000 });
ok(await page.$(".sb-login"), "login form mounted on .origin");
ok(await page.$(".sb-email") && await page.$(".sb-pass") && await page.$(".sb-go"), "email + password inputs + Log in button present");
ok((await page.$$eval(".sb-card", (e) => e.length)) === 0, "no kanban cards before login");

// TYPE the creds + CLICK Log in (the real user path)
await page.fill(".sb-email", EMAIL);
await page.fill(".sb-pass", PASS);
await page.click(".sb-go");

// the board renders the user's kanban tasks (RLS-scoped)
await page.waitForFunction(() => document.querySelectorAll(".sb-card").length > 0, { timeout: 12000 });
await page.waitForTimeout(300);

const status = await celV("sbdemo.demo.status");
ok(String(status).includes(`signed in as ${EMAIL}`), `status cel: "${status}"`);

const cards = await page.$$eval(".sb-card", (els) => els.map((e) => e.textContent));
ok(cards.length === 6, `kanban rendered 6 task cards (got ${cards.length})`);
ok(cards.includes("Build the kanban view panel"), `a known task is on the board ("Build the kanban view panel")`);

const headers = await page.$$eval(".sb-col-h", (els) => els.map((e) => e.textContent));
ok(headers.some((h) => /Done \(2\)/.test(h)), `column counts rendered (${JSON.stringify(headers)})`);

// the tasks came from a per-user RLS query (the cel holds exactly this user's rows)
const tasks = await celV("sbdemo.demo.tasks");
ok(Array.isArray(tasks) && tasks.length === 6, `sbdemo.demo.tasks holds the user's 6 kanban rows`);

ok(errs.length === 0, `clean page — ${errs.length} errors${errs.length ? ": " + errs[0] : ""}`);
console.log(`\n${fail ? "✘" : "✔"} supabase login+kanban e2e: ${pass} pass, ${fail} fail`);
await browser.close(); srv.kill();
process.exit(fail ? 1 : 0);
