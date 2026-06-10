import { chromium } from "playwright";
import { spawn } from "node:child_process";
const srv = spawn("python3", ["-m","http.server","8772","--directory","/home/ian/projects/plastron/plastron-examples/origin/dist"], {stdio:"ignore"});
await new Promise(r => setTimeout(r, 700));
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox","--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errs = []; page.on("pageerror", e => errs.push(String(e)));
await page.goto("http://localhost:8772/index.html");
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 8000 });
await page.waitForTimeout(300);
let pass=0, fail=0; const ok=(c,w)=>{c?pass++:fail++;console.log(`  ${c?"✔":"✘"} ${w}`)};
const put = (src, key) => page.evaluate(async ([s,k]) => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "origin.edit")(state, k);
  await resolveFn(state, "setValue")(state, "元.draft", s);
  await resolveFn(state, "origin.commit")(state, k);
  await new Promise(r=>setTimeout(r,250));
  await resolveFn(state, "drain")(state, "dom.paint");
}, [src,key]);
const cellText = (k) => page.evaluate((key) => { const td = document.querySelector(`td[data-key="${key}"]`); return td ? (td).innerText : "(none)"; }, k);

// put the reactive panel in 元
await put("=wallet(walletNote)", "元");
await page.waitForTimeout(200);
ok(/🔒\s*locked/.test(await cellText("元")), "panel shows 🔒 locked initially");
const hasInput = await page.evaluate(() => !!document.querySelector('td[data-key="元"] input[type="password"]'));
ok(hasInput, "locked panel renders the unlock password input");

// unlock by typing into the panel's input (real keystrokes)
await page.click('td[data-key="元"] input[type="password"]');
await page.fill('td[data-key="元"] input[type="password"]', "hunter2");
await page.keyboard.press("Enter");
await page.waitForTimeout(500);
const afterUnlock = await cellText("元");
console.log("  panel after unlock:", JSON.stringify(afterUnlock));
ok(/🔓\s*unlocked/.test(afterUnlock), "panel reactively flips to 🔓 unlocked");
const hasLockBtn = await page.evaluate(() => { const b = [...document.querySelectorAll('td[data-key="元"] button')].find(b => /lock/i.test(b.textContent||"")); return !!b; });
ok(hasLockBtn, "unlocked panel shows a lock button");

// add a key entirely within the unlocked panel (name + secret), then resolve it
await page.fill('td[data-key="\u5143"] input[type="text"]', "anthropic");
await page.click('td[data-key="\u5143"] input[type="password"]');
await page.fill('td[data-key="\u5143"] input[type="password"]', "sk-ant-panel");
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
const added = await cellText("\u5143");
ok(/unlocked \u2014 1 key/.test(added) && /🔑 anthropic/.test(added), "panel add-key stores a key (name + secret) reactively, in-place");
ok((await page.evaluate(() => globalThis.plastron.resolveFn(globalThis.plastron.state, "apiKey")("anthropic").resolve())) === "sk-ant-panel", "apiKey resolves the panel-added secret");
ok(!(await page.evaluate(() => document.body.innerText.includes("sk-ant-panel"))), "panel-added secret is not in the DOM");

// click the lock button → back to locked
await page.evaluate(() => { const b = [...document.querySelectorAll('td[data-key="元"] button')].find(b => /lock/i.test(b.textContent||"")); b?.dispatchEvent(new MouseEvent("click",{bubbles:true})); });
await page.waitForTimeout(400);
const afterLock = await cellText("元");
console.log("  panel after lock click:", JSON.stringify(afterLock));
ok(/🔒\s*locked/.test(afterLock), "clicking lock reactively returns the panel to 🔒 locked");

ok(errs.length===0, `no page errors${errs.length?` (${errs[0]})`:""}`);
await browser.close(); srv.kill();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
