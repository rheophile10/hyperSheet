// test-a — "which guide source is SUFFICIENT?" The normal matrix feeds llms.md as
// system prompt (the idealized "model already has the full guide" case). But a real
// LLM meets plastron by FETCHING something: plastron.ca/llms.txt, the raw HTML
// (truncated by its fetcher), or the GitHub README. This runs the SAME task matrix
// against each candidate source-as-received and appends to results.csv with a
// distinct source label, so you can compare viability/scores per source.
//
//   bun test-a.ts                one cell per source by default (play-c · formula) — cheap probe
//   bun test-a.ts keyboard       a base task across every source
//   bun test-a.ts keyboard formula   one task+mode across every source
//
// Each source is staged to a temp file and run through matrix.ts (GUIDE_SOURCE +
// SOURCE_LABEL), so the scoring path is identical to a normal run.
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const TRUNC_KB = Number(process.env.FETCH_CAP_KB || 50);   // simulate a fetcher's truncation cap

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

// The candidate sources, AS A MODEL WOULD RECEIVE THEM.
const sources: { label: string; text: string }[] = [
  { label: "llms.md",       text: read(join(here, "..", "llms.md")) },
  { label: "llms.txt",      text: read(join(here, "..", "dist", "llms.txt")) },
  { label: "readme",        text: read(join(repo, "README.md")) },
  // raw index.html truncated at the cap — does the early <head> guide block survive a naive fetch?
  { label: `html@${TRUNC_KB}k`, text: read(join(here, "..", "dist", "index.html")).slice(0, TRUNC_KB * 1024) },
];

const task = process.argv[2] || "play-c";
const mode = process.argv[3] || "formula";
const tmp = mkdtempSync(join(tmpdir(), "plastron-testa-"));

for (const s of sources) {
  if (!s.text) { console.log(`\n##### SOURCE ${s.label} — MISSING (build dist first?) — skipped #####`); continue; }
  const file = join(tmp, `${s.label.replace(/[^\w.-]/g, "_")}.txt`);
  writeFileSync(file, s.text);
  console.log(`\n##### SOURCE: ${s.label}  (${(s.text.length / 1024).toFixed(1)} KB) #####`);
  const proc = Bun.spawn(["bun", "matrix.ts", task, mode], {
    cwd: here,
    env: { ...process.env, GUIDE_SOURCE: file, SOURCE_LABEL: s.label },
    stdout: "inherit", stderr: "inherit",
  });
  await proc.exited;
}

console.log(`\n=== Test A complete — compare sources in results.csv (filter by the 'source' column) ===`);
