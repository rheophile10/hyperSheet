// report — turn the latest run into a human-readable REPORT.md you can open:
// per task, per provider (grok/claude/chatgpt), the plastron.ca links + the
// validity verdict + the vision-judge scores. Joins last-run.json (run.ts) with
// scores.json (score.ts, optional). Run AFTER: run.ts [→ render.ts → score.ts].
//   bun report.ts            → writes REPORT.md next to this file
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lastRunPath = join(here, "last-run.json");
if (!existsSync(lastRunPath)) { console.error("no last-run.json — run `bun run.ts` first"); process.exit(1); }

type Run = { model: string; ok: boolean; kind: string; note: string; formula: string | null; urlF: string | null; urlRaw: string | null; reply: string };
const runs = JSON.parse(readFileSync(lastRunPath, "utf8")) as Record<string, Run>;
const tasks = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8")) as { id: string; prompt: string }[];

type ScoreRow = { key: string; score: { satisfaction?: number; layout?: number; usability?: number; notes?: string; error?: string } };
const scores: Record<string, ScoreRow["score"]> = {};
if (existsSync(join(here, "scores.json"))) {
  for (const r of JSON.parse(readFileSync(join(here, "scores.json"), "utf8")) as ScoreRow[]) scores[r.key] = r.score;
}

const PROVIDERS = ["grok", "claude", "chatgpt"];
const s = (v: unknown) => (typeof v === "number" && !Number.isNaN(v) ? `${v}/5` : "—");
const md: string[] = [
  "# plastron LLM-eval report",
  "",
  "Each model is fed the canonical system prompt **[`../llms.md`](../llms.md)** (also served at https://plastron.ca/llms.txt) plus the task, then its formula is validated against the real kernel, rendered headless, and scored by a vision judge.",
  "",
  "- **valid?** = parsed + evaluated without error (validity ≠ satisfies)",
  "- **sat / layout / use** = vision-judge scores (satisfaction, page layout, usability), 1–5",
  "- Open a link to see what the model built. `#f=` = compressed share link; `#raw=` = readable.",
  "",
];

for (const task of tasks) {
  md.push(`## ${task.id}`, "", `> ${task.prompt}`, "");
  for (const provider of PROVIDERS) {
    const r = runs[`${task.id}:${provider}`];
    md.push(`### ${provider}` + (r?.model ? ` \`${r.model}\`` : ""));
    if (!r) { md.push("", "_skipped (no API key — add it to `.env`)_", ""); continue; }
    const sc = scores[`${task.id}:${provider}`];
    md.push("");
    const kindLabel: Record<string, string> = { "raw-link": "🔗 #raw= link", "f-link": "🔗 #f= compressed link", "encrypted-link": "🔒 encrypted link", formula: "ƒ formula (to run)", none: "—", "no-reply": "—" };
    md.push(`- output kind: **${kindLabel[r.kind] ?? r.kind}**`);
    md.push(`- valid? **${r.ok ? "✅ yes" : "❌ no"}** — ${r.note}`);
    if (sc) md.push(`- scores: sat **${s(sc.satisfaction)}**, layout **${s(sc.layout)}**, use **${s(sc.usability)}**${sc.notes ? ` — _${sc.notes}_` : ""}${sc.error ? ` — judge error: ${sc.error}` : ""}`);
    if (r.formula) md.push("", "```", r.formula, "```");
    if (r.urlF) md.push(`- 🔗 **share link:** ${r.urlF}`);
    if (r.urlRaw) md.push(`- 🔗 **raw link:** ${r.urlRaw}`);
    md.push("");
  }
}

const out = join(here, "REPORT.md");
writeFileSync(out, md.join("\n"));
console.log(`wrote ${out}`);
