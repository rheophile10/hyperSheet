// e2e: Supabase DATA plane + REALTIME-on-data, in real headless chromium.
// Proves a sheet can query + write through supabase.data, and that a
// server-side change (inserted by THIS node process via REST — i.e. from
// "another client") pushes over the realtime WebSocket and bumps the page's
// sb.test.todos.rev cel. Drives verbs via globalThis.plastron.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync("/home/ian/projects/plastron/plastron/test/supabase-test/test-config.json"));
const DIST = "/home/ian/projects/plastron/plastron-examples/origin/dist";
const PORT = 8796;

let up = false;
try { await fetch(`${cfg.url}/auth/v1/health`); up = true; } catch { /* down */ }
if (!up) { console.log(`⚠ local supabase ${cfg.url} unreachable — skipping`); process.exit(0); }

// node-side helpers: sign in + insert via REST = "another client" making a change
const nodeToken = await (await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
  body: JSON.stringify({ email: cfg.testEmail, password: cfg.testPassword }),
})).json().then((j) => j.access_token);
const nodeInsert = async (title) => (await (await fetch(`${cfg.url}/rest/v1/todos`, {
  method: "POST", headers: { apikey: cfg.anonKey, Authorization: `Bearer ${nodeToken}`, "Content-Type": "application/json", Prefer: "return=representation" },
  body: JSON.stringify({ title }),
})).json())[0];

const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", DIST], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); };
const evp = (fn, arg) => page.evaluate(fn, arg);
const celV = (k) => page.evaluate((key) => globalThis.plastron.state.cels.get(key)?.v ?? null, k);
const waitRev = async (k, gt, ms = 9000) => { const t = Date.now(); while (Date.now() - t < ms) { if (Number(await celV(k) ?? 0) > gt) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
await page.waitForTimeout(300);

// boot: load segments, config, sign in
const signedIn = await evp(async ([url, anon, email, password]) => {
  const { state, resolveFn } = globalThis.plastron;
  const R = (k) => resolveFn(state, k);
  await R("ensureSegments")(state, ["supabase-auth", "supabase"]);
  await R("setCel")(state, "sb.test.url", { celType: "ValueCel", v: url, metadata: { key: "sb.test.url", segment: "app" } });
  await R("setCel")(state, "sb.test.anonkey", { celType: "ValueCel", v: anon, metadata: { key: "sb.test.anonkey", segment: "app" } });
  await R("supabase.auth")(state, "signin", "test", { email, password });
  return state.cels.get("sb.test.auth")?.v?.status;
}, [cfg.url, cfg.anonKey, cfg.testEmail, cfg.testPassword]);
ok(signedIn === "signed-in", `signed in (${signedIn})`);

// WRITE: insert a todo through supabase.data
const title = `e2e-${Date.now()}`;
const inserted = await evp((t) => {
  const { state, resolveFn } = globalThis.plastron;
  return resolveFn(state, "supabase.data")(state, "insert", "test", { table: "todos", rows: { title: t } });
}, title);
ok(Array.isArray(inserted) && inserted[0]?.title === title, `WRITE: insert → ${Array.isArray(inserted) ? JSON.stringify(inserted[0]?.title) : inserted}`);
const id = inserted?.[0]?.id;

// QUERY: select it back
const rows = await evp((i) => {
  const { state, resolveFn } = globalThis.plastron;
  return resolveFn(state, "supabase.data")(state, "select", "test", { table: "todos", query: `select=id,title,done&id=eq.${i}` });
}, id);
ok(Array.isArray(rows) && rows.length === 1 && rows[0].title === title, `QUERY: select → ${JSON.stringify(rows)}`);

// REV bumped by the local write
ok(Number(await celV("sb.test.todos.rev")) >= 1, `rev cel bumped by write (${await celV("sb.test.todos.rev")})`);

// REALTIME on data: subscribe, then an EXTERNAL insert (this node proc) bumps the page's rev
const sub = await evp(() => {
  const { state, resolveFn } = globalThis.plastron;
  return resolveFn(state, "supabase.realtime")(state, "subscribe", "test", { table: "todos" });
});
ok(/subscribed/.test(String(sub)), `realtime subscribe → ${sub}`);
await page.waitForTimeout(1200); // let the channel JOIN
const rev0 = Number(await celV("sb.test.todos.rev") ?? 0);
const ext = await nodeInsert(`ext-${Date.now()}`);
const bumped = await waitRev("sb.test.todos.rev", rev0);
ok(bumped, `REALTIME: external insert pushed over WS → page rev bumped past ${rev0} (now ${await celV("sb.test.todos.rev")})`);

// cleanup
await evp(([a, b]) => {
  const { state, resolveFn } = globalThis.plastron;
  const D = (i) => resolveFn(state, "supabase.data")(state, "delete", "test", { table: "todos", match: `id=eq.${i}` });
  return Promise.all([a, b].filter(Boolean).map(D));
}, [id, ext?.id]);

ok(errs.length === 0, `clean page — ${errs.length} errors${errs.length ? ": " + errs[0] : ""}`);
console.log(`\n${fail ? "✘" : "✔"} supabase data+realtime e2e: ${pass} pass, ${fail} fail`);
await browser.close(); srv.kill();
process.exit(fail ? 1 : 0);
