// e2e: the #otp= one-time-pad boot loader — happy path AND wrong-pad (which must
// NOT fail silently). Drives the real bundled dist in headless Chrome.
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { join, dirname } from "path"; import { fileURLToPath } from "url";
import { spawn } from "child_process";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const html = readFileSync(join(repoRoot, "dist", "index.html"), "utf8");
const hash = (html.match(/#otp=card[.]png\.[A-Za-z0-9._-]+/) || [])[0];
if (!hash) { console.error("no baked #otp= demo in dist"); process.exit(1); }
const cardBytes = readFileSync(join(repoRoot, "card.png"));

const srv = spawn("python3", ["-m","http.server","8762","--directory", join(repoRoot,"dist")], {stdio:"ignore"});
await new Promise(r=>setTimeout(r,800));
const b = await chromium.launch({ executablePath:"/usr/bin/google-chrome", headless:true, args:["--no-sandbox","--disable-dev-shm-usage"] });
const page = await (await b.newContext()).newPage();
const errs=[]; page.on("pageerror",e=>errs.push(String(e))); page.on("console",m=>{if(m.type()==="error" && !/favicon|Failed to load resource/.test(m.text()))errs.push(m.text());});

await page.goto("http://localhost:8762/index.html" + hash);
await page.waitForFunction(()=>!!globalThis.plastron,{timeout:8000});
await page.waitForTimeout(300);
const 元f = () => page.evaluate(()=>globalThis.plastron.state.cels.get("元")?.f ?? null);

let pass=0,fail=0; const ok=(c,w,x="")=>{ c?(pass++,console.log("  ✔",w)):(fail++,console.log("  ✘",w,x)); };

ok(await page.locator("input.otp-pad").count()>0, "loader rendered a file picker");
ok(/otpLoader/.test(String(await 元f())), "元 holds =otpLoader(...) at boot");

// WRONG pad → must show an error, NOT fail silently, and stay on the loader
await page.setInputFiles("input.otp-pad", { name:"wrong.bin", mimeType:"application/octet-stream", buffer: Buffer.from("not the pad — too short and wrong") });
await page.waitForTimeout(500);
const errText = await page.evaluate(()=>document.querySelector(".otp-err")?.textContent ?? "");
ok(/wrong pad|pad too short|authentication failed/i.test(errText), "wrong pad shows a visible error (no silent fail)", `err="${errText.slice(0,70)}"`);
ok(/otpLoader/.test(String(await 元f())), "元 still on the loader after a wrong pad (can retry)");
ok((await page.locator("input.otp-pad").count())>0, "file picker still present to retry");

// CORRECT pad → decrypts and runs the formula
await page.setInputFiles("input.otp-pad", { name:"card.png", mimeType:"image/png", buffer: cardBytes });
await page.waitForTimeout(600);
ok(/turtles all the way down/.test(String(await 元f())), "correct pad → 元 becomes the decrypted formula", `got=${String(await 元f()).slice(0,50)}`);
ok(/🐢 turtles all the way down/.test(await page.evaluate(()=>document.body.innerText)), "decrypted dom is visible on the page");

if (errs.length) { console.log("PAGE ERRORS:"); for (const e of errs.slice(0,8)) console.log("   !", e); }
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); srv.kill();
process.exit(fail?1:0);
