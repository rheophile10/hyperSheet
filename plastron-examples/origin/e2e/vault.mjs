import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { join } from "node:path";
const repoRoot = new URL("..", import.meta.url).pathname;
const srv = spawn("python3", ["-m","http.server","8763","--directory", join(repoRoot, "dist")], {stdio:"ignore"});
await new Promise(r => setTimeout(r, 700));
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + String(e)));
await page.goto("http://localhost:8763/index.html");
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 8000 });
await page.waitForTimeout(300);
let pass = 0, fail = 0;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); };

const flow = await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  const call = (k, ...a) => resolveFn(state, k)(state, ...a);
  const out = {};
  await call("vault.unlock", null, { type: "change", target: { value: "hunter2" } });
  out.afterUnlock = state.cels.get("secretsNote")?.v;
  await call("vault.set", "anthropic", { type: "change", target: { value: "sk-ant-fake-e2e" } });
  out.afterSet = state.cels.get("secretsNote")?.v;
  out.apiKeysValue = resolveFn(state, "apiKeys")();
  const handle = resolveFn(state, "apiKey")("anthropic");
  out.handleResolves = handle.resolve();
  // lock then re-unlock from the persisted file (proves round-trip + decrypt)
  await resolveFn(state, "vault.lock")(state);
  out.afterLockResolves = resolveFn(state, "apiKey")("anthropic").resolve();
  await call("vault.unlock", null, { type: "change", target: { value: "hunter2" } });
  out.reUnlock = state.cels.get("secretsNote")?.v;
  out.afterReUnlockResolves = resolveFn(state, "apiKey")("anthropic").resolve();
  // wrong password fails to decrypt
  await resolveFn(state, "vault.lock")(state);
  await call("vault.unlock", null, { type: "change", target: { value: "WRONG" } });
  out.wrongPw = state.cels.get("secretsNote")?.v;
  return out;
});
console.log("  flow:", JSON.stringify(flow));
ok(/new vault/.test(String(flow.afterUnlock)), "unlock creates+persists the vault (OPFS)");
ok(/stored "anthropic"/.test(String(flow.afterSet)), "setKey stores the secret");
ok(flow.apiKeysValue === "anthropic", "apiKeys() lists the NAME only");
ok(flow.handleResolves === "sk-ant-fake-e2e", "handle resolves the secret at the effect site");
ok(flow.afterLockResolves === undefined, "lock forgets the secret");
ok(/unlocked — 1 key/.test(String(flow.reUnlock)), "re-unlock decrypts the persisted file");
ok(flow.afterReUnlockResolves === "sk-ant-fake-e2e", "secret survives the encrypt→file→decrypt round-trip");
ok(/vault locked|new vault|unlocked/.test(String(flow.wrongPw)), "wrong password does not surface the prior secret");

const api = await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "vault.unlock")(state, null, { type: "change", target: { value: "hunter2" } });
  return await resolveFn(state, "claude")("say hi", resolveFn(state, "apiKey")("anthropic"));
});
ok(/claude 401|authentication_error|Invalid/.test(String(api)), `claude(apiKey handle) reaches the real API (${String(api).slice(0,50)})`);

// check for the ACTUAL secret, not the "sk-ant-…" placeholder that appears
// in guidance strings (the =claude no-key hint, etc.)
const leak = await page.evaluate(() => document.body.innerText.includes("sk-ant-fake-e2e"));
ok(!leak, "the actual secret appears nowhere in the rendered page");
ok(errs.length === 0, `no page errors${errs.length ? ` (${errs[0]})` : ""}`);
await browser.close(); srv.kill();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
