// run — feed the plastron system prompt (llms.md) + each task to Claude / Grok /
// ChatGPT, then validate each reply against the real parser. Prints a matrix of
// who produced a viable formula/link, and saves the full replies for inspection.
//   bun run.ts                  (Bun auto-loads .env)
//   bun run.ts keyboard         (run a single task by id)
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callAll } from "./providers.ts";
import { validate } from "./validate.ts";
import { links } from "./links.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SYSTEM = readFileSync(join(here, "..", "llms.md"), "utf8");
const TASKS = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8")) as { id: string; prompt: string }[];

const only = process.argv[2];
const tasks = only ? TASKS.filter((t) => t.id === only) : TASKS;
if (!tasks.length) { console.error(`no task "${only}". known: ${TASKS.map((t) => t.id).join(", ")}`); process.exit(1); }

const rows: string[] = [];
const transcript: Record<string, unknown> = {};

for (const task of tasks) {
  console.log(`\n=== task: ${task.id} ===`);
  const replies = await Promise.all(callAll(SYSTEM, task.prompt));
  for (const reply of replies) {
    if (reply.skipped) { console.log(`  ${reply.provider.padEnd(8)} — skipped (no API key)`); continue; }
    if (reply.error)   { console.log(`  ${reply.provider.padEnd(8)} ✘ API error: ${reply.error.slice(0, 120)}`); rows.push(`${task.id} | ${reply.provider} | API-ERROR`); continue; }
    const v = await validate(reply.text);
    const mark = v.ok ? "✔ VIABLE" : "✘ " + v.kind;
    console.log(`  ${reply.provider.padEnd(8)} ${mark}  (${v.note})`);
    if (v.formula) console.log(`           ${v.formula.slice(0, 100)}`);
    // the whole point: a viable formula → the two shareable plastron URLs.
    const urls = v.ok && v.formula ? await links(v.formula) : null;
    if (urls) { console.log(`           #f=  ${urls.f}`); console.log(`           #raw=${urls.raw.slice(0, 110)}…`); }
    rows.push(`${task.id} | ${reply.provider} | ${v.ok ? "VIABLE" : "FAIL:" + v.kind}`);
    transcript[`${task.id}:${reply.provider}`] = { model: reply.model, ok: v.ok, kind: v.kind, note: v.note, formula: v.formula, urlF: urls?.f ?? null, urlRaw: urls?.raw ?? null, reply: reply.text };
  }
}

writeFileSync(join(here, "last-run.json"), JSON.stringify(transcript, null, 2));
console.log("\n=== summary (task | provider | result) ===");
console.log(rows.join("\n"));
console.log("\nfull replies → llm-eval/last-run.json");
