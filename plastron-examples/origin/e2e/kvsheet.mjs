// e2e: kvsheet — the key-value worksheet over NAMED cels (kv-sheet.md).
//
// A doc cell's `=view("params", kvsheet('<doc>', 0, sheet.selected))` grows a
// params pane from NOTHING (the roster + refs wire lazily): the composer's ➕
// mints real named ValueCels (JSON-entry rules), edits commit through
// kv.set and cascade into dependent grid formulas LIVE, a row's name click
// loads its source into the formula bar, 🗑 retires (no guardrails), and the
// whole surface — roster, named cels, the rewritten =view formula — archives
// with the document (close saves, reopen restores).
// Run:  cd plastron-examples/origin && bun e2e/kvsheet.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT ?? 5181);
const origin = "/home/ian/projects/plastron/plastron-examples/origin";
const srv = spawn("bun", [`${origin}/serve.ts`], { stdio: "ignore", env: { ...process.env, PORT: String(PORT) } });
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://localhost:${PORT}/index.html`); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0, last;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); if (!c) console.log("      last:", JSON.stringify(last)?.slice(0, 220)); };

await page.goto(`http://localhost:${PORT}/`, { timeout: 60000 });
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });
await page.waitForTimeout(1500);

const celV = (k) => page.evaluate((k) => globalThis.plastron.state.cels.get(k)?.v ?? null, k);
const run = (key, src) => page.evaluate(async ({ key, src }) => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "origin.run")(state, key, src);
}, { key, src });

// ── a fresh doc, and the ONE bootstrap formula (no roster, no prerequisites) ──
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "origin.newsheet")(state);
});
await page.waitForTimeout(1200);
last = await celV("win.sheet1.state");
ok(!!last && last.closed !== 1, "a blank Sheets doc opened (win.sheet1.state live)");

await run("sheet1.A1", "=view(\"params\", kvsheet('sheet1', 0, sheet.selected))");
await page.waitForTimeout(1000);
last = await page.evaluate(() => ({
  pane: !!document.querySelector(".pl-wb-vbody #params .kv-sheet"),
  composer: !!document.querySelector(".pl-wb-vbody .kv-composer .kv-add"),
  token: document.querySelector('.pl-wb-left .cell-value[data-key="sheet1.A1"]')?.textContent ?? null,
}));
ok(last.pane && last.composer, "=view(\"params\", kvsheet('sheet1', 0, …)) grew the pane with the composer — zero prerequisites");
ok(last.token === "⧉ params +", `the authoring cell shows the ⧉ token (${JSON.stringify(last.token)})`);

// ── ➕ mints a named cel; the roster + view formula rewire ────────────────────
await page.fill(".pl-wb-vbody .kv-composer .kv-name", "rate");
await page.fill(".pl-wb-vbody .kv-composer .kv-value", "0.5");
await page.click(".pl-wb-vbody .kv-composer .kv-add");
await page.waitForTimeout(800);
last = {
  rate: await celV("sheet1.rate"),
  roster: await celV("sheet1.keys"),
  f: await page.evaluate(() => globalThis.plastron.state.cels.get("sheet1.A1")?.f ?? ""),
  row: await page.evaluate(() => document.querySelector('.pl-wb-vbody .kv-row[data-key="sheet1.rate"] .kv-val')?.value ?? null),
};
ok(last.rate === 0.5, `➕ minted sheet1.rate = 0.5 (a real named ValueCel)`);
ok(Array.isArray(last.roster) && last.roster.join() === "rate", `the sheet1.keys roster appended the name (${JSON.stringify(last.roster)})`);
ok(last.f.includes("sheet1.keys") && last.f.includes("'sheet1.rate', sheet1.rate"), "the =view formula rewired: roster + spliced live ref");
ok(last.row === "0.5", `the pane row renders the value (${JSON.stringify(last.row)})`);

// ── JSON-entry: { parses as data ──────────────────────────────────────────────
await page.fill(".pl-wb-vbody .kv-composer .kv-name", "cfg");
await page.fill(".pl-wb-vbody .kv-composer .kv-value", '{"fps": 30}');
await page.click(".pl-wb-vbody .kv-composer .kv-add");
await page.waitForTimeout(800);
last = { cfg: await celV("sheet1.cfg"), row: await page.evaluate(() => document.querySelector('.pl-wb-vbody .kv-row[data-key="sheet1.cfg"] .kv-val')?.value ?? null) };
ok(last.cfg && last.cfg.fps === 30, `{ value parsed as JSON data (${JSON.stringify(last.cfg)})`);
ok(last.row === '{"fps":30}', `the dict row renders by the collections rules (${JSON.stringify(last.row)})`);

