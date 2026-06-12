import { chromium } from "playwright";
import { spawn } from "node:child_process";
const srv = spawn("python3", ["-m","http.server","8793","--directory","/home/ian/projects/plastron/plastron-examples/origin/dist"], {stdio:"ignore"});
await new Promise(r => setTimeout(r, 700));
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox","--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errs = []; page.on("pageerror", e => errs.push(String(e)));
await page.goto("http://localhost:8793/index.html");
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 8000 });
await page.waitForTimeout(300);
let pass=0, fail=0; const ok=(c,w)=>{c?pass++:fail++;console.log(`  ${c?"✔":"✘"} ${w}`)};
const call = (k, ...a) => page.evaluate(([key,args]) => { const {state,resolveFn}=globalThis.plastron; return resolveFn(state,key)(state,...args); }, [k,a]);
const idCall = () => page.evaluate(() => globalThis.plastron.resolveFn(globalThis.plastron.state,"identity")(0));

ok(errs.length===0, `page launched clean (no pageerror) — ${errs.length} errors`);

// locked → placeholder
let id = await idCall();
ok(/unlock to see your identity/.test(id), `locked → placeholder ("${id}")`);

// the boot already built the vault sheet (vault.A1 secrets, vault.A2 identity)
const vaultCels = await page.evaluate(() => [...globalThis.plastron.state.cels.keys()].filter(k=>k.startsWith("vault")));
ok(vaultCels.includes("vault.A2"), `vault.A2 identity cel seeded by boot (${vaultCels.join(",")})`);

// unlock → identity minted/loaded, public key surfaces
await call("wallet.unlock", null, { type:"change", target:{ value:"hunter2" } });
await page.waitForTimeout(300);
id = await idCall();
ok(typeof id==="string" && id.length>0 && !/unlock to see/.test(id), `unlocked → public key string ("${id.slice(0,24)}…")`);
ok(/^[A-Za-z0-9+/]+=*$/.test(id), "looks like base64");

// recompute the vault so the identity cel picks up the unlocked public key
await call("runCycle");
await call("drain","dom.paint");
await page.waitForTimeout(300);
const a2v = await page.evaluate(() => {
  const c=globalThis.plastron.state.cels.get("vault.A2"); return c ? { ct:c.celType, hasVal: c.v!=null } : null;
});
ok(!!a2v && a2v.hasVal, `vault.A2 identity cel computed a value (${JSON.stringify(a2v)})`);

// the public key shows somewhere in the page DOM (the vault window renders it)
const pubInDom = await page.evaluate((pk) => document.body.innerText.includes(pk), id);
ok(pubInDom, "the public key is rendered in the page DOM");
ok(await page.evaluate(() => document.body.innerText.includes("private key never leaves the keystore")), "the vault labels the public key for sharing");

// no private key anywhere in any cel value
const noPriv = await page.evaluate(() => {
  for (const [,c] of globalThis.plastron.state.cels) {
    const v=c.v;
    if (v && typeof v==="object" && ("privateKey" in v || v.type==="private")) return false;
  }
  return true;
});
ok(noPriv, "no private key in any cel value");

// stable: re-lock then unlock loads the SAME identity
const before = id;
await call("wallet.lock"); await page.waitForTimeout(150);
await call("wallet.unlock", null, { type:"change", target:{ value:"again" } });
await page.waitForTimeout(200);
const after = await idCall();
ok(after===before, "second unlock loads the SAME identity (stable public key)");

ok(errs.length===0, `still no page errors at end — ${errs.length}`);
if (errs.length) console.log(errs.join("\n"));

console.log(`\n${fail? "FAIL":"PASS"} — ${pass} ok, ${fail} fail`);
await browser.close(); srv.kill();
process.exit(fail? 1:0);
