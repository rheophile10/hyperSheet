// e2e: 🕵️ ChaosEdgeSteg — the sheetapp document that hides a plastron.ca #f=
// link inside a small PNG (edge-adaptive, Hénon-keyed LSB steganography) and
// recovers it, byte-compatible with the upstream `chaosedgesteg` CLI. This is
// the capstone story (docs/plastron/stories/chaosedgesteg-sheetapp.md):
//
//   open doc:chaosedgesteg → EMBED a boids #f= link into a ≤680px cover PNG
//   (real upstream Python running in a py cell: numpy + opencv + pillow +
//   mpmath auto-load under Pyodide) → download the steg PNG → DECODE the
//   original cover + the steg image + password → the link comes back exactly
//   and renders as a clickable <a>. Then the PARITY direction: an
//   upstream-CLI-produced steg (fixtures/upstream_steg.png, an image that
//   actually round-tripped through X) decodes here to the same link.
//
// Cross-tool parity in the OTHER direction (an app-made steg extracts under
// the upstream desktop CLI on the same cover) is verified out-of-band and
// pinned in the review handoff; it isn't re-run here (no Python CLI in CI).
//
//   bun e2e/chaosedgesteg.mjs        (spawns its own dev server on :8897)
//
// NOTE: the first embed downloads the Pyodide runtime + the numpy/opencv/
// pillow/mpmath wheels (~30 MB) from cdn.jsdelivr.net, so this e2e needs
// network and is SLOW (minutes) on a cold cache — by design (Option 1).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8897;
const originDir = new URL("..", import.meta.url).pathname;
const fixDir = new URL("./fixtures/chaosedgesteg/", import.meta.url).pathname;
const COVER = join(fixDir, "cover.png");
const COVER_1200 = join(fixDir, "cover_1200.png");
const UPSTREAM_STEG = join(fixDir, "upstream_steg.png");
const LINK = readFileSync(join(fixDir, "link.txt"), "utf8").trim();
const tmp = mkdtempSync(join(tmpdir(), "ces-e2e-"));

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
// Poll a cel until predicate holds (or timeout). Used for the slow py path.
const waitCel = async (k, pred, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const v = await cel(k);
    if (pred(v)) return v;
    if (Date.now() - t0 > ms) { last = v; return v; }
    await page.waitForTimeout(1000);
    if ((Date.now() - t0) % 15000 < 1100) console.log(`      …waiting for ${label} (${((Date.now() - t0) / 1000) | 0}s)`);
  }
};
const clickView = async (name) => {
  await page.click(`.pl-wb-right .pl-wb-tab:has-text("${name}")`);
  await page.waitForTimeout(400);
};
// Poll the DOM for an element (views re-render a beat after their async py
// cel resolves). Returns the evaluated result once truthy, else last value.
const waitDom = async (fn, ms, label) => {
  const t0 = Date.now();
  for (;;) {
    const r = await page.evaluate(fn);
    if (r) return r;
    if (Date.now() - t0 > ms) { last = r; return r; }
    await page.waitForTimeout(700);
    void label;
  }
};

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });

// 1) open via origin.opendoc — the verb the 🕵️ ChaosEdgeSteg desktop icon
//    (doc:chaosedgesteg) dispatches.
await page.evaluate(async () => { const { state, resolveFn } = globalThis.plastron; await resolveFn(state, "origin.opendoc")(state, "chaosedgesteg"); });
await page.waitForTimeout(1200);

last = await cel("win.chaosedgesteg.state");
ok(!!last && last.closed !== 1, "the ChaosEdgeSteg workbook opened (win.chaosedgesteg.state live)");
const views = (last?.views ?? []).map((t) => t.title);
ok(views.some((t) => /Decode/.test(t)) && views.some((t) => /Embed/.test(t)),
  `Decode + Embed view panes on the right (${JSON.stringify(views)})`);
last = (last?.sheets ?? []).map((t) => t.title || t.ref).join(",");
ok(/chaosedgesteg/.test(String(last)), "the worksheet is the left tab");

// 2) the algorithm is a positioned py source cell bound by a =def binder (R10)
last = await page.evaluate(() => ({
  src: String(globalThis.plastron.state.cels.get("chaosedgesteg.A21")?.v ?? ""),
  cesKind: globalThis.plastron.state.cels.get("chaosedgesteg.ces")?.metadata?.kind ?? null,
  cesFn: typeof globalThis.plastron.state.cels.get("chaosedgesteg.ces")?.v,
}));
ok(/import cv2/.test(last.src) && /def embed/.test(last.src) && /def extract/.test(last.src),
  "A21 holds the upstream algorithm as visible Python source (imports on the surface)");
ok(last.cesKind === "py",
  `the A22 =def binder minted the py callable chaosedgesteg.ces (kind=${last.cesKind}, v=${last.cesFn})`);

// 3) EMBED — set the link, upload the cover through the real file input
//    (fs.pickToCel), watch the py pipeline produce the steg PNG.
await clickView("Embed");
// B10 (link to hide) already defaults to the fixture boids link in the doc.
await page.setInputFiles(".pl-wb-vbody input[type=file]", COVER);
last = await waitCel("chaosedgesteg.B11", (v) => typeof v === "string" && v.length > 100, 15000, "cover upload → B11");
ok(typeof last === "string" && last.length > 100, "fs.pickToCel wrote the picked cover into B11 as base64 (in-browser)");

