// score — the full scoreboard. Joins three signals per artifact:
//   1. VALID?   did the formula parse + evaluate           (validate.ts, via last-run.json)
//   2. RENDER   what actually drew, as a screenshot         (render.ts → shots/manifest.json)
//   3. JUDGE    satisfaction / readability / usability 1–5  (judge.ts, vision model)
// Run order:  bun run.ts   →   bun render.ts   →   bun score.ts
// Prints a table and writes scores.json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { judge, type Score } from "./judge.ts";

const here = dirname(fileURLToPath(import.meta.url));
const shotsDir = join(here, "shots");
const manifestPath = join(shotsDir, "manifest.json");
if (!existsSync(manifestPath)) { console.error("no shots/manifest.json — run `bun render.ts` first"); process.exit(1); }

type Entry = { key: string; label: string; formula: string; png: string; facts: Record<string, unknown>; errors: string[] };
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Entry[];
const tasks = JSON.parse(readFileSync(join(here, "tasks.json"), "utf8")) as { id: string; prompt: string }[];
const taskText = (key: string) => tasks.find((t) => key.startsWith(t.id))?.prompt ?? key;

const rows: Array<Entry & { score: Score | { error: string } }> = [];
for (const e of manifest) {
  const factsStr = `buttons=${e.facts.buttons} canvas=${e.facts.canvases} inputs=${e.facts.inputs} cells=${e.facts.cells} text="${String(e.facts.text ?? "").slice(0, 80)}"`;
  process.stdout.write(`judging ${e.label}… `);
  const score = await judge({ task: taskText(e.key), formula: e.formula, pngPath: e.png, facts: factsStr });
  console.log("error" in score ? `ERR ${score.error}` : `sat ${score.satisfaction} layout ${score.layout} use ${score.usability}`);
  rows.push({ ...e, score });
}

// ── scoreboard ───────────────────────────────────────────────────────────────
const n = (v: unknown) => (typeof v === "number" && !Number.isNaN(v) ? String(v) : "·");
console.log("\n" + "artifact".padEnd(26) + "rendrErr  sat  layout  use   notes");
console.log("─".repeat(96));
for (const r of rows) {
  const s = r.score;
  const cells = "error" in s
    ? `${String(r.errors.length).padEnd(8)}  ${s.error.slice(0, 60)}`
    : `${String(r.errors.length).padEnd(8)}  ${n(s.satisfaction).padEnd(3)}  ${n(s.layout).padEnd(6)}  ${n(s.usability).padEnd(3)}  ${s.notes.slice(0, 50)}`;
  console.log(r.label.padEnd(26) + cells);
}
writeFileSync(join(here, "scores.json"), JSON.stringify(rows, null, 2));
console.log(`\nfull scores → ${join(here, "scores.json")}`);
