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
  const kdist = join(repoRoot, "../../plastron-simple/dist/index.js");
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

const browser: Browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });

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
    await resolveFn(state, "origin.commit")(state, k);
    await new Promise((r) => setTimeout(r, 60));
    return state.cels.get(k)?.v ?? null;
  }, [src, key] as [string, string]);

const cel = (page: Page, key: string): Promise<unknown> =>
  page.evaluate((k) => (globalThis as any).plastron.state.cels.get(k)?.v ?? null, key);

// ── cases ───────────────────────────────────────────────────────────────────

await withPage("boot — canvas readme renders + draws", async (page) => {
  const mount = await cel(page, "元");
  eq((mount as { __mount?: string })?.__mount, "top", "元 is a mount placement");
  ok(await page.$(".readme"), "readme card rendered");
  const canvas = await page.$(".readme canvas");
  ok(canvas, "canvas banner element present");
  ok(await page.evaluate(() => !!document.querySelector(".readme")?.textContent?.includes("every formula starts with =")), "intro text present");
  // pixels were drawn (banner has a filled background + bars)
  const drawn = await page.evaluate(() => {
    const c = document.querySelector(".readme canvas") as HTMLCanvasElement;
    const ctx = c.getContext("2d")!; const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonzero = 0; for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) nonzero++;
    return nonzero;
  });
  ok(drawn > 1000, `canvas actually painted (${drawn} opaque px)`);
});

await withPage("=1 + 1 → 2", async (page) => eq(await put(page, "=1 + 1"), 2, "arithmetic"));

await withPage("literal 7 → 7", async (page) => eq(await put(page, "7"), 7, "literal number"));

await withPage("=grid(8, 5) → one sheet", async (page) => {
  await put(page, "=grid(8, 5)");
  ok(await cel(page, "g8x5.A1") !== null, "g8x5.A1 created");
  ok(await cel(page, "g8x5.E8") !== null, "g8x5.E8 created");
  eq(await page.evaluate(() => document.querySelectorAll("table.grid").length), 1, "one grid table");
});

await withPage("=grid(\"in\",4,3,\"out\",4,3) → workbook", async (page) => {
  await put(page, '=grid("in", 4, 3, "out", 4, 3)');
  ok(await cel(page, "in.A1") !== null, "in.A1 created");
  ok(await cel(page, "out.C4") !== null, "out.C4 created");
  eq(await page.evaluate(() => document.querySelectorAll("table.grid").length), 2, "two sheets");
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

await withPage("=mount(\".sheet\", …) splices under .sheet", async (page) => {
  await put(page, '=mount(".sheet", dom("p.pinned", "under the cells"))');
  ok(await page.$(".sheet p.pinned"), "pinned under .sheet");
});

await withPage("=inspect(\"mount\") → yaml", async (page) => {
  const v = String(await put(page, '=inspect("mount")'));
  ok(/^name: mount/m.test(v) && /signature:/.test(v) && /source:/.test(v), "yaml with name/signature/source");
});

await withPage("=segments() lists origin", async (page) => ok(String(await put(page, "=segments()")).includes("origin"), "origin listed"));

await withPage("=vocab(\"origin\") lists the vocabulary", async (page) => {
  const v = String(await put(page, '=vocab("origin")'));
  ok(/\bgrid\b/.test(v) && /\bdom\b/.test(v) && /\bdef\b/.test(v) && /\bgrok\b/.test(v), "grid/dom/def/grok listed");
});

await withPage("=checkpoint(\"safe\") does not error", async (page) => {
  await put(page, '=checkpoint("safe")');
  eq(await cel(page, "元.error"), null, "no error");
});

await withPage("=load(\"sheet\") loads a library", async (page) => ok(String(await put(page, '=load("sheet")')).includes("loaded"), "load confirms"));

await withPage("=grok no-key path is friendly (no network)", async (page) => {
  const v = String(await put(page, '=grok("hi", "")'));
  ok(/no api key/.test(v), "helpful no-key message");
  // request shape is correct (used when a key is present)
  const req = await page.evaluate(() => (globalThis as any).plastron.resolveFn((globalThis as any).plastron.state, "grok")("say hi", "xai-KEY"));
  eq((req as any).url, "https://api.x.ai/v1/chat/completions", "grok targets xAI");
  eq((req as any).prompt, "say hi", "prompt carried");
});

await withPage("a syntax error surfaces, stays editing", async (page) => {
  await put(page, '=grid("in" 4 3)');
  ok(/expected|infix/.test(String(await cel(page, "元.error"))), "parse error captured");
  eq(await cel(page, "元.editing"), "元", "stays in the cell");
  ok(await page.$(".cell-error"), "error line rendered");
});

await withPage("click a cell to edit it", async (page) => {
  await page.click(".cell.zhorigin .cell-value");
  await page.waitForTimeout(80);
  ok(await page.$(".cell.zhorigin input.cell-edit"), "click opens the inline editor");
});

await withPage("clearing 元 restores the readme", async (page) => {
  await put(page, "=1 + 1");
  await put(page, "");
  eq((await cel(page, "元") as { __mount?: string })?.__mount, "top", "readme mount restored");
  ok(await page.$(".readme canvas"), "canvas banner back");
});

await browser.close();
console.log(`\n${fails === 0 ? "🟢" : "🔴"} ${passes} passing, ${fails} failing`);
process.exit(fails === 0 ? 0 : 1);
