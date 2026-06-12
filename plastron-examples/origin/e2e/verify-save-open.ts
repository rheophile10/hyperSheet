import { chromium, type Browser, type Page } from "playwright";

const URL = process.env.URL ?? "http://localhost:5174/";
const CHROME = "/usr/bin/google-chrome";

let passes = 0, fails = 0;
const ok = (cond: unknown, what: string): void => {
  if (cond) { passes++; console.log(`  ✔ ${what}`); }
  else { fails++; console.log(`  ✘ ${what}`); }
};

const browser: Browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page: Page = await browser.newPage();
const errs: string[] = [];
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });

await page.goto(URL);
await page.waitForFunction(() => !!(globalThis as { plastron?: unknown }).plastron, { timeout: 15000 });
await page.waitForTimeout(400);

ok(errs.length === 0, `clean launch — no page errors${errs.length ? ` (${errs.slice(0, 3).join(" | ")})` : ""}`);

// 💾/📁/🆕 render on a worksheet window titlebar
ok(await page.$(".pl-window .pl-save-btn"), "💾 save button renders on a worksheet window");
ok(await page.$(".pl-window .pl-open-btn"), "📁 open button renders");
ok(await page.$(".pl-window .pl-new-btn"), "🆕 new button renders");

// 🆕 opens a blank standalone sheet window
const newSeg = await page.evaluate(async () => {
  const { state, resolveFn } = (globalThis as any).plastron;
  const before = Object.keys(state.cels.get("win.geom")?.v ?? {});
  await resolveFn(state, "winsheet.newsheet")(state);
  await new Promise((r) => setTimeout(r, 120));
  const geom = state.cels.get("win.geom").v;
  const seg = Object.keys(geom).find((k) => k.startsWith("sheet") && !before.includes(k));
  return { seg, host: seg ? geom[seg]?.host ?? null : null, hasA1: !!state.cels.get(`${seg}.A1`) };
});
ok(!!newSeg.seg, `🆕 created a fresh standalone sheet (${newSeg.seg})`);
ok(newSeg.host === null, "🆕 sheet is untabbed (standalone)");
ok(newSeg.hasA1, "🆕 sheet has a real A1 cel (blank grid)");
await page.waitForTimeout(150);
ok(await page.$(`.pl-window[data-win="${newSeg.seg}"]`), "🆕 sheet window painted in the DOM");

// a save writes a file (CSV to OPFS) and double-click opens it back as a window
const saved = await page.evaluate(async (seg) => {
  const { state, resolveFn } = (globalThis as any).plastron;
  // put a value into the new sheet, then save as CSV
  await resolveFn(state, "setCel")(state, `${seg}.A1`, { celType: "ValueCel", v: "hello", metadata: { segment: seg, name: "A1", generatedBy: `${seg}.maker`, parser: "infix" } });
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "winsheet.saveas")(state, { seg, fmt: "csv" });
  await new Promise((r) => setTimeout(r, 150));
  const exists = await resolveFn(state, "fs.exists")(`/${seg}.csv`).catch(() => false);
  return { exists, path: `/${seg}.csv` };
}, newSeg.seg);
ok(saved.exists, `save wrote a file to OPFS (${saved.path})`);

// double-click the saved .csv via the explorer handler → a new sheet window
const opened = await page.evaluate(async (path) => {
  const { state, resolveFn } = (globalThis as any).plastron;
  const before = Object.keys(state.cels.get("win.geom")?.v ?? {});
  await resolveFn(state, "origin.explorerOpenSheet")(state, path);
  await new Promise((r) => setTimeout(r, 150));
  const geom = state.cels.get("win.geom").v;
  const seg = Object.keys(geom).find((k) => k.startsWith("sheet") && !before.includes(k));
  return { seg, a1: seg ? state.cels.get(`${seg}.A1`)?.v ?? null : null };
}, saved.path);
ok(!!opened.seg, `double-click opened the .csv as a new sheet window (${opened.seg})`);
ok(opened.a1 === "hello", "the opened CSV's A1 value round-tripped ('hello')");

ok(errs.length === 0, `still no page errors after exercising save/open${errs.length ? ` (${errs.slice(0, 3).join(" | ")})` : ""}`);

await page.close();
await browser.close();
console.log(`\n${fails === 0 ? "✅" : "❌"} ${passes} passed, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