// ── a row edit cascades into a dependent GRID formula, live + painted ─────────
await run("sheet1.B1", "=sheet1.rate * 2");
await page.waitForTimeout(600);
last = await page.evaluate(() => document.querySelector('.pl-wb-left .cell-value[data-key="sheet1.B1"]')?.textContent ?? null);
ok(last === "1", `a grid formula reads the named cel (=sheet1.rate*2 → ${JSON.stringify(last)})`);
await page.fill('.pl-wb-vbody .kv-row[data-key="sheet1.rate"] .kv-val', "3");
await page.press('.pl-wb-vbody .kv-row[data-key="sheet1.rate"] .kv-val', "Enter");
await page.waitForTimeout(700);
last = {
  rate: await celV("sheet1.rate"),
  b1: await page.evaluate(() => document.querySelector('.pl-wb-left .cell-value[data-key="sheet1.B1"]')?.textContent ?? null),
};
ok(last.rate === 3, `Enter committed the row edit (sheet1.rate = ${last.rate})`);
ok(last.b1 === "6", `…and the dependent grid cell REPAINTED live (=rate*2 → ${JSON.stringify(last.b1)})`);

// ── selecting a row loads its source into the formula bar ────────────────────
await page.click('.pl-wb-vbody .kv-row[data-key="sheet1.rate"] .kv-key');
await page.waitForTimeout(500);
last = await page.evaluate(() => ({
  selected: globalThis.plastron.state.cels.get("sheet.selected")?.v ?? null,
  bar: document.querySelector(".pl-wb-left textarea.fx-input")?.value ?? null,
}));
ok(last.selected === "sheet1.rate", `clicking the name selects the cel (${JSON.stringify(last.selected)})`);
ok(String(last.bar) === "3", `the formula bar shows its source, like any cell (${JSON.stringify(last.bar)})`);

// ── 🗑 retires the row: cel gone, roster + formula + pane pruned ──────────────
await page.click('.pl-wb-vbody .kv-row[data-key="sheet1.cfg"] .kv-del');
await page.waitForTimeout(800);
last = {
  cfg: await celV("sheet1.cfg"),
  roster: await celV("sheet1.keys"),
  row: await page.evaluate(() => !!document.querySelector('.pl-wb-vbody .kv-row[data-key="sheet1.cfg"]')),
  f: await page.evaluate(() => globalThis.plastron.state.cels.get("sheet1.A1")?.f ?? ""),
};
ok(last.cfg === null, "🗑 retired the cel outright (no guardrails)");
ok(Array.isArray(last.roster) && last.roster.join() === "rate", `the roster dropped it (${JSON.stringify(last.roster)})`);
ok(!last.row && !last.f.includes("sheet1.cfg"), "the pane row and the formula ref are gone");

// ── persistence: close (save-on-close) → reopen → the kv sheet is back ────────
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "window.close")(state, "win.sheet1.state");
});
await page.waitForTimeout(1000);
ok((await celV("sheet1.rate")) === null, "close evicted the doc (named cels gone from live state)");
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "origin.opendoc")(state, "sheet1");
});
await page.waitForTimeout(1500);
last = {
  rate: await celV("sheet1.rate"),
  roster: await celV("sheet1.keys"),
  row: await page.evaluate(() => document.querySelector('.pl-wb-vbody .kv-row[data-key="sheet1.rate"] .kv-val')?.value ?? null),
};
ok(last.rate === 3, `reopen restored the named cel from the stored doc (sheet1.rate = ${last.rate})`);
ok(Array.isArray(last.roster) && last.roster.join() === "rate", `…and the roster (${JSON.stringify(last.roster)})`);
ok(last.row === "3", `…and the pane re-grew from the saved formula with the row visible (${JSON.stringify(last.row)})`);

ok(errs.length === 0, `no page errors (${errs.length ? errs[0]?.slice(0, 200) : "clean"})`);

console.log(`\n${pass} pass, ${fail} fail`);
await browser.close();
srv.kill();
process.exit(fail ? 1 : 0);