console.log("      embedding — first run downloads Pyodide + numpy/opencv/pillow/mpmath (~30MB)…");
last = await waitCel("chaosedgesteg.B15", (v) => typeof v === "string" && v.length > 100, 300000, "the steg PNG (B15)");
ok(typeof last === "string" && last.length > 100, "the py embed produced a steg PNG (B15 base64) — real OpenCV under Pyodide");
const stegB64 = last;
const STEG = join(tmp, "steg.png");
writeFileSync(STEG, Buffer.from(stegB64, "base64"));

// the Embed pane shows a Download steg PNG anchor (data-URL, download attr) —
// the pane repaints on its own (fs.pickToCel drains origin.effects + dom.paint
// after the async embed completes), no manual repaint here.
last = await waitDom(() => {
  const a = [...document.querySelectorAll(".pl-wb-right a")].find((x) => /Download steg/.test(x.textContent || ""));
  return a ? { href: (a.getAttribute("href") || "").slice(0, 22), dl: a.getAttribute("download") } : null;
}, 20000, "download anchor");
ok(last?.href === "data:image/png;base64," && /\.png$/.test(last?.dl || ""),
  `Embed pane renders a Download steg PNG data-URL anchor (${JSON.stringify(last)})`);

// 4) DECODE (in-app round trip) — upload the original cover + the app-made
//    steg + the default password; the link comes back exactly, as a link.
await clickView("Decode");
await page.setInputFiles(".pl-wb-vbody input[type=file] >> nth=0", COVER);
await page.setInputFiles(".pl-wb-vbody input[type=file] >> nth=1", STEG);
await page.waitForTimeout(500);
last = await waitCel("chaosedgesteg.B7", (v) => v === LINK, 120000, "decode B7 == link");
ok(last === LINK, "round trip: the app decoded its own steg back to the exact boids link");
last = await waitDom(() => {
  const a = [...document.querySelectorAll(".pl-wb-right a[href^='http']")][0];
  return a ? { href: a.getAttribute("href"), text: (a.textContent || "").trim() } : null;
}, 20000, "recovered link anchor");
ok(last?.href === LINK && last?.text === LINK, "the recovered URL renders as a CLICKABLE link in the Decode pane");

// 5) PARITY (upstream → app) — an upstream-CLI steg that actually survived a
//    round trip through X decodes here to the same link, same cover, same pw.
await page.setInputFiles(".pl-wb-vbody input[type=file] >> nth=1", UPSTREAM_STEG);
await page.waitForTimeout(500);
last = await waitCel("chaosedgesteg.B7", (v) => v === LINK, 120000, "decode upstream steg");
ok(last === LINK, "parity: an UPSTREAM-produced steg (survived X) decodes in the app to the exact link");

// 5b) the ≤680 guard — a >680px cover is flagged by ces('size') and the
//     ces('downscale', …, 680) that embed uses fits it to ≤680. Called
//     directly (PIL only, no slow cv2 embed); Pyodide is already warm.
const big1200 = readFileSync(COVER_1200).toString("base64");
last = await page.evaluate(async (b64) => {
  const { state, resolveFn } = globalThis.plastron;
  const ces = resolveFn(state, "chaosedgesteg.ces");
  const size = await ces("size", b64);
  const smaller = await ces("downscale", b64, 680);
  return { size, sizeAfter: await ces("size", smaller) };
}, big1200);
ok(/TOO BIG/.test(last?.size || "") && /1200/.test(last?.size || ""),
  `the ≤680 guard flags a 1200px cover (${JSON.stringify(last?.size)})`);
ok(/OK/.test(last?.sizeAfter || "") && /680/.test(last?.sizeAfter || ""),
  `ces('downscale', cover, 680) fits it to ≤680 (${JSON.stringify(last?.sizeAfter)})`);

// 6) swap fallback + bad password are readable, not crashes
await page.evaluate((lnk) => {
  const { state, resolveFn } = globalThis.plastron;
  // wrong password → readable "bad password" message, no throw
  resolveFn(state, "setValue")(state, "chaosedgesteg.B6", "WRONG_PW");
}, LINK);
last = await waitCel("chaosedgesteg.B7", (v) => typeof v === "string" && /bad password/i.test(v), 120000, "bad password message");
ok(typeof last === "string" && /bad password/i.test(last), "a wrong password surfaces a readable 'bad password' message (no crash)");

// 7) close → the doc flushes + evicts (chaosedgesteg.* gone)
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "window.close")(state, "win.chaosedgesteg.state");
});
await page.waitForTimeout(600);
last = await page.evaluate(() => globalThis.plastron.state.cels.has("chaosedgesteg.B7"));
ok(last === false, "closing the workbook flushes + evicts the doc (chaosedgesteg.* gone)");

ok(errs.length === 0, `no page errors (${errs.length ? errs[0]?.slice(0, 200) : "clean"})`);

console.log(`\n${pass} pass, ${fail} fail`);
await browser.close();
srv.kill();
process.exit(fail ? 1 : 0);
