// research — does the LLM USE plastron's introspection (vocab/inspect/members/
// segments) to discover verbs that AREN'T in the system prompt, instead of
// guessing? Unlike run.ts (single-shot), this gives the four research verbs as
// callable TOOLS, answered by a live headless plastron, and sets tasks that need
// an UNDOCUMENTED-but-loaded verb (e.g. a force-directed graph is `fgview`, not
// the guessable `forcegraph`). We record which tools it called + whether the
// final formula works.  bun research.ts            (all research tasks, all keyed providers)
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInitialState, resolveFn, setPainter } from "../../../plastron/dist/index.js";
import { vocabText } from "../../../plastron/dist/甲骨坑/application/origin/index.js";
import { validate } from "./validate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const env = (k: string, d = "") => process.env[k]?.trim() || d;
type Fn = (...a: unknown[]) => unknown;

// one live plastron to ANSWER the research tools (and it's the same kernel the
// validator boots, so what inspect() reports is what the formula will hit).
const st = createInitialState() as Record<string, unknown> & { cels: Map<string, { celType: string; f?: string; v?: unknown; metadata: Record<string, unknown> }> };
setPainter(st as never, { enqueue: () => {} } as never);
await (resolveFn(st as never, "ensureSegments") as Fn)(st, ["origin"]);
await (resolveFn(st as never, "hydrate") as Fn)(st, [], []);

const TOOLS = [
  { type: "function", function: { name: "vocab", description: "List plastron verbs (name + one-line doc), grouped by segment. Optional segment filter.", parameters: { type: "object", properties: { segment: { type: "string", description: "optional segment to filter to, e.g. 'charts'" } } } } },
  { type: "function", function: { name: "inspect", description: "Full doc for ONE verb: signature + description.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
  { type: "function", function: { name: "members", description: "List the cels in a segment.", parameters: { type: "object", properties: { segment: { type: "string" } }, required: ["segment"] } } },
  { type: "function", function: { name: "segments", description: "List every loaded segment.", parameters: { type: "object", properties: {} } } },
];

const runTool = (name: string, args: Record<string, unknown>): string => {
  if (name === "vocab") return vocabText(st as never, String(args.segment ?? "")).slice(0, 6000);
  if (name === "segments") { const s = new Set<string>(); for (const [, c] of st.cels) s.add(String(c.metadata.segment ?? "?")); return [...s].sort().join(", "); }
  if (name === "members") { const seg = String(args.segment ?? ""); const ks = [...st.cels].filter(([k, c]) => c.metadata.segment === seg && !k.includes(".")).map(([k]) => k); return ks.length ? ks.sort().join(", ") : `no cels in segment "${seg}"`; }
  if (name === "inspect") { const c = st.cels.get(String(args.name ?? "")); if (!c) return `no such verb "${args.name}" — try vocab() to list real names`; return JSON.stringify({ key: args.name, celType: c.celType, description: c.metadata.description, f: c.f }).slice(0, 2000); }
  return `unknown tool ${name}`;
};

interface Provider { id: string; base: string; keyVar: string; model: string }
const PROVIDERS: Provider[] = [
  { id: "grok", base: "https://api.x.ai/v1", keyVar: "XAI_API_KEY", model: env("XAI_MODEL", "grok-4") },
  { id: "chatgpt", base: "https://api.openai.com/v1", keyVar: "OPENAI_API_KEY", model: env("OPENAI_MODEL", "gpt-5") },
  { id: "claude", base: "", keyVar: "ANTHROPIC_API_KEY", model: env("ANTHROPIC_MODEL", "claude-opus-4-8") }, // OpenAI-shaped only; claude skipped here
];

const SYSTEM = readFileSync(join(here, "..", "llms.md"), "utf8") +
  "\n\nYou have CALLABLE TOOLS: vocab, inspect, members, segments. The verb you need may NOT be in the guide above — use these tools to discover the real verb name and signature BEFORE writing the formula. Do not guess a verb that might not exist. When done, reply with ONLY the final plastron formula.";

const TASKS = [
  { id: "research-forcegraph", prompt: "Render a force-directed graph of a few connected nodes (e.g. A–B, B–C, C–A). The verb is NOT named what you'd expect — discover it. Output ONLY the final formula." },
  { id: "research-piechart", prompt: "Make a pie chart of three labeled values (Apples 10, Pears 20, Plums 15). Output ONLY the final formula." },
];

// one tool-use conversation; returns { toolsUsed, rounds, formula, ok, note }
const converse = async (p: Provider, task: { id: string; prompt: string }) => {
  const key = env(p.keyVar);
  if (!key || !p.base) return { provider: p.id, task: task.id, skipped: true } as const;
  const messages: Record<string, unknown>[] = [{ role: "system", content: SYSTEM }, { role: "user", content: task.prompt }];
  const toolsUsed: string[] = [];
  let rounds = 0;
  for (let i = 0; i < 6; i++) {
    rounds = i + 1;
    const resp = await fetch(`${p.base}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: p.model, messages, tools: TOOLS, tool_choice: "auto" }),
    });
    if (!resp.ok) return { provider: p.id, task: task.id, error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 160)}` };
    const j = await resp.json() as { choices?: { message?: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
    const msg = j.choices?.[0]?.message;
    if (!msg) return { provider: p.id, task: task.id, error: "no message" };
    if (msg.tool_calls?.length) {
      messages.push(msg as Record<string, unknown>);
      for (const tc of msg.tool_calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* ignore */ }
        toolsUsed.push(tc.function.name + (args.segment ? `(${args.segment})` : args.name ? `(${args.name})` : "()"));
        messages.push({ role: "tool", tool_call_id: tc.id, content: runTool(tc.function.name, args) });
      }
      continue;
    }
    const v = await validate(msg.content ?? "");
    return { provider: p.id, task: task.id, toolsUsed, rounds, formula: v.formula, ok: v.ok, note: v.note, reply: msg.content };
  }
  return { provider: p.id, task: task.id, toolsUsed, rounds, error: "tool loop did not converge in 6 rounds" };
};

const results: Record<string, unknown> = {};
for (const task of TASKS) {
  console.log(`\n=== ${task.id} ===`);
  for (const p of PROVIDERS) {
    const r = await converse(p, task);
    results[`${task.id}:${p.id}`] = r;
    if ("skipped" in r) { console.log(`  ${p.id.padEnd(8)} — skipped (no key)`); continue; }
    if ("error" in r && r.error) { console.log(`  ${p.id.padEnd(8)} ✘ ${r.error}`); continue; }
    const used = (r.toolsUsed && r.toolsUsed.length) ? r.toolsUsed.join(" → ") : "(NONE — guessed)";
    console.log(`  ${p.id.padEnd(8)} ${r.ok ? "✔ VIABLE" : "✘ FAIL"}  researched: ${used}`);
    if (r.formula) console.log(`           ${String(r.formula).slice(0, 90)}`);
  }
}
writeFileSync(join(here, "research-run.json"), JSON.stringify(results, null, 2));
console.log(`\nfull → ${join(here, "research-run.json")}`);
