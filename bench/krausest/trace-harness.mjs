import { chromium } from "playwright";
const URL = process.argv[2] || "http://localhost:8741/index.html";
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox","--disable-dev-shm-usage"] });
const page = await b.newPage();
await page.goto(URL); await page.waitForSelector("#run", { timeout: 8000 });
const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
const rows = () => page.evaluate(() => document.querySelectorAll("#tbody tr").length);
// official-style duration: union of devtools.timeline event intervals from the
// click EventDispatch to the last Paint/Commit, in ms.
const REL = new Set(["EventDispatch","Layout","UpdateLayoutTree","Paint","Commit","FunctionCall","HitTest","FireAnimationFrame","PrePaint","Layerize"]);
const duration = (events) => {
  let click = null;
  for (const e of events) if (e.name === "EventDispatch" && e.args?.data?.type === "click") { click = +e.ts; break; }
  if (click == null) return null;
  let lastPaint = click;
  const ivals = [];
  for (const e of events) {
    if (e.ph !== "X" || +e.ts < click) continue;
    if (e.name === "Paint" || e.name === "Commit") lastPaint = Math.max(lastPaint, +e.ts + (+e.dur||0));
    if (REL.has(e.name)) ivals.push([+e.ts, +e.ts + (+e.dur||0)]);
  }
  const win = ivals.filter(([s]) => s <= lastPaint).sort((a,b)=>a[0]-b[0]);
  let busy=0, cs=-1, ce=-1;
  for (const [s,e] of win){ if(s>ce){ if(ce>=0)busy+=ce-cs; cs=s; ce=e; } else ce=Math.max(ce,e); }
  if(ce>=0)busy+=ce-cs;
  return { busy: busy/1000, wall: (lastPaint-click)/1000 };
};
const measure = async (clickSel) => {
  await b.startTracing(page, { categories: ["blink.user_timing","devtools.timeline","disabled-by-default-devtools.timeline"], screenshots: false });
  await page.click(clickSel); await settle();
  const buf = await b.stopTracing();
  return duration(JSON.parse(buf.toString()).traceEvents);
};
const med = (a) => a.filter(Boolean).map(x=>x.busy).sort((x,y)=>x-y)[Math.floor(a.length/2)];
const run = {};
let xs;
xs=[]; for(let i=0;i<7;i++){ await page.click("#clear"); await settle(); xs.push(await measure("#run")); } run.create=med(xs);
xs=[]; await page.click("#run"); await settle(); for(let i=0;i<7;i++) xs.push(await measure("#update")); run.update=med(xs);
xs=[]; for(let i=0;i<7;i++) xs.push(await measure("#swaprows")); run.swap=med(xs);
xs=[]; for(let i=0;i<7;i++){ await page.click("#run"); await settle(); await page.click("#clear"); await settle(); xs.push(await measure("#run")); } run.create2=med(xs);
console.log("OFFICIAL-METHOD (busy ms, devtools.timeline trace) " + URL.split("/").slice(-2,-1));
for(const k of ["create","update","swap"]) console.log("  "+k.padEnd(8), (run[k]??NaN).toFixed(1)+"ms");
await b.close();
