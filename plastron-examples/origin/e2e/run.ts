// ============================================================================
// e2e/run.ts — Playwright coverage for the origin's formula vocabulary.
//
// Every formula advertised in the readme (and a few more) is exercised against
// the REAL bundled page in system google-chrome: each case gets a fresh boot,
// types a formula into 元 via the exposed `plastron` global (the same path the
// UI uses), and asserts the resulting cel value and/or rendered DOM. Canvas
// cases additionally read back pixels to prove the painter replayed the ops.
//
//   bun e2e/run.ts            # rebuilds dist if stale, runs all cases
// ============================================================================

import { chromium, type Browser, type Page } from "playwright";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const bundle = join(repoRoot, "dist/index.html");
const CHROME = "/usr/bin/google-chrome";

const stale = (): boolean => {
  if (!existsSync(bundle)) return true;
  const m = statSync(bundle).mtimeMs;
  for (const f of ["origin-main.ts", "index.html", "bundle.ts"]) {
    const p = join(repoRoot, f);
    if (existsSync(p) && statSync(p).mtimeMs > m) return true;
  }
  // also rebuild if the kernel dist changed
  const kdist = join(repoRoot, "../../plastron/dist/index.js");
  if (existsSync(kdist) && statSync(kdist).mtimeMs > m) return true;
  return false;
};

