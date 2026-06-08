// ============================================================================
// e2e/grok.mjs — can Grok drive plastron? We teach Grok the formula vocabulary
// (system prompt), ask it for a formula per task, run that formula in the real
// page, and assert the result. The Grok call is made from Node (no browser
// CORS); the formula runs in the browser via the `plastron` global.
//
//   bun e2e/grok.mjs        # needs e2e/.env with GROK_API_KEY=xai-… (gitignored)
// ============================================================================
import { chromium } from "playwright";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const repoRoot = join(here, "..");
const bundle = join(repoRoot, "dist/index.html");
const env = existsSync(join(here, ".env")) ? readFileSync(join(here, ".env"), "utf8") : "";
const KEY = (env.match(/GROK_API_KEY=(\S+)/) || [])[1];
if (!KEY) { console.error("no GROK_API_KEY in e2e/.env"); process.exit(2); }
if (!existsSync(bundle) || statSync(bundle).mtimeMs < statSync(join(repoRoot, "../../plastron/dist/index.js")).mtimeMs) {
  Bun.spawnSync(["bun", join(repoRoot, "bundle.ts")], { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
}

const SYSTEM = `You write a single formula for "plastron", a spreadsheet whose first cell is 元 (A1).
Syntax (start with = for the infix/Excel form, commas between args):
  =1 + 1                                         arithmetic
  =grid(8, 5)                                    a sheet of editable cels
  =grid("in", 4, 3, "out", 4, 3)                 a workbook of named sheets
  =def("double", "js", "x => x * 2")             define a JS function
  =double(21)                                    call a defined function
  =dom("h2", style("color", "tomato"), "hi")     a DOM element (style() is a child)
  =canvas(200, 80, rect(0,0,200,80,"#222"), text(10,40,"hi","#fff"))   a canvas
  =inspect("mount")   =segments()   =vocab("origin")   =save()
Reply with ONLY the formula — no prose, no markdown, no backticks, no explanation.`;

const askGrok = async (task, model = "grok-3-mini") => {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, temperature: 0, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: task }] }),
  });
  if (!res.ok) throw new Error(`grok ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  let f = String(j.choices?.[0]?.message?.content ?? "").trim();
  f = f.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/i, "").trim(); // strip fences if any
  return f.split("\n").find((l) => l.trim())?.trim() ?? f;           // first non-empty line
};

let pass = 0, fail = 0;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); };

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
await page.goto("file://" + bundle);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 8000 });
await page.waitForTimeout(300);

const celCount = () => page.evaluate(() => [...globalThis.plastron.state.cels.keys()].filter((k) => /\.[A-Z]+\d+$/.test(k)).length);
const run = (src, key = "元") => page.evaluate(async ([s, k]) => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "origin.edit")(state, k);
  await resolveFn(state, "setValue")(state, "元.draft", s);
  await resolveFn(state, "origin.commit")(state, k);
  await new Promise((r) => setTimeout(r, 80));
  return { v: state.cels.get(k)?.v, err: state.cels.get("元.error")?.v ?? null };
}, [src, key]);

// ── tasks: ask Grok, run its formula, assert ────────────────────────────────
console.log("▶ Grok writes a formula that computes 6 × 7");
{
  const f = await askGrok("Make a cell that computes six times seven.");
  console.log("   grok:", JSON.stringify(f));
  const r = await run(f);
  ok(r.err === null, "ran without a syntax error");
  ok(r.v === 42, `result is 42 (got ${JSON.stringify(r.v)})`);
}

console.log("▶ Grok writes a formula that makes a grid");
{
  const before = await celCount();
  const f = await askGrok("Make a 3 by 3 worksheet of cells.");
  console.log("   grok:", JSON.stringify(f));
  const r = await run(f);
  const after = await celCount();
  ok(r.err === null, "ran without a syntax error");
  ok(after >= before + 9, `created a 3x3 of cels (${before} → ${after})`);
}

console.log("▶ Grok writes a DOM heading");
{
  const f = await askGrok('Make a heading that says "hello" in tomato color.');
  console.log("   grok:", JSON.stringify(f));
  const r = await run(f);
  ok(r.err === null, "ran without a syntax error");
  ok(!!r.v && typeof r.v === "object" && /h[1-6]|div|p|span/.test(String(r.v.tag)), `produced a dom vnode (tag=${r.v?.tag})`);
}

console.log("▶ Grok defines a function, then calls it");
{
  const fdef = await askGrok('Define a JavaScript function named "triple" that multiplies its argument by 3.');
  console.log("   grok def:", JSON.stringify(fdef));
  const rd = await run(fdef);
  ok(rd.err === null, "def ran without error");
  const tripleExists = await page.evaluate(() => globalThis.plastron.state.cels.get("triple")?.celType === "EditableLambdaCel");
  ok(tripleExists, "a 'triple' function cel was created");
  if (tripleExists) {
    const rc = await run("=triple(5)");
    ok(rc.v === 15, `=triple(5) → 15 (got ${JSON.stringify(rc.v)})`);
  }
}

console.log(`\n${fail === 0 ? "🟢" : "🟡"} grok-driven: ${pass} passing, ${fail} failing  ${errs.length ? "(page errors: " + errs.slice(0, 2).join(" | ") + ")" : ""}`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
