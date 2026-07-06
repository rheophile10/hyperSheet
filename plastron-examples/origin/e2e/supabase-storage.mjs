// e2e: Supabase STORAGE + REALTIME-on-storage, in real headless chromium.
// Proves a sheet can upload/download/list/remove objects through
// supabase.storage, and that a server-side object change (uploaded by THIS node
// process via REST) pushes over realtime and bumps the page's
// sb.test.objects.rev cel (storage.objects is in the realtime publication).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync("/home/ian/projects/plastron/plastron/test/supabase-test/test-config.json"));
const DIST = "/home/ian/projects/plastron/plastron-examples/origin/dist";
const PORT = 8797;
const BUCKET = "plastron-test";

let up = false;
try { await fetch(`${cfg.url}/auth/v1/health`); up = true; } catch { /* down */ }
if (!up) { console.log(`⚠ local supabase ${cfg.url} unreachable — skipping`); process.exit(0); }

const nodeToken = await (await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
  body: JSON.stringify({ email: cfg.testEmail, password: cfg.testPassword }),
})).json().then((j) => j.access_token);
const nodeUpload = (path, body) => fetch(`${cfg.url}/storage/v1/object/${BUCKET}/${path}`, {
  method: "POST", headers: { apikey: cfg.anonKey, Authorization: `Bearer ${nodeToken}`, "Content-Type": "text/plain", "x-upsert": "true" }, body,
});
const nodeRemove = (path) => fetch(`${cfg.url}/storage/v1/object/${BUCKET}/${path}`, {
  method: "DELETE", headers: { apikey: cfg.anonKey, Authorization: `Bearer ${nodeToken}` },
});

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

const signedIn = await evp(async ([url, anon, email, password]) => {
  const { state, resolveFn } = globalThis.plastron;
  const R = (k) => resolveFn(state, k);
  await R("ensureSegments")(state, ["supabase-auth", "supabase", "supabase-storage"]);
  await R("setCel")(state, "sb.test.url", { celType: "ValueCel", v: url, metadata: { key: "sb.test.url", segment: "app" } });
  await R("setCel")(state, "sb.test.anonkey", { celType: "ValueCel", v: anon, metadata: { key: "sb.test.anonkey", segment: "app" } });
  await R("supabase.auth")(state, "signin", "test", { email, password });
  return state.cels.get("sb.test.auth")?.v?.status;
}, [cfg.url, cfg.anonKey, cfg.testEmail, cfg.testPassword]);
ok(signedIn === "signed-in", `signed in (${signedIn})`);

// STORAGE round-trip through supabase.storage
const path = `e2e/note-${Date.now()}.txt`;
const body = "stored from a plastron sheet";
const out = await evp(async ([b, p, content]) => {
  const { state, resolveFn } = globalThis.plastron;
  const S = (op, payload) => resolveFn(state, "supabase.storage")(state, op, "test", { bucket: b, ...payload });
  const up = await S("upload", { path: p, content });
  const got = await S("download", { path: p });
  const list = await S("list", { prefix: "e2e/" });
  return { up, got, listed: Array.isArray(list) ? list.map((o) => o.name) : list };
}, [BUCKET, path, body]);
ok(out.up && (out.up.Key || out.up.Id), `upload → ${JSON.stringify(out.up)}`);
ok(out.got === body, `download → "${out.got}"`);
ok(Array.isArray(out.listed) && out.listed.some((n) => path.endsWith(n)), `list → ${JSON.stringify(out.listed)}`);

// REALTIME on storage: subscribe storage.objects, external upload bumps the page's rev
const sub = await evp(() => {
  const { state, resolveFn } = globalThis.plastron;
  return resolveFn(state, "supabase.realtime")(state, "subscribe", "test", { table: "objects", schema: "storage" });
});
ok(/subscribed/.test(String(sub)), `realtime subscribe storage.objects → ${sub}`);
await page.waitForTimeout(1200);
const rev0 = Number(await celV("sb.test.objects.rev") ?? 0);
const extPath = `e2e/ext-${Date.now()}.txt`;
await nodeUpload(extPath, "external upload");
const bumped = await waitRev("sb.test.objects.rev", rev0);
ok(bumped, `REALTIME: external upload pushed over WS → page sb.test.objects.rev bumped past ${rev0} (now ${await celV("sb.test.objects.rev")})`);

// remove (page) + cleanup
const rm = await evp(([b, p]) => {
  const { state, resolveFn } = globalThis.plastron;
  return resolveFn(state, "supabase.storage")(state, "remove", "test", { bucket: b, path: p });
}, [BUCKET, path]);
ok(rm && !String(rm).startsWith("(supabase"), `remove → ${JSON.stringify(rm)}`);
await nodeRemove(extPath);

ok(errs.length === 0, `clean page — ${errs.length} errors${errs.length ? ": " + errs[0] : ""}`);
console.log(`\n${fail ? "✘" : "✔"} supabase storage+realtime e2e: ${pass} pass, ${fail} fail`);
await browser.close(); srv.kill();
process.exit(fail ? 1 : 0);
