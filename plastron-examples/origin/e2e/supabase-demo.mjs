// e2e: the supabase-demo EXAMPLE SEGMENT in real headless chromium — proves an
// authored sheet (a reactive dom panel + dispatch handlers) drives the supabase
// verbs and re-renders live. sbdemo.install lays the panel; sbdemo.signin/add/
// watch are the dispatch handlers (what a button's click fires); the panel
// FormulaCel re-renders as auth status / todo rev-count / subscription change —
// including LIVE when a server-side insert (this node proc) pushes over realtime.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync("/home/ian/projects/plastron/plastron/test/supabase-test/test-config.json"));
const DIST = "/home/ian/projects/plastron/plastron-examples/origin/dist";
const PORT = 8798;

let up = false;
try { await fetch(`${cfg.url}/auth/v1/health`); up = true; } catch { /* down */ }
if (!up) { console.log(`⚠ local supabase ${cfg.url} unreachable — skipping`); process.exit(0); }

const nodeToken = await (await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
  body: JSON.stringify({ email: cfg.testEmail, password: cfg.testPassword }),
})).json().then((j) => j.access_token);
const nodeInsert = (title) => fetch(`${cfg.url}/rest/v1/todos`, {
  method: "POST", headers: { apikey: cfg.anonKey, Authorization: `Bearer ${nodeToken}`, "Content-Type": "application/json", Prefer: "return=minimal" },
  body: JSON.stringify({ title }),
});

const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", DIST], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); };
const celV = (k) => page.evaluate((key) => globalThis.plastron.state.cels.get(key)?.v ?? null, k);
const panelStr = async () => JSON.stringify(await celV("sbdemo.demo.panel"));
const waitPanel = async (sub, ms = 9000) => { const t = Date.now(); while (Date.now() - t < ms) { if ((await panelStr()).includes(sub)) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
await page.waitForTimeout(300);

// install the demo segment (pulls supabase-demo + supabase-* deps)
const installed = await page.evaluate(async ([url, anon]) => {
  const { state, resolveFn } = globalThis.plastron;
  const R = (k) => resolveFn(state, k);
  await R("ensureSegments")(state, ["supabase-demo"]);
  return await R("sbdemo.install")(state, "demo", url, anon);
}, [cfg.url, cfg.anonKey]);
ok(/installed/.test(String(installed)), `sbdemo.install → ${installed}`);

// the panel is a live vnode rendered from reactive cels
const panel0 = await celV("sbdemo.demo.panel");
ok(panel0 && panel0.type === "el", `panel renders as a vnode (tag ${panel0?.tag})`);
ok((await panelStr()).includes("auth: signed-out"), `panel shows signed-out initially`);
ok((await panelStr()).includes("todos rev: 0"), `panel shows rev 0 initially`);

// AUTHENTICATE via the dispatch handler → panel reacts
const si = await page.evaluate(([email, password]) => {
  const { state, resolveFn } = globalThis.plastron;
  return resolveFn(state, "sbdemo.signin")(state, "demo", { email, password });
}, [cfg.testEmail, cfg.testPassword]);
ok(/signed in/.test(String(si)), `sbdemo.signin → ${si}`);
ok((await panelStr()).includes("signed in"), `panel re-rendered to show signed in`);

// WRITE via the handler → rev bumps → panel count re-renders
await page.evaluate(() => { const { state, resolveFn } = globalThis.plastron; return resolveFn(state, "sbdemo.add")(state, "demo", "from the demo sheet"); });
ok(await waitPanel("todos rev: 1"), `panel count re-rendered to rev 1 after write (rev=${await celV("sb.demo.todos.rev")})`);

// REALTIME: subscribe, then an external insert pushes live → panel updates
const w = await page.evaluate(() => { const { state, resolveFn } = globalThis.plastron; return resolveFn(state, "sbdemo.watch")(state, "demo"); });
ok(/subscribed/.test(String(w)), `sbdemo.watch → ${w}`);
ok((await panelStr()).includes("live: on"), `panel shows live: on`);
await page.waitForTimeout(1200);
const rev0 = Number(await celV("sb.demo.todos.rev") ?? 0);
await nodeInsert(`live-${Date.now()}`);
ok(await waitPanel(`todos rev: ${rev0 + 1}`), `panel re-rendered LIVE via realtime push (rev ${rev0}→${await celV("sb.demo.todos.rev")})`);

ok(errs.length === 0, `clean page — ${errs.length} errors${errs.length ? ": " + errs[0] : ""}`);
console.log(`\n${fail ? "✘" : "✔"} supabase demo segment e2e: ${pass} pass, ${fail} fail`);
await browser.close(); srv.kill();
process.exit(fail ? 1 : 0);
