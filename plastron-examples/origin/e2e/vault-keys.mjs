import { chromium } from "playwright";
import { spawn } from "node:child_process";
const srv = spawn("python3", ["-m","http.server","8784","--directory","/home/ian/projects/plastron/plastron-examples/origin/dist"], {stdio:"ignore"});
await new Promise(r => setTimeout(r, 700));
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox","--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errs = []; page.on("pageerror", e => errs.push(String(e)));
await page.goto("http://localhost:8784/index.html");
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 8000 });
await page.waitForTimeout(300);
let pass=0, fail=0; const ok=(c,w)=>{c?pass++:fail++;console.log(`  ${c?"✔":"✘"} ${w}`)};
const keyc = () => page.evaluate(() => { const s=globalThis.plastron.state; const o={}; for(const[k,c]of s.cels) if(/^keys\.A\d+$/.test(k)) o[k]={ct:c.celType, name: typeof c.v==="object"?(c.v)?.name:c.v}; return o; });
const call = (k, ...a) => page.evaluate(([key,args]) => { const {state,resolveFn}=globalThis.plastron; return resolveFn(state,key)(state,...args); }, [k,a]);

await call("origin.edit","元");
await call("setValue","元.draft","=vaultKeys(secretsNote)");
await call("origin.run","元");
await page.waitForTimeout(250);
ok(Object.keys(await keyc()).length===0, "locked → no key cels");

await call("vault.unlock", null, { type:"change", target:{ value:"pw" } });
await call("setValue", "vault.newName", "anthropic");
await call("vault.setNamed", null, { type:"change", target:{ value:"sk-ant-1" } });
await page.waitForTimeout(300);
let kc = await keyc();
console.log("  after add anthropic:", JSON.stringify(kc));
ok(kc["keys.A1"]?.ct==="ValueCel" && kc["keys.A1"]?.name==="anthropic", "keys.A1 regenerated reactively — a ValueCel holding the 🔑 handle");

await call("setValue", "vault.newName", "openai");
await call("vault.setNamed", null, { type:"change", target:{ value:"sk-oai-2" } });
await page.waitForTimeout(300);
kc = await keyc();
ok(Object.keys(kc).length===2 && kc["keys.A2"]?.name==="openai", "2nd key regenerated the grid to 2 per-key cels");

const resolved = await page.evaluate(() => { const v=globalThis.plastron.state.cels.get("keys.A1")?.v; return (v && typeof (v).resolve==="function") ? (v).resolve() : null; });
ok(resolved==="sk-ant-1", "a per-key cell IS a live handle (keys.A1 resolves the secret)");
ok(!(await page.evaluate(() => document.body.innerText.includes("sk-ant-1"))), "no secret in the DOM");

// the per-key cell's VALUE is a claude-usable handle (don't overwrite the
// generator in 元 — that would sweep the keys; call claude with the value)
const claudeOut = await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  const handle = state.cels.get("keys.A1")?.v;
  return String(await resolveFn(state,"claude")("hi", handle)).slice(0,60);
});
ok(/claude 401|authentication_error|Invalid/.test(claudeOut), `claude(keys.A1 handle) reached the API (${claudeOut.slice(0,40)})`);

await call("vault.lock");
await page.waitForTimeout(300);
ok(Object.keys(await keyc()).length===0, "lock regenerates to empty (keys swept)");
ok(errs.length===0, `no page errors${errs.length?` (${errs[0]})`:""}`);
await browser.close(); srv.kill();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
