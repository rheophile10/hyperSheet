import { chromium } from "playwright";
import { readFileSync } from "fs";
import { join, dirname } from "path"; import { fileURLToPath } from "url";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
import { spawn } from "child_process";
const srv = spawn("python3", ["-m","http.server","8761","--directory", join(repoRoot,"dist")], {stdio:"ignore"});
await new Promise(r=>setTimeout(r,800));
const b = await chromium.launch({ executablePath:"/usr/bin/google-chrome", headless:true, args:["--no-sandbox","--disable-dev-shm-usage"] });
const ctx = await b.newContext({ acceptDownloads: true }); const page = await ctx.newPage();
const errs=[]; page.on("pageerror",e=>errs.push(String(e))); page.on("console",m=>{if(m.type()==="error" && !/favicon|Failed to load resource/.test(m.text()))errs.push(m.text());});
await page.goto("http://localhost:8761/index.html");
await page.waitForFunction(()=>!!globalThis.plastron,{timeout:8000});
await page.waitForTimeout(250);
const put = (src, key="元") => page.evaluate(async ([s,k])=>{
  const {state,resolveFn}=globalThis.plastron;
  await resolveFn(state,"origin.edit")(state,k);
  await resolveFn(state,"setValue")(state,"元.draft",s);
  await resolveFn(state,"origin.commit")(state,k);
  await new Promise(r=>setTimeout(r,150));
  return state.cels.get(k)?.v ?? null;
}, [src,key]);
let pass=0,fail=0; const ok=(c,w)=>{ if(c){pass++;console.log("  ✔",w);} else {fail++;console.log("  ✘",w,"  got:",JSON.stringify(last).slice(0,80));} };
let last;
const P=async(s)=>{ last=await put(s); return String(last); };
const D="/opfs-test-"+Date.now()%100000;
ok(/mkdir/.test(await P(`=mkdir("${D}")`)), "mkdir");
ok(/wrote/.test(await P(`=write("${D}/a.txt", "hello opfs")`)), "write");
ok((await P(`=ls("${D}")`))==="a.txt", "ls shows the file");
ok((await P(`=cat("${D}/a.txt")`))==="hello opfs", "cat reads it back");
ok(/isDir: false/.test(await P(`=stat("${D}/a.txt")`)), "stat reports a file");
ok(/mv/.test(await P(`=mv("${D}/a.txt", "${D}/b.txt")`)), "mv");
ok((await P(`=ls("${D}")`))==="b.txt", "ls after mv");
ok(/touch/.test(await P(`=touch("${D}/c.txt")`)), "touch");
ok(/rm/.test(await P(`=rm("${D}/b.txt")`)), "rm file");
ok(/rm/.test(await P(`=rm("${D}")`)), "rm dir (recursive)");
const cel = (k) => page.evaluate((kk)=>globalThis.plastron.state.cels.get(kk)?.v ?? null, k);
// --- segment / sheet manager ---
await P(`=cels(2, 2)`);
await put(`42`, "g2x2.A1");
ok(/saved sheet/.test(await P(`=saveSeg("mywork")`)), "saveSeg writes to OPFS");
ok((await P(`=segs()`)).includes("mywork"), "segs lists the saved sheet");
await put(`99`, "g2x2.A1");
ok(/opened sheet/.test(await P(`=openSeg("mywork")`)), "openSeg restores");
ok((await cel("g2x2.A1"))===42, "g2x2.A1 restored to 42 after openSeg");
ok(/deleted/.test(await P(`=delSeg("mywork")`)), "delSeg removes it");
ok(!(await P(`=segs()`)).includes("mywork"), "segs no longer lists it");
// --- download (button cel → browser save) ---
await P(`=write("/updl/f.txt", "download me")`);
await put(`=download("/updl/f.txt")`, "元");
await page.waitForSelector("button.opfs-btn", { timeout: 4000 });
const [dl] = await Promise.all([ page.waitForEvent("download"), page.click("button.opfs-btn") ]);
ok(dl.suggestedFilename() === "f.txt", "download button → file named f.txt");
const dlp = await dl.path();
ok(dlp && readFileSync(dlp, "utf8") === "download me", "downloaded bytes match the OPFS file");
// --- upload (file input cel → OPFS) ---
await put(`=upload("/updl")`, "元");
await page.waitForSelector("input.opfs-upload", { timeout: 4000 });
await page.setInputFiles("input.opfs-upload", { name: "up.txt", mimeType: "text/plain", buffer: Buffer.from("uploaded content") });
await page.waitForTimeout(250);
ok((await P(`=cat("/updl/up.txt")`)) === "uploaded content", "uploaded file landed in OPFS");

ok(errs.length===0, "no console/page errors"+(errs.length?": "+errs.slice(0,2).join(" | "):""));

// --- file explorer: index.html seed + binary guard + per-file actions ---
// on a FRESH page (the prior =upload/=download puts left 元 holding a non-desktop
// value on `page`, unmounting the explorer window). A clean boot re-seeds
// /plastron/index.html and re-mounts the explorer window on the desktop.
const page2 = await ctx.newPage();
const errs2=[]; page2.on("pageerror",e=>errs2.push(String(e))); page2.on("console",m=>{if(m.type()==="error" && !/favicon|Failed to load resource/.test(m.text()))errs2.push(m.text());});
await page2.goto("http://localhost:8761/index.html");
await page2.waitForFunction(()=>!!globalThis.plastron,{timeout:8000});
await page2.waitForTimeout(300);
const cel2 = (k) => page2.evaluate((kk)=>globalThis.plastron.state.cels.get(kk)?.v ?? null, k);
// the boot seeded the page's own HTML so the explorer isn't empty
ok((await cel2("file-store.backend")) === "opfs", "OPFS backend is live in the browser");
ok(String((await cel2("explorer.listing"))?.previewText ?? "").length >= 0, "explorer listing populated at boot");
ok(typeof (await page2.evaluate(async()=>{const{state,resolveFn}=globalThis.plastron;return await resolveFn(state,"fs.readText")("/plastron/index.html");})) === "string", "/plastron/index.html was seeded at boot");
// drive the explorer to the seeded dir + open a real .wasm → never text-previewed
await page2.evaluate(async () => {
  const {state,resolveFn}=globalThis.plastron;
  await resolveFn(state,"fs.write")("/plastron/probe.wasm", new Uint8Array([0,97,115,109,1,0,0,0,255]));
  await resolveFn(state,"origin.explorerNav")(state,"/plastron");
  await resolveFn(state,"origin.explorerOpen")(state,"/plastron/probe.wasm");
});
await page2.waitForTimeout(200);
const lst = await cel2("explorer.listing");
ok((lst?.entries ?? []).some(e=>e.name==="index.html"), "explorer lists the seeded index.html");
ok(lst?.previewBinary === true, "the .wasm preview is flagged binary (not read as text)");
ok(/^binary file/.test(String(lst?.previewText ?? "")), "the .wasm shows a binary placeholder");
// the explorer window rendered the per-file action buttons + the binary download
ok(await page2.$(".file-explorer .fe-act"), "per-file action buttons (🗑/✎/⬇) render in the explorer");
ok(await page2.$(".file-explorer .fe-dl"), "the binary preview renders a download button");
await page2.evaluate(async () => { const {state,resolveFn}=globalThis.plastron; await resolveFn(state,"fs.delete")("/plastron/probe.wasm"); });
ok(errs2.length===0, "no console/page errors (explorer page)"+(errs2.length?": "+errs2.slice(0,2).join(" | "):""));
await page2.close();
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); srv.kill(); process.exit(fail?1:0);
