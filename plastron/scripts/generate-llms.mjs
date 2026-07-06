#!/usr/bin/env bun
// ============================================================================
// generate-llms.mjs — render plastron-examples/origin/llms.md from the guide
// segment's seed (src/甲骨坑/library/guide/甲骨.json).
//
// GENERATED, NOT HAND-KEPT: the guide's prose lives in doc-only ValueCels
// ({order, title, audience} metadata); this script is the ONLY writer of
// llms.md. An eval FAIL's fix lands in a guide cel (or a verb's metadata
// description/example/commentary) and re-renders here — the in-app =help
// improves in the same edit because both render from the same cels
// (docs/1-design/1-under-consideration/grok-chat-bots.md, "the eval
// feedback loop"). Runs as part of `build` after the call-graph step.
//
// Placeholders are PRESERVED, not resolved: the [[VOCAB_CATALOG]] and
// [[OTP_DEMO]] sentinels ride inside the guide sections' text — origin's
// bundle.ts bakes the vocabText catalog and the worked OTP demo into them
// at bundle time. This script's output is bundle.ts's INPUT.
//
// Sections render sorted by metadata.order; audience "llm" and "both" are
// included ("human"-only sections are for in-app surfaces, not llms.md).
// ============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED = path.join(PKG_ROOT, "src", "甲骨坑", "library", "guide", "甲骨.json");
const OUT = path.join(PKG_ROOT, "..", "plastron-examples", "origin", "llms.md");

const HEADER =
  "<!-- GENERATED from the guide segment (plastron/src/甲骨坑/library/guide/甲骨.json)" +
  " by plastron/scripts/generate-llms.mjs — edit the guide cels, not this file. -->";

/** Pure render: guide seed → llms.md text (exported for tests). */
export const renderLlms = (seed) => {
  const sections = (seed.cels ?? [])
    .filter((c) => c.celType === "ValueCel")
    .filter((c) => ["llm", "both"].includes(String(c.metadata?.audience ?? "both")))
    .sort((a, b) => Number(a.metadata?.order ?? 0) - Number(b.metadata?.order ?? 0));
  if (!sections.length) throw new Error("generate-llms: guide seed has no sections");
  const body = sections.map((c) => String(c.v)).join("\n\n");
  // bundle.ts requires these sentinels — losing one breaks the Pages build.
  for (const sentinel of ["[[VOCAB_CATALOG]]", "[[OTP_DEMO]]"]) {
    if (!body.includes(sentinel)) throw new Error(`generate-llms: ${sentinel} sentinel missing from the guide sections`);
  }
  return `${HEADER}\n\n${body}\n`;
};

// main — read the seed, write llms.md (import.meta.main: skipped when a test
// imports renderLlms).
if (import.meta.main) {
  const seed = JSON.parse(readFileSync(SEED, "utf8"));
  const out = renderLlms(seed);
  writeFileSync(OUT, out);
  const n = seed.cels.length;
  console.log(`✔ ${path.relative(process.cwd(), OUT)} — ${n} guide sections, ${(out.length / 1024).toFixed(1)} KB`);
}
