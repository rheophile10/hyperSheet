// e2e: Supabase AUTH end-to-end in real headless chromium — proves the
// supabase-auth + session segments work IN THE BROWSER (CSP connect-src, gated
// fetch, GoTrue) against the local stack. Drives supabase.auth via
// globalThis.plastron (the proven e2e pattern); asserts the reactive sb.test.auth
// cel + that the JWT lands in the session store (not a cel value).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync("/home/ian/projects/plastron/plastron/test/supabase-test/test-config.json"));
const DIST = "/home/ian/projects/plastron/plastron-examples/origin/dist";
const PORT = 8795;

// require the local stack
let up = false;
try { await fetch(`${cfg.url}/auth/v1/health`); up = true; } catch { /* down */ }
if (!up) { console.log(`⚠ local supabase ${cfg.url} unreachable — skipping`); process.exit(0); }

const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", DIST], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); };

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
await page.waitForTimeout(300);

const result = await page.evaluate(async ([url, anon, email, password]) => {
  const { state, resolveFn } = globalThis.plastron;
  const R = (k) => resolveFn(state, k);
  await R("ensureSegments")(state, ["supabase-auth"]);
  await R("setCel")(state, "sb.test.url", { celType: "ValueCel", v: url, metadata: { key: "sb.test.url", segment: "app" } });
  await R("setCel")(state, "sb.test.anonkey", { celType: "ValueCel", v: anon, metadata: { key: "sb.test.anonkey", segment: "app" } });
  const msg = await R("supabase.auth")(state, "signin", "test", { email, password });
  const auth = state.cels.get("sb.test.auth")?.v;
  const token = R("session.handle")(state, "supabase.test").resolve();
  // scan all cels: the JWT must not appear as a cel value
  let leak = false;
  for (const [, cel] of state.cels) { let v; try { v = JSON.stringify(cel.v ?? null); } catch { continue; } if (typeof v === "string" && token && v.includes(token)) { leak = true; break; } }
  return { msg, status: auth?.status, email: auth?.email, hasToken: !!token, tokenLen: token?.length ?? 0, leak };
}, [cfg.url, cfg.anonKey, cfg.testEmail, cfg.testPassword]);

ok(errs.length === 0, `clean page — ${errs.length} errors${errs.length ? ": " + errs[0] : ""}`);
ok(result.status === "signed-in", `in-browser sign-in → ${result.status} (${result.msg})`);
ok(result.email === cfg.testEmail, `sb.test.auth.email = ${result.email}`);
ok(result.hasToken && result.tokenLen > 20, `JWT resolvable from session store (len ${result.tokenLen})`);
ok(result.leak === false, `JWT does NOT appear in any cel value`);

console.log(`\n${fail ? "✘" : "✔"} supabase auth e2e: ${pass} pass, ${fail} fail`);
await browser.close(); srv.kill();
process.exit(fail ? 1 : 0);
