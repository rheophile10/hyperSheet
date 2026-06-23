// webllm-eval — run the SAME tasks through plastron's OWN bundled in-browser model
// (WebLLM Qwen2.5-0.5B on WebGPU), driven in real chromium. Feeds llms.md as the
// system prompt and each task as the user turn via the page's localchat verb, then
// validates + appends to results.csv as provider "local-browser". This doubles as
// the end-to-end test the local LLM segment never had.
//
// Needs a WebGPU-capable browser (a real GPU — e.g. the 3090). On a GPU-less CI box
// localcheck() reports canRun:false and we skip with the reason. First run downloads
// ~400 MB of weights (cached after).
//   bun webllm-eval.ts            all tasks (formula mode)
//   bun webllm-eval.ts keyboard   one task
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_TASKS, MODES, composePrompt } from "./tasks.ts";
import { validate } from "./validate.ts";
import { snapshotGuide } from "./version.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const CSV = join(here, "results.csv");
const HEADER = ["ts","guide_version","source","provider","model","task","mode","valid","mode_ok","task_fit","idiomatic","render","kind","judge_notes","validate_note","formula","prompt","raw_output"];
const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const PORT = 8799;
const MODEL = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";

const onlyTask = process.argv[2];
const tasks = onlyTask ? BASE_TASKS.filter((t) => t.id === onlyTask) : BASE_TASKS;
const formula = MODES.find((m) => m.id === "formula")!;
const guide = snapshotGuide();

if (!existsSync(join(dist, "index.html"))) { console.error("no dist/index.html — run `bun bundle.ts` first"); process.exit(1); }
if (!existsSync(CSV)) writeFileSync(CSV, HEADER.join(",") + "\n");

const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

// WebGPU needs real GPU bits; these flags enable it where a GPU/driver exists.
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-webgpu",
         "--enable-features=Vulkan,WebGPU", "--use-angle=vulkan", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
page.setDefaultTimeout(600_000);   // model download (~400 MB) + slow inference
const errs: string[] = []; page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!(globalThis as { plastron?: unknown }).plastron, { timeout: 10000 });

const cap = await page.evaluate(async () => {
  const { state, resolveFn } = (globalThis as { plastron: { state: unknown; resolveFn: (s: unknown, k: string) => (...a: unknown[]) => unknown } }).plastron;
  await resolveFn(state, "ensureSegments")(state, ["llm"]);
  return await resolveFn(state, "localcheck")();
}) as { webgpu: boolean; canRun: boolean; reason: string };

console.log(`localcheck → webgpu=${cap.webgpu} canRun=${cap.canRun} (${cap.reason})`);

if (!cap.canRun) {
  console.log(`\n⚠ in-browser model can't run here — ${cap.reason}.`);
  console.log(`  This box has no usable WebGPU. Run this on the 3090 (a real GPU + a Chrome with WebGPU)`);
  console.log(`  to download Qwen2.5-0.5B (~400 MB) and score it into results.csv.`);
  await browser.close(); srv.kill(); process.exit(0);   // a SKIP, not a failure
}

const ts = new Date().toISOString();
let appended = 0;
for (const task of tasks) {
  const prompt = composePrompt(task, formula);
  process.stdout.write(`\n${task.id} · local-browser … `);
  let reply = "";
  try {
    reply = await page.evaluate(async ([sys, usr]) => {
      const { state, resolveFn } = (globalThis as { plastron: { state: unknown; resolveFn: (s: unknown, k: string) => (...a: unknown[]) => unknown } }).plastron;
      return String(await resolveFn(state, "localchat")(usr, sys));   // (prompt, system)
    }, [guide.source, prompt]);
  } catch (e) { reply = `#ERROR ${String((e as { message?: unknown })?.message ?? e)}`; }
  const v = await validate(reply);
  const ok = v.kind === "formula";
  appendFileSync(CSV, [ts, guide.id, "llms.md", "local-browser", MODEL, task.id, "formula",
    v.ok ? 1 : 0, ok ? 1 : 0, "", "", "", v.kind, "", v.note, v.formula, prompt, reply].map(esc).join(",") + "\n");
  appended++;
  console.log(`valid=${v.ok ? "✔" : "✘"}  ${String(v.formula ?? reply).slice(0, 60)}`);
}

console.log(`\n=== appended ${appended} local-browser rows to results.csv ===`);
await browser.close(); srv.kill(); process.exit(0);
