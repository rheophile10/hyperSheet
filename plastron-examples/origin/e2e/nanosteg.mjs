// e2e: 🕵️ NanoSteg — the WAT-native, dependency-free sheetapp document that
// hides a plastron.ca #f= link inside a small PNG (blind LSB steganography by a
// hand-written WebAssembly module) and recovers it from that ONE image alone +
// a password. This is the capstone story (docs/plastron/stories/nanosteg-sheetapp.md):
//
//   open doc:nanostegapp → EMBED a boids #f= link into a ≤680px cover PNG
//   (a sub-kilobyte WAT module — NO Python, NO OpenCV, NO Pyodide) → download
//   the steg PNG → DECODE from JUST that one image + the password (no original
//   cover) → the link comes back exactly and renders as a clickable <a>.
//
// The contrast with the ChaosEdgeSteg sibling is provable here: ONE decode
// upload (not two), no Python (the whole algorithm is legible WAT on the sheet),
// and its own incompatible scheme. Fast — no runtime download.
//
//   bun e2e/nanosteg.mjs        (spawns its own dev server on :8898)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8898;
const originDir = new URL("..", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "nanosteg-e2e-"));
const LINK = "https://plastron.ca/#f=eNqrVkrKT8pJTS7JzM9TslJQSszLzMtMzs8rVtJRSkksSVWyUkrOSCzKTC1WsjKvBQBc_g8b";

const srv = spawn("bun", ["serve.ts"], { cwd: originDir, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://localhost:${PORT}/index.html`); if (r.ok) break; } catch { /* not up yet */ }
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
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); if (!c) console.log("      last:", JSON.stringify(last)?.slice(0, 240)); };
const cel = (k) => page.evaluate((key) => globalThis.plastron.state.cels.get(key)?.v ?? null, k);
const waitCel = async (k, pred, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await cel(k);
    if (pred(v)) return v;
    if (Date.now() - t0 > ms) { last = v; return v; }
    await page.waitForTimeout(500);
    void label;
  }
};
const clickView = async (name) => { await page.click(`.pl-wb-right .pl-wb-tab:has-text("${name}")`); await page.waitForTimeout(400); };
const waitDom = async (fn, ms) => {
  const t0 = Date.now();
  for (;;) {
    const r = await page.evaluate(fn);
    if (r) return r;
    if (Date.now() - t0 > ms) { last = r; return r; }
    await page.waitForTimeout(500);
  }
};

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });

// Generate cover PNGs in-browser via the `image` segment (no external fixtures).
const covers = await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "ensureSegments")(state, ["image"]);
  const encode = resolveFn(state, "image.encode");
  const mk = (w, h, seed) => { const a = new Uint8Array(w * h * 4); let s = seed >>> 0; for (let i = 0; i < a.length; i++) { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; a[i] = i % 4 === 3 ? 255 : (s & 0xff); } return a; };
  return { small: await encode(mk(640, 640, 7), 640, 640), big: await encode(mk(900, 700, 9), 900, 700) };
});
const COVER = join(tmp, "cover.png"); writeFileSync(COVER, Buffer.from(covers.small, "base64"));
const COVER_BIG = join(tmp, "cover_big.png"); writeFileSync(COVER_BIG, Buffer.from(covers.big, "base64"));

// 1) open via origin.opendoc — the verb the 🕵️ NanoSteg desktop icon
//    (doc:nanostegapp) dispatches.
await page.evaluate(async () => { const { state, resolveFn } = globalThis.plastron; await resolveFn(state, "origin.opendoc")(state, "nanostegapp"); });
await page.waitForTimeout(1200);

last = await cel("win.nanostegapp.state");
ok(!!last && last.closed !== 1, "the NanoSteg workbook opened (win.nanostegapp.state live)");
const views = (last?.views ?? []).map((t) => t.title);
ok(views.some((t) => /Decode/.test(t)) && views.some((t) => /Embed/.test(t)),
  `Decode + Embed view panes on the right (${JSON.stringify(views)})`);

// 2) the algorithm is a positioned WAT source cell captured by nanosteg.host (R10)
last = await page.evaluate(() => ({
  src: String(globalThis.plastron.state.cels.get("nanostegapp.A21")?.f ?? ""),
  kind: globalThis.plastron.state.cels.get("nanostegapp.A21")?.metadata?.kind ?? null,
  imports: globalThis.plastron.state.cels.get("nanostegapp.A21")?.metadata?.imports ?? null,
  fn: typeof globalThis.plastron.state.cels.get("nanostegapp.A21")?._fn,
}));
ok(/hash_password/.test(last.src) && /splitmix|0x9E3779B97F4A7C15/i.test(last.src) && /export "mem"/.test(last.src),
  "A21 holds the whole steg algorithm as visible WAT source (hash_password + splitmix + exported memory)");
ok(last.kind === "wat" && last.imports === "nanosteg.host" && last.fn === "function",
  `the WAT core compiled with the host-instance hook (kind=${last.kind}, imports=${last.imports})`);

