// matrix — the persistent scoreboard. Crosses BASE_TASKS × MODES × MODELS, feeding
// each model the canonical guide (llms.md) as system prompt + the composed task,
// then APPENDS one row per cell to results.csv (history accumulates across runs and
// guide versions). Each row carries: the llms.md version that produced it, the
// model, the prompt, the raw reply, the EXTRACTED formula (for #raw=/#f= modes the
// underlying formula is decoded and recorded), the objective verdicts, and the
// judged rubric scores.
//
//   bun matrix.ts                 all tasks × all modes × all configured models
//   bun matrix.ts keyboard        one base task
//   bun matrix.ts keyboard formula  one base task, one mode
//   GUIDE_SOURCE=path SOURCE_LABEL=llms.txt bun matrix.ts   (Test A: a different guide source)
import { appendFileSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_TASKS, MODES, composePrompt } from "./tasks.ts";
import { validate } from "./validate.ts";
import { judgeFormula } from "./rubric.ts";
import { snapshotGuide } from "./version.ts";
import { callAll } from "./providers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CSV = join(here, "results.csv");
const HEADER = [
  "ts", "guide_version", "source", "provider", "model", "task", "mode",
  "valid", "mode_ok", "task_fit", "idiomatic", "render",
  "kind", "judge_notes", "validate_note", "formula", "prompt", "raw_output",
];

const esc = (v: unknown): string => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const row = (cells: unknown[]): string => cells.map(esc).join(",") + "\n";

const modeOk = (modeId: string, kind: string, formula: string | null): boolean =>
  modeId === "formula" ? kind === "formula"
  : modeId === "raw" ? kind === "raw-link" && !!formula
  : modeId === "f" ? (kind === "f-link" && !!formula) || kind === "formula"   // formula fallback is allowed by the prompt
  : false;

// CLI filters
const onlyTask = process.argv[2];
const onlyMode = process.argv[3];
const tasks = onlyTask ? BASE_TASKS.filter((t) => t.id === onlyTask) : BASE_TASKS;
const modes = onlyMode ? MODES.filter((m) => m.id === onlyMode) : MODES;
if (!tasks.length) { console.error(`no task "${onlyTask}". known: ${BASE_TASKS.map((t) => t.id).join(", ")}`); process.exit(1); }
if (!modes.length) { console.error(`no mode "${onlyMode}". known: ${MODES.map((m) => m.id).join(", ")}`); process.exit(1); }

// guide source: llms.md (default, archived + versioned) OR an override file (Test A).
const overridePath = process.env.GUIDE_SOURCE;
const sourceLabel = process.env.SOURCE_LABEL || (overridePath ? "override" : "llms.md");
const guide = snapshotGuide();
const SYSTEM = overridePath ? readFileSync(overridePath, "utf8") : guide.source;
const version = overridePath ? `${guide.id}+${sourceLabel}` : guide.id;

if (!existsSync(CSV)) writeFileSync(CSV, HEADER.join(",") + "\n");

const ts = new Date().toISOString();
let appended = 0;
const summary: string[] = [];

for (const task of tasks) {
  for (const mode of modes) {
    const prompt = composePrompt(task, mode);
    console.log(`\n=== ${task.id} · ${mode.id} ===`);
    const replies = await Promise.all(callAll(SYSTEM, prompt));
    for (const reply of replies) {
      if (reply.skipped) { console.log(`  ${reply.provider.padEnd(11)} — skipped${reply.error ? " (" + reply.error.slice(0, 60) + ")" : ""}`); continue; }
      if (reply.error) { console.log(`  ${reply.provider.padEnd(11)} ✘ API error: ${reply.error.slice(0, 80)}`); continue; }
      const v = await validate(reply.text ?? "");
      const ok = modeOk(mode.id, v.kind, v.formula);
      const score = await judgeFormula({ task: task.build, mode: mode.id, formula: v.formula });
      appendFileSync(CSV, row([
        ts, version, sourceLabel, reply.provider, reply.model, task.id, mode.id,
        v.ok ? 1 : 0, ok ? 1 : 0, score.task_fit ?? "", score.idiomatic ?? "", "",
        v.kind, score.notes, v.note, v.formula, prompt, reply.text,
      ]));
      appended++;
      const fit = score.task_fit ?? "-", idi = score.idiomatic ?? "-";
      console.log(`  ${reply.provider.padEnd(11)} valid=${v.ok ? "✔" : "✘"} mode=${ok ? "✔" : "✘"} fit=${fit} idiom=${idi}  ${String(v.formula).slice(0, 60)}`);
      summary.push(`${task.id} | ${mode.id} | ${reply.provider} | valid=${v.ok ? 1 : 0} mode=${ok ? 1 : 0} fit=${fit} idiom=${idi}`);
    }
  }
}

console.log(`\n=== appended ${appended} rows to results.csv (guide ${version}) ===`);
console.log(summary.join("\n"));
