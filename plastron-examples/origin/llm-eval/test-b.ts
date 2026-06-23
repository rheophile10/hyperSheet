// test-b — "WHERE do LLMs look?" Instead of handing the model the guide, we give
// it a fetch(url) tool and only "the docs are at plastron.ca", then log which URLs
// it requests. The fetch tool is INTERCEPTED: plastron.ca/llms.txt → the built
// llms.txt, plastron.ca/ (or index.html) → the raw HTML, a github README url → the
// repo README; anything else → 404. So we measure (a) which channel the model
// reaches for first, (b) whether it finds enough to produce a viable formula.
//
//   bun test-b.ts                 default probe task (play-c)
//   bun test-b.ts navbar          a harder task
// Uses OpenAI-shaped tool calling (grok + openai). Writes test-b.json.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_TASKS, MODES, composePrompt } from "./tasks.ts";
import { validate } from "./validate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

// Intercept a requested URL → local content (or a 404), and tag which channel it hit.
const serve = (url: string): { channel: string; body: string } => {
  const u = url.toLowerCase();
  if (u.includes("llms.txt")) return { channel: "llms.txt", body: read(join(here, "..", "dist", "llms.txt")) || "404" };
  if (u.includes("readme") || u.includes("github.com")) return { channel: "github-readme", body: read(join(repo, "README.md")) || "404" };
  if (u.includes("llms.md")) return { channel: "llms.md", body: read(join(here, "..", "llms.md")) || "404" };
  // bare site / index.html → the raw single-file HTML (what a naive GET returns)
  if (/plastron\.ca\/?($|index|#|\?)/.test(u) || u.endsWith("plastron.ca")) return { channel: "html", body: read(join(here, "..", "dist", "index.html")) || "404" };
  return { channel: "other", body: `404 Not Found: ${url}` };
};

const FETCH_TOOL = {
  type: "function",
  function: {
    name: "fetch",
    description: "HTTP GET a URL and return its text body. Use it to read documentation.",
    parameters: { type: "object", properties: { url: { type: "string", description: "absolute URL to GET" } }, required: ["url"] },
  },
};

const SYSTEM =
  "You write plastron formulas (a reactive spreadsheet substrate). You do NOT know plastron's verbs yet. " +
  "Its documentation lives at the website plastron.ca. Use the fetch tool to read whatever you need before answering. " +
  "When you can answer, output ONLY the plastron formula.";

interface Provider { name: string; base: string; key: string | undefined; model: string }
const providers: Provider[] = [
  { name: "grok",    base: "https://api.x.ai/v1",     key: process.env.XAI_API_KEY?.trim(),    model: process.env.XAI_MODEL || "grok-4" },
  { name: "chatgpt", base: "https://api.openai.com/v1", key: process.env.OPENAI_API_KEY?.trim(), model: process.env.OPENAI_MODEL || "gpt-5" },
];

const MAX_STEPS = 6;

const runProvider = async (p: Provider, userTask: string) => {
  if (!p.key) return { provider: p.name, model: p.model, skipped: true, requests: [], channels: [], viable: null, formula: null };
  const messages: unknown[] = [{ role: "system", content: SYSTEM }, { role: "user", content: userTask }];
  const requests: string[] = []; const channels: string[] = [];
  let finalText: string | null = null;
  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await fetch(`${p.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
      body: JSON.stringify({ model: p.model, messages, tools: [FETCH_TOOL], tool_choice: "auto" }),
    });
    if (!resp.ok) return { provider: p.name, model: p.model, error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 160)}`, requests, channels, viable: null, formula: null };
    const j = await resp.json() as { choices?: { message?: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
    const msg = j.choices?.[0]?.message;
    if (!msg) break;
    messages.push(msg);
    const calls = msg.tool_calls ?? [];
    if (!calls.length) { finalText = msg.content ?? null; break; }
    for (const c of calls) {
      let url = ""; try { url = JSON.parse(c.function.arguments || "{}").url ?? ""; } catch { /* */ }
      const { channel, body } = serve(url);
      requests.push(url); channels.push(channel);
      console.log(`    ${p.name} → fetch ${url}  [${channel}, ${body.length} B]`);
      // cap the returned body so a 3 MB HTML doesn't blow the context — a naive fetcher truncates too.
      messages.push({ role: "tool", tool_call_id: c.id, content: body.slice(0, 60_000) });
    }
  }
  const v = finalText ? await validate(finalText) : null;
  return { provider: p.name, model: p.model, requests, channels, viable: v?.ok ?? null, formula: v?.formula ?? null, finalText };
};

const taskId = process.argv[2] || "play-c";
const base = BASE_TASKS.find((t) => t.id === taskId) ?? BASE_TASKS.find((t) => t.id === "play-c")!;
const userTask = composePrompt(base, MODES.find((m) => m.id === "formula")!);

console.log(`\n=== Test B: where do LLMs look? — task "${base.id}" ===\n${userTask}\n`);
const results = [];
for (const p of providers) {
  console.log(`\n--- ${p.name} (${p.model}) ---`);
  const r = await runProvider(p, userTask);
  if (r.skipped) { console.log(`  skipped (no key)`); continue; }
  if (r.error) { console.log(`  error: ${r.error}`); }
  console.log(`  channels hit (in order): ${r.channels.join(" → ") || "(none — answered without fetching)"}`);
  console.log(`  viable formula: ${r.viable === null ? "—" : r.viable ? "✔" : "✘"}  ${String(r.formula ?? "").slice(0, 70)}`);
  results.push(r);
}

writeFileSync(join(here, "test-b.json"), JSON.stringify({ task: base.id, results }, null, 2));
console.log(`\n=== which channel each model reached for is in test-b.json ===`);