if (stale()) {
  console.log("📦 rebundling origin…");
  const r = Bun.spawnSync(["bun", join(repoRoot, "bundle.ts")], { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
}

let passes = 0, fails = 0;
const ok = (cond: unknown, what: string): void => {
  if (cond) { passes++; console.log(`  ✔ ${what}`); }
  else { fails++; console.log(`  ✘ ${what}`); }
};
const eq = (actual: unknown, expected: unknown, what: string): void =>
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${what}${JSON.stringify(actual) === JSON.stringify(expected) ? "" : `  (got ${JSON.stringify(actual)})`}`);

// --disable-features=WebRtcHideLocalIpsWithMdns: headless Chromium otherwise
// hides host IPs behind mDNS .local candidates that don't resolve, so the
// two-page WebRTC ICE never connects. This exposes real localhost candidates.
const browser: Browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-features=WebRtcHideLocalIpsWithMdns"] });

// run `body` against a freshly-booted page; collects console/page errors.
const withPage = async (label: string, body: (page: Page) => Promise<void>): Promise<void> => {
  console.log(`\n▶ ${label}`);
  const page = await browser.newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  try {
    await page.goto("file://" + bundle);
    await page.waitForFunction(() => !!(globalThis as { plastron?: unknown }).plastron, { timeout: 8000 });
    await page.waitForTimeout(250);
    await body(page);
    ok(errs.length === 0, `no console/page errors${errs.length ? ` (${errs.slice(0, 2).join(" | ")})` : ""}`);
  } catch (e) {
    ok(false, `${label} threw: ${String(e).slice(0, 120)}`);
  } finally {
    await page.close();
  }
};

// put a formula into a cell and commit (the UI path); returns the cel value.
const put = (page: Page, src: string, key = "元"): Promise<unknown> =>
  page.evaluate(async ([s, k]) => {
    const { state, resolveFn } = (globalThis as any).plastron;
    await resolveFn(state, "origin.edit")(state, k);
    await resolveFn(state, "setValue")(state, "元.draft", s);
    await resolveFn(state, "origin.run")(state, k);
    await new Promise((r) => setTimeout(r, 60));
    return state.cels.get(k)?.v ?? null;
  }, [src, key] as [string, string]);

const cel = (page: Page, key: string): Promise<unknown> =>
  page.evaluate((k) => (globalThis as any).plastron.state.cels.get(k)?.v ?? null, key);

// ── cases ───────────────────────────────────────────────────────────────────

await withPage("boot — canvas readme renders + draws", async (page) => {
  ok(await page.$('.desktop-bg'), "the wallpaper mounted on boot");
  ok(await page.$('.pl-window[data-win="win.readme.state"]'), "the readme renders in its own window");
  ok(await page.$('table.grid td.cell[data-key="元"]'), "元 is a uniform table cell (same UI as grid cels)");
  ok(await page.$(".readme"), "readme card rendered");
  ok(await page.$(".readme canvas"), "canvas banner element present");
  ok(await page.evaluate(() => !!document.querySelector(".readme")?.textContent?.includes("this readme is the formula")), "intro text present");
  ok(await page.$(".readme table.fx td.fx-code"), "formulas shown in a two-column table");
  ok(await page.$('.readme a[href*="github.com/rheophile10/plastron"]'), "repo link present");
  // the banner canvas painted (filled background + title)
  const drawn = await page.evaluate(() => {
    const c = document.querySelector(".readme canvas") as HTMLCanvasElement;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let nonzero = 0; for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) nonzero++;
    return nonzero;
  });
  ok(drawn > 1000, `canvas actually painted (${drawn} opaque px)`);
});

await withPage("the composed solar-system canvas paints (static circles)", async (page) => {
  // the 2nd readme canvas composes rings + planet dots from circle() ops
  const drawn = await page.evaluate(() => {
    const cs = [...document.querySelectorAll(".readme canvas")] as HTMLCanvasElement[];
    const c = cs[cs.length - 1]; // the composed scene
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let nonzero = 0; for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) nonzero++;
    return nonzero;
  });
  ok(drawn > 1000, `composed canvas painted (${drawn} opaque px)`);
});

await withPage("=save() persists + reload restores the sheet", async (page) => {
  await put(page, "=cels(2, 2)");
  await put(page, "42", "g2x2.A1");
  await put(page, "=g2x2!A1 + 8", "g2x2.B1");
  ok(/^saved/.test(String(await put(page, "=save()"))), "save confirms");
  await page.reload();
  await page.waitForFunction(() => !!(globalThis as { plastron?: unknown }).plastron, { timeout: 8000 });
  await page.waitForTimeout(400);
  eq(await cel(page, "g2x2.A1"), 42, "g2x2.A1 restored after reload");
  eq(await cel(page, "g2x2.B1"), 50, "g2x2.B1 recomputed (42 + 8)");
});

await withPage("=1 + 1 → 2", async (page) => eq(await put(page, "=1 + 1"), 2, "arithmetic"));

await withPage("literal 7 → 7", async (page) => eq(await put(page, "7"), 7, "literal number"));

await withPage("=cels(8, 5) → one sheet", async (page) => {
  await put(page, "=cels(8, 5)");
  ok(await cel(page, "g8x5.A1") !== null, "g8x5.A1 created");
  ok(await cel(page, "g8x5.E8") !== null, "g8x5.E8 created");
  eq(await page.evaluate(() => document.querySelectorAll("table.grid").length), 2, "base 元 table + the grid");
});

await withPage("=cels(\"in\",4,3,\"out\",4,3) → workbook", async (page) => {
  await put(page, '=cels("in", 4, 3, "out", 4, 3)');
  ok(await cel(page, "in.A1") !== null, "in.A1 created");
  ok(await cel(page, "out.C4") !== null, "out.C4 created");
  eq(await page.evaluate(() => document.querySelectorAll("table.grid").length), 3, "base 元 table + two sheets");
});

await withPage("=cels is the grid (renamed); =members lists a segment", async (page) => {
  await put(page, "=cels(4, 3)");
  ok(await cel(page, "g4x3.A1") !== null, "cels(4,3) made a grid (cels === grid)");
  ok(String(await put(page, '=members("origin")')).includes("cel"), "members() lists a segment's cels");
});

await withPage('=cels("in",4,3, at("a1","apple"), at("b2","=1+1")) fills cells', async (page) => {
  await put(page, '=cels("in", 4, 3, at("a1", "apple"), at("b2", "=1+1"))');
  eq(await cel(page, "in.A1"), "apple", "in.A1 = the at() value");
  eq(await cel(page, "in.B2"), 2, "in.B2 = the at() formula, computed");
});

await withPage("seed() serializes the whole document into one paste-able formula", async (page) => {
  await put(page, '=segment(cels("in",2,2,at("a1","apple"),at("b2","=1+1")), def("double","js","x => x * 2"))');
  const seedStr = String(await put(page, "=seed()", "in.A2"));
  ok(/segment\(/.test(seedStr) && /cels\("in"/.test(seedStr) && /def\("double"/.test(seedStr), `seed() emits a segment(...) (${seedStr.slice(0, 64)}…)`);
  // paste it into a FRESH page's 元 — the whole app re-materializes
  await page.reload();
  await page.waitForFunction(() => !!(globalThis as { plastron?: unknown }).plastron, { timeout: 8000 });
  await page.waitForTimeout(300);
  await put(page, seedStr);
  eq(await cel(page, "in.A1"), "apple", "recreated in.A1 value");
  eq(await cel(page, "in.B2"), 2, "recreated in.B2 formula (=1+1)");
  eq(await put(page, "=double(21)", "in.B1"), 42, "recreated def is callable");
});

await withPage("cells carry dom memo hints + editing stays correct", async (page) => {
  await put(page, "=cels(8, 8)");
  const m = await page.evaluate(() => {
    let n = 0, t = 0; const walk = (x: any) => { if (!x || typeof x !== "object") return; if (x.tag === "td" && x.attrs?.["data-key"]) { t++; if (Array.isArray(x.memo)) n++; } (x.children || []).forEach(walk); };
    const v = (globalThis as any).plastron.state.cels.get("元.view")?.v; walk(v?.vnode ?? v); return { n, t };
  });
  ok(m.t > 50 && m.n >= m.t - 2, `cells carry the library memo hint (${m.n}/${m.t}; active cell excluded)`);
  await put(page, "99", "g8x8.D4");
  eq(await cel(page, "g8x8.D4"), 99, "editing a cell still updates its value");
});

await withPage("=def + =double(21) → 42", async (page) => {
  await put(page, '=def("double", "js", "x => x * 2")');
  ok(String(await cel(page, "元")).includes('defined "double"'), "def confirms");
  eq(await page.evaluate(() => (globalThis as any).plastron.state.cels.get("double")?.celType), "EditableLambdaCel", "function cel created");
  eq(await put(page, "=double(21)"), 42, "callable from a formula");
});

await withPage("=canvas(...) renders + draws in a cell", async (page) => {
  await put(page, '=canvas(300, 80, rect(0,0,300,80,"#222"), text(14,46,"hi","#fff","20px system-ui"))');
  const drawn = await page.evaluate(() => {
    const c = document.querySelector(".cell canvas") as HTMLCanvasElement;
    if (!c) return -1;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) n++;
    return n;
  });
  ok(drawn > 1000, `cell canvas drew (${drawn} opaque px)`);
});

await withPage("=dom + style renders with the style applied", async (page) => {
  await put(page, '=dom("h2", style("color", "tomato"), "styled")');
  const h2 = await page.$(".cell h2");
  ok(h2, "h2 rendered in the cell");
  ok(await page.evaluate(() => { const h = document.querySelector(".cell h2") as HTMLElement; return /tomato|rgb\(255, 99, 71\)/.test(getComputedStyle(h).color); }), "color style applied");
});

await withPage("=mount(\".origin\", …) splices onto the desktop", async (page) => {
  await put(page, '=mount(".origin", dom("p.pinned", "on the desktop"))');
  ok(await page.$(".origin p.pinned"), "pinned onto .origin");
});

await withPage("=inspect(\"mount\") → yaml", async (page) => {
  const v = String(await put(page, '=inspect("mount")'));
  ok(/^name: mount/m.test(v) && /signature:/.test(v) && /source:/.test(v), "yaml with name/signature/source");
});

await withPage("editor: Shift+Enter newline, Tab indents (focus kept)", async (page) => {
  await put(page, "=1"); // give 元 a short value so the editor isn't the giant readme
  await page.click('td.cell[data-key="元"] .cell-value'); await page.waitForTimeout(80);
  const ta = 'td.cell[data-key="元"] textarea.cell-edit';
  await page.evaluate((s) => { const t = document.querySelector(s) as HTMLTextAreaElement; t.value = ""; t.focus(); t.selectionStart = t.selectionEnd = 0; }, ta);
  await page.type(ta, "ab");
  await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift");
  await page.type(ta, "cd"); await page.keyboard.press("Tab");
  const r = await page.evaluate((s) => { const t = document.querySelector(s) as HTMLTextAreaElement | null; return { val: t?.value, editing: !!t }; }, ta);
  ok(r.val?.includes("\n"), "Shift+Enter inserted a newline");
  ok(r.val?.includes("\t"), "Tab inserted a tab character");
  ok(r.editing, "Tab kept focus in the editor (didn't move away)");
});

await withPage("readme formula text is black (CanvasText), not blue", async (page) => {
  const code = await page.evaluate(() => getComputedStyle(document.querySelector(".readme td.fx-code")!).color);
  ok(code === "rgb(0, 0, 0)" || /^rgb\(2[0-9]{2}/.test(code), `readme code is black/white not blue (${code})`);
});

await withPage("=segments() lists origin", async (page) => ok(String(await put(page, "=segments()")).includes("origin"), "origin listed"));

await withPage("=vocab(\"origin\") lists the vocabulary", async (page) => {
  const v = String(await put(page, '=vocab("origin")'));
  ok(/\bgrid\b/.test(v) && /\bdom\b/.test(v) && /\bdef\b/.test(v), "grid/dom/def listed");
});

await withPage("=checkpoint(\"safe\") does not error", async (page) => {
  await put(page, '=checkpoint("safe")');
  eq(await cel(page, "元.error"), null, "no error");
});

await withPage("=segments() lists loaded libraries", async (page) => ok(String(await put(page, "=segments()")).includes("origin"), "segments lists origin"));

await withPage("=attr sets a dom attribute", async (page) => {
  await put(page, '=dom("a", attr("href", "https://plastron.ca/"), "go")');
  ok(await page.$('td.cell[data-key="元"] a[href="https://plastron.ca/"]'), "the <a> rendered with the href attribute");
});

await withPage('=save("slot") + =open("slot") round-trips a named sheet', async (page) => {
  await put(page, "=cels(2, 2)");
  await put(page, "42", "g2x2.A1");
  ok(/^saved/.test(String(await put(page, '=save("slotA")'))), "saved to slotA");
  await put(page, "99", "g2x2.A1");
  eq(await cel(page, "g2x2.A1"), 99, "value mutated to 99");
  ok(/^opened/.test(String(await put(page, '=open("slotA")'))), "opened slotA");
  eq(await cel(page, "g2x2.A1"), 42, "open restored the saved value");
});

await withPage("a syntax error surfaces, stays editing", async (page) => {
  await put(page, '=cels("in" 4 3)');
  ok(/expected|infix/.test(String(await cel(page, "元.error"))), "parse error captured");
  eq(await cel(page, "元.editing"), "元", "stays in the cell");
  ok(await page.$(".cell-error"), "error line rendered");
});

await withPage("click a cell to edit it", async (page) => {
  await put(page, "=cels(2, 2)");
  await page.click('td.cell[data-key="g2x2.A1"] .cell-value');
  await page.waitForTimeout(80);
  ok(await page.$('td.cell[data-key="g2x2.A1"] textarea.cell-edit'), "click opens the expandable editor");
});

await withPage("clearing 元 restores the desktop", async (page) => {
  await put(page, "=1 + 1");
  await put(page, "");
  await page.waitForTimeout(140);
  ok(await page.$('.pl-window[data-win="win.readme.state"]'), "clearing 元 restores the desktop (readme window)");
  ok(await page.$(".readme canvas"), "readme canvas back");
});

await withPage("=mount targets existing nodes only (no top/bottom regions)", async (page) => {
  await put(page, '(mount ".origin" (dom "h3.pinned" "at origin"))');
  ok(await page.$(".origin h3.pinned"), "mounts to the existing .origin node");
  await put(page, '(mount "top" (dom "h3.ghost" "x"))');
  ok(!(await page.$("h3.ghost")), '"top" matches nothing now → not placed');
});

await withPage("wide mounted content is reachable (body grows to fit)", async (page) => {
  await put(page, '(mount ".origin" (dom "div.wide" (style "width" "3000px") "wide"))');
  const fits = await page.evaluate(() => document.body.scrollWidth >= 3000);
  ok(fits, "body widened to fit a 3000px child (horizontal scroll, not clipped)");
});

// =cdn(url) — load an external library at runtime via the kernel primitive.
await withPage("=cdn(url) loads an external library (needs network)", async (page) => {
  const res = String(await put(page, '=cdn("https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js")'));
  ok(/^loaded /.test(res), "cdn confirms the load");
  ok(await page.evaluate(() => typeof (globalThis as any).confetti === "function"), "the loaded lib's global is available");
});

// Python — the py-compiler pulls Pyodide from a CDN on first use (via the
// kernel loadScript primitive), so the first def is slow + needs network.
await withPage("=def(py) + call works via Pyodide", async (page) => {
  const out = await page.evaluate(async () => {
    const { state, resolveFn } = (globalThis as any).plastron;
    const put = async (s: string) => { await resolveFn(state, "origin.edit")(state, "元"); await resolveFn(state, "setValue")(state, "元.draft", s); await resolveFn(state, "origin.run")(state, "元"); };
    await put('=def("sq", "py", "lambda x: x * x")');
    await put("=sq(6)");
    return { cel: state.cels.get("sq")?.celType, result: state.cels.get("元")?.v };
  });
  eq(out.cel, "EditableLambdaCel", "python function cel created");
  eq(out.result, 36, "=sq(6) → 36 (python)");
});

// ── xlsx — export + import round-trip + MATERIALIZE in a real browser (the
// ZIP+DEFLATE path runs through Chromium's Compression/DecompressionStream).
await withPage("xlsx — round-trips + materializes in the browser", async (page) => {
  const out = await page.evaluate(async () => {
    const { state, resolveFn } = (globalThis as any).plastron;
    const sc = (k: string, v: unknown, name: string) => resolveFn(state, "setCel")(state, k, { celType: "ValueCel", v, metadata: { key: k, segment: "sh", name } });
    await sc("sh.A1", "Widget", "A1"); await sc("sh.B1", 42, "B1");
    const b64 = await resolveFn(state, "xlsxexport")(state, "sh");
    const msg = await resolveFn(state, "xlsxload")(state, b64);
    return { msg, a1: state.cels.get("xlsx.A1")?.v, b1: state.cels.get("xlsx.B1")?.v };
  });
  eq(out.a1, "Widget", "imported A1 materialized in-browser");
  eq(out.b1, 42, "imported B1 materialized in-browser");
});

// ── windows — every worksheet renders as a draggable/resizable WINDOW
// (sheetView wraps each table in a frame; geometry in win.geom). The cells
// inside stay a normal editable grid. Drags drive REAL pointer events.
await withPage("worksheets render as draggable windows (auto-windowing)", async (page) => {
  await page.evaluate(async () => {
    const { state, resolveFn } = (globalThis as any).plastron;
    await resolveFn(state, "origin.edit")(state, "\u5143");
    await resolveFn(state, "setValue")(state, "\u5143.draft", "=cels(3, 3)");
    await resolveFn(state, "origin.run")(state, "\u5143");
    await new Promise((r) => setTimeout(r, 160));
  });
  ok(await page.$('.pl-window[data-win="\u5143"]'), "\u5143 is a window");
  ok(await page.$('.pl-window[data-win="g3x3"]'), "the g3x3 worksheet is a window");
  ok(await page.$('.pl-window[data-win="g3x3"] table.grid td.cell'), "the sheet inside is a normal editable grid");
  const wsel = '.pl-window[data-win="g3x3"]';
  const before = await page.$eval(wsel, (el: HTMLElement) => el.style.left);
  const box = await (await page.$(`${wsel} .pl-titlebar`))!.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 70, box!.y + box!.height / 2 + 40, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(140);
  const after = await page.$eval(wsel, (el: HTMLElement) => el.style.left);
  ok(parseInt(after) > parseInt(before) + 40, `g3x3 window dragged (left ${before} -> ${after})`);
  const w0 = await page.$eval(wsel, (el: HTMLElement) => parseInt(el.style.width));
  const rh = await (await page.$(`${wsel} .pl-resize`))!.boundingBox();
  await page.mouse.move(rh!.x + rh!.width / 2, rh!.y + rh!.height / 2); await page.mouse.down();
  await page.mouse.move(rh!.x + 60, rh!.y + 30, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(140);
  const w1 = await page.$eval(wsel, (el: HTMLElement) => parseInt(el.style.width));
  ok(w1 > w0 + 30, `g3x3 window resized wider (${w0} -> ${w1})`);
})

// ── peer — TWO browsers share a cel over WebRTC. Manual signaling is brokered
// by the test (copy A's offer → B, B's answer → A); ICE uses localhost host
// candidates (same machine), so no STUN/TURN. Confirms a setValue propagates
// A→B through the security gate, and that an executable value does NOT cross.
{
  console.log("\n▶ peer — two browsers share a cel over WebRTC");
  const A = await browser.newPage();
  const B = await browser.newPage();
  const errs: string[] = [];
  for (const p of [A, B]) { p.on("pageerror", (e) => errs.push(String(e))); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); }); }
  const boot = async (p: Page): Promise<void> => { await p.goto("file://" + bundle); await p.waitForFunction(() => !!(globalThis as { plastron?: unknown }).plastron, { timeout: 8000 }); };
  try {
    await boot(A); await boot(B);
    // both sides share the "shared." namespace
    for (const p of [A, B]) await p.evaluate(() => { const { state, resolveFn } = (globalThis as any).plastron; return resolveFn(state, "peerallow")("shared."); });
    // brokered signaling: A offers → B answers → A accepts
    const offer = await A.evaluate(() => { const { state, resolveFn } = (globalThis as any).plastron; return resolveFn(state, "peerOffer")(state); });
    ok(typeof offer === "string" && offer.includes("sdp"), "A minted a WebRTC offer (SDP)");
    const answer = await B.evaluate((o) => { const { state, resolveFn } = (globalThis as any).plastron; return resolveFn(state, "peerAnswer")(state, o); }, offer);
    await A.evaluate((a) => { const { state, resolveFn } = (globalThis as any).plastron; return resolveFn(state, "peerAccept")(state, a); }, answer);
    // wait for A's data channel to open (poll — localhost ICE connects in ~1s)
    let opened = false;
    for (let i = 0; i < 16 && !opened; i++) { await A.waitForTimeout(500); opened = await A.evaluate(() => (globalThis as { __peerOpen?: boolean }).__peerOpen === true); }
    ok(opened, "A's WebRTC data channel opened (ICE connected)");
    // AUTO-SYNC: a plain setValue to a shared cel propagates — no explicit peersend.
    await A.evaluate(() => { const { state, resolveFn } = (globalThis as any).plastron; resolveFn(state, "setCel")(state, "shared.x", { celType: "ValueCel", v: 0, metadata: { key: "shared.x", segment: "shared" } }); });
    await A.evaluate(() => { const { state, resolveFn } = (globalThis as any).plastron; return resolveFn(state, "setValue")(state, "shared.x", 42); });
    let got: unknown = null;
    for (let i = 0; i < 16 && got !== 42; i++) { await B.waitForTimeout(500); got = await B.evaluate(() => (globalThis as any).plastron.state.cels.get("shared.x")?.v ?? null); }
    ok(got === 42, `B received shared.x=42 via AUTO-SYNC, no peersend (got ${JSON.stringify(got)})`);
    // BIDIRECTIONAL + ECHO GUARD: B edits, A receives; if the echo looped this
    // would storm — instead both converge to 99.
    await B.evaluate(() => { const { state, resolveFn } = (globalThis as any).plastron; return resolveFn(state, "setValue")(state, "shared.x", 99); });
    let back: unknown = null;
    for (let i = 0; i < 16 && back !== 99; i++) { await A.waitForTimeout(500); back = await A.evaluate(() => (globalThis as any).plastron.state.cels.get("shared.x")?.v ?? null); }
    ok(back === 99, `A received B's edit shared.x=99 (bidirectional, no echo storm) (got ${JSON.stringify(back)})`);
    // QUARANTINE over the wire: an executable value never crosses.
    await A.evaluate(() => { const { state, resolveFn } = (globalThis as any).plastron; resolveFn(state, "setCel")(state, "shared.evil", { celType: "ValueCel", v: 0, metadata: { key: "shared.evil", segment: "shared" } }); return resolveFn(state, "setValue")(state, "shared.evil", { defn: true }); });
    await A.waitForTimeout(1500);
    const evil = await B.evaluate(() => (globalThis as any).plastron.state.cels.get("shared.evil")?.v ?? null);
    ok(evil === null, "B did NOT receive the executable value (quarantine holds over the wire)");
    ok(errs.length === 0, `no console/page errors${errs.length ? ` (${errs.slice(0, 2).join(" | ")})` : ""}`);
  } catch (e) {
    ok(false, `peer e2e threw: ${String(e).slice(0, 160)}`);
  } finally {
    await A.close(); await B.close();
  }
}

