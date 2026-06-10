// ============================================================================
// e2e/claude-board.mjs — the one-paste claude chat board (README example).
//
// ONE formula pasted into 元 builds a chat surface: a key cel, prompt cells
// in chat column A, and reactive =claude(chat!An, setup!B1) cells in column B.
// claude() is a direct async native (NOT a drain request): the kernel awaits
// its Promise, the reply becomes the cell's value, and the formula survives —
// editing a prompt cel asks again. This file asserts the offline half of that
// loop unconditionally (no network: empty prompt/key short-circuit), and runs
// a real round-trip when e2e/.env has ANTHROPIC_API_KEY=sk-ant-….
//
//   bun e2e/claude-board.mjs
// ============================================================================
import { chromium } from "playwright";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const repoRoot = join(here, "..");
const bundle = join(repoRoot, "dist/index.html");
const env = existsSync(join(here, ".env")) ? readFileSync(join(here, ".env"), "utf8") : "";
const KEY = (env.match(/ANTHROPIC_API_KEY=(\S+)/) || [])[1];
if (!existsSync(bundle) || statSync(bundle).mtimeMs < statSync(join(repoRoot, "../../plastron/dist/index.js")).mtimeMs) {
  Bun.spawnSync(["bun", join(repoRoot, "bundle.ts")], { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
}

let pass = 0, fail = 0;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); };

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
await page.goto("file://" + bundle);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 8000 });
await page.waitForTimeout(300);

const put = (src, key = "元") => page.evaluate(async ([s, k]) => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "origin.edit")(state, k);
  await resolveFn(state, "setValue")(state, "元.draft", s);
  await resolveFn(state, "origin.commit")(state, k);
  await new Promise((r) => setTimeout(r, 120));
  return state.cels.get(k)?.v ?? null;
}, [src, key]);
const cel = (key) => page.evaluate((k) => {
  const c = globalThis.plastron.state.cels.get(k);
  return c ? c.v : "(missing)";
}, key);
const celType = (key) => page.evaluate((k) => globalThis.plastron.state.cels.get(k)?.celType ?? "(missing)", key);

// THE README EXAMPLE — keep in sync with README.md.
const BOARD = `=cels("setup", 1, 2, at("a1", "anthropic api key in B1 →"), "chat", 4, 2, at("a1", "ask claude about plastron here, then enter"), at("b1", "=claude(chat!A1, setup!B1)"), at("b2", "=claude(chat!A2, setup!B1)"), at("b3", "=claude(chat!A3, setup!B1)"), at("b4", "=claude(chat!A4, setup!B1)"))`;

console.log("▶ one-paste claude board (offline half)");
await put(BOARD);
await page.waitForTimeout(400);
ok(String(await cel("chat.A1")).includes("ask claude"), "board installed (chat.A1 hint present)");
ok(String(await cel("chat.B1")).includes("ask something") || String(await cel("chat.B1")).includes("no api key"),
  `B1 short-circuits without prompt/key (${String(await cel("chat.B1")).slice(0, 40)}…)`);
ok((await celType("chat.B1")) === "FormulaCel", "B1 stays a FormulaCel (reactive, not a one-shot drain result)");

await put("hello", "chat.A1");
await page.waitForTimeout(400);
ok(String(await cel("chat.B1")).includes("no api key"), "prompt without key → no-key message, no fetch");
ok((await celType("chat.B1")) === "FormulaCel", "B1 still a FormulaCel after refire");

if (!KEY) {
  console.log("  (no ANTHROPIC_API_KEY in e2e/.env — skipping the live round-trip)");
} else {
  console.log("▶ live round-trip");
  await put(KEY, "setup.B1");
  await put("reply with exactly the word: turtle", "chat.A1");
  await page.waitForFunction(() => {
    const v = globalThis.plastron.state.cels.get("chat.B1")?.v;
    return typeof v === "string" && !v.startsWith("(");
  }, { timeout: 30000 }).catch(() => {});
  const reply = String(await cel("chat.B1"));
  ok(/turtle/i.test(reply), `claude replied (${reply.slice(0, 60)})`);
  ok((await celType("chat.B1")) === "FormulaCel", "B1 survives the reply as a formula — edit A1 to ask again");
}

ok(errs.length === 0, `no page errors${errs.length ? ` (${errs[0]})` : ""}`);
await browser.close();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