// 3) EMBED — set the link, upload the cover through the real file input
//    (fs.pickToCel); the WAT module produces the steg PNG (fast — no download).
await clickView("Embed");
await page.evaluate((lnk) => globalThis.plastron.resolveFn(globalThis.plastron.state, "setValue")(globalThis.plastron.state, "nanostegapp.F1", lnk), LINK);
await page.setInputFiles(".pl-wb-vbody input[type=file]", COVER);
last = await waitCel("nanostegapp.F2", (v) => typeof v === "string" && v.length > 100, 15000, "cover → F2");
ok(typeof last === "string" && last.length > 100, "fs.pickToCel wrote the picked cover into F2 as base64 (in-browser)");

last = await waitCel("nanostegapp.F8", (v) => typeof v === "string" && /capacity OK/.test(v), 15000, "capacity");
ok(/capacity OK/.test(String(last)), `the visible capacity guard confirms the fit (${JSON.stringify(last)})`);

last = await waitCel("nanostegapp.F9", (v) => typeof v === "string" && v.length > 100, 30000, "steg PNG (F9)");
ok(typeof last === "string" && last.length > 100, "the WAT embed produced a steg PNG (F9 base64) — no Python");
const stegB64 = last;
const STEG = join(tmp, "steg.png"); writeFileSync(STEG, Buffer.from(stegB64, "base64"));

// the produced steg PNG is ≤680px on its longest edge (Twitter-safe) and is a
// lossless PNG (so its dims + LSBs survive a re-decode).
last = await page.evaluate(async (b64) => {
  const { state, resolveFn } = globalThis.plastron;
  const d = await resolveFn(state, "image.decode")(b64);
  return { w: d.w, h: d.h };
}, stegB64);
ok(Math.max(last.w, last.h) <= 680, `the steg PNG is ≤680px (Twitter-safe): ${last.w}×${last.h}`);

last = await waitDom(() => {
  const a = [...document.querySelectorAll(".pl-wb-right a")].find((x) => /Download steg/.test(x.textContent || ""));
  return a ? { href: (a.getAttribute("href") || "").slice(0, 22), dl: a.getAttribute("download") } : null;
}, 20000);
ok(last?.href === "data:image/png;base64," && /\.png$/.test(last?.dl || ""),
  `Embed pane renders a Download steg PNG data-URL anchor (${JSON.stringify(last)})`);

// 4) DECODE — BLIND: upload JUST the steg image + the password. No cover.
await clickView("Decode");
const inputCount = await page.locator(".pl-wb-right input[type=file]:visible").count();
ok(inputCount === 1, `the Decode pane has ONE file upload — no cover needed (found ${inputCount}); the sibling needs two`);
await page.setInputFiles(".pl-wb-right input[type=file]:visible", STEG);
await page.waitForTimeout(400);
last = await waitCel("nanostegapp.B4", (v) => v === LINK, 30000, "decode B4 == link");
ok(last === LINK, "BLIND round trip: the link is recovered from the steg image ALONE + password (no cover)");

last = await waitDom(() => {
  const a = [...document.querySelectorAll(".pl-wb-right a[href^='http']")][0];
  return a ? { href: a.getAttribute("href"), text: (a.textContent || "").trim() } : null;
}, 20000);
ok(last?.href === LINK && last?.text === LINK, "the recovered URL renders as a CLICKABLE link in the Decode pane");

// 5) wrong password → a readable message, not a crash
await page.evaluate(() => globalThis.plastron.resolveFn(globalThis.plastron.state, "setValue")(globalThis.plastron.state, "nanostegapp.B3", "WRONG_PW"));
last = await waitCel("nanostegapp.B4", (v) => typeof v === "string" && /wrong password/i.test(v), 30000, "wrong pw");
ok(typeof last === "string" && /wrong password/i.test(last), "a wrong password surfaces a readable 'wrong password' message (no crash)");

// 6) the ≤680 guard downscales an oversized cover before embedding
last = await page.evaluate(async (b64) => {
  const { state, resolveFn } = globalThis.plastron;
  const fitted = await resolveFn(state, "image.fit")(b64, 680);
  const d = await resolveFn(state, "image.decode")(fitted);
  const orig = await resolveFn(state, "image.decode")(b64);
  return { before: Math.max(orig.w, orig.h), after: Math.max(d.w, d.h) };
}, covers.big);
ok(last?.before > 680 && last?.after <= 680, `image.fit downscales a ${last?.before}px cover to ≤680 (${JSON.stringify(last)})`);

// 7) close → the doc flushes + evicts (nanostegapp.* gone)
await page.evaluate(async () => { const { state, resolveFn } = globalThis.plastron; await resolveFn(state, "window.close")(state, "win.nanostegapp.state"); });
await page.waitForTimeout(600);
last = await page.evaluate(() => globalThis.plastron.state.cels.has("nanostegapp.B4"));
ok(last === false, "closing the workbook flushes + evicts the doc (nanostegapp.* gone)");

ok(errs.length === 0, `no page errors (${errs.length ? errs[0]?.slice(0, 200) : "clean"})`);

console.log(`\n${pass} pass, ${fail} fail`);
await browser.close();
srv.kill();
process.exit(fail ? 1 : 0);