// ── peer via RELAY — automatic signaling (no SDP copy/paste). An in-process
// signal-server brokers; two pages peerjoin the same room and connect.
{
  console.log("\n▶ peer — relay signaling (peerjoin a room)");
  const { startSignalServer } = await import("../../signal-server.ts");
  const relay = startSignalServer(0);
  const A = await browser.newPage();
  const B = await browser.newPage();
  try {
    for (const p of [A, B]) {
      await p.goto("file://" + bundle);
      await p.waitForFunction(() => !!(globalThis as { plastron?: unknown }).plastron, { timeout: 8000 });
      await p.evaluate(() => { const { state, resolveFn } = (globalThis as any).plastron; return resolveFn(state, "peerallow")("shared."); });
    }
    const url = `ws://localhost:${relay.port}`;
    await A.evaluate((u) => { const { state, resolveFn } = (globalThis as any).plastron; return resolveFn(state, "peerjoin")(state, "room1", u); }, url);
    await A.waitForTimeout(300);                       // A is the existing member before B arrives
    await B.evaluate((u) => { const { state, resolveFn } = (globalThis as any).plastron; return resolveFn(state, "peerjoin")(state, "room1", u); }, url);
    let opened = false;
    for (let i = 0; i < 24 && !opened; i++) { await A.waitForTimeout(500); opened = await A.evaluate(() => (globalThis as { __peerOpen?: boolean }).__peerOpen === true); }
    ok(opened, "relay-signaled peers connected (no SDP copy/paste)");
    await A.evaluate(() => { const { state, resolveFn } = (globalThis as any).plastron; resolveFn(state, "setCel")(state, "shared.r", { celType: "ValueCel", v: 0, metadata: { key: "shared.r", segment: "shared" } }); return resolveFn(state, "setValue")(state, "shared.r", 7); });
    let got: unknown = null;
    for (let i = 0; i < 16 && got !== 7; i++) { await B.waitForTimeout(500); got = await B.evaluate(() => (globalThis as any).plastron.state.cels.get("shared.r")?.v ?? null); }
    ok(got === 7, `B received shared.r=7 over the relay-signaled channel (got ${JSON.stringify(got)})`);
  } catch (e) {
    ok(false, `relay e2e threw: ${String(e).slice(0, 160)}`);
  } finally {
    await A.close(); await B.close(); relay.stop();
  }
}

// ── windows — one-step =win(...) makes a draggable window (genesis → reactive)
await withPage("=win(...) makes a draggable window in one step", async (page) => {
  await page.evaluate(async () => {
    const { state, resolveFn } = (globalThis as any).plastron;
    await resolveFn(state, "origin.edit")(state, "\u5143");
    await resolveFn(state, "setValue")(state, "\u5143.draft", '=win("w1", "Demo", "drag my titlebar")');
    await resolveFn(state, "origin.run")(state, "\u5143");
    await new Promise((r) => setTimeout(r, 160));
  });
  ok(await page.$(".pl-window"), "=win rendered a window");
  const box = await (await page.$(".pl-titlebar"))!.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 50, box!.y + box!.height / 2 + 30, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(140);
  const left = await page.$eval(".pl-window", (el: HTMLElement) => el.style.left);
  ok(left !== "80px", `=win window is draggable (left now ${left}, was 80px)`);
});

await browser.close();
console.log(`\n${fails === 0 ? "🟢" : "🔴"} ${passes} passing, ${fails} failing`);
process.exit(fails === 0 ? 0 : 1);
