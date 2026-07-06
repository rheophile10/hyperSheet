import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";
import { vocabText } from "../dist/甲骨坑/application/origin/index.js";
import { renderLlms } from "../scripts/generate-llms.mjs";

// ============================================================================
// guide — doc-only ValueCels ({order, title, audience} metadata) that
// GENERATE plastron-examples/origin/llms.md (scripts/generate-llms.mjs),
// plus metadata.commentary flowing into the vocabText catalog. The eval
// feedback loop's substrate: a guide fix lands in a cel, never in a
// hand-kept md.
// ============================================================================

const seedPath = new URL("../src/甲骨坑/library/guide/甲骨.json", import.meta.url);
const seed = JSON.parse(readFileSync(seedPath, "utf8"));

const boot = async (segments) => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, segments);
  await resolveFn(state, "hydrate")(state, [], []);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  return state;
};

test("guide segment hydrates: doc-only ValueCels, ordered, audience-tagged", async () => {
  const state = await boot(["guide"]);
  // the segment's own 冊.guide SegmentCel rides along — the doc cels are guide.*
  const cels = [...state.cels.values()].filter((c) => String(c.metadata.key).startsWith("guide."));
  assert.ok(cels.length >= 7, `guide has its sections (got ${cels.length})`);
  for (const c of cels) {
    assert.equal(c.celType, "ValueCel", `${c.metadata.key} is doc-only (ValueCel)`);
    assert.equal(typeof c.v, "string", `${c.metadata.key}'s VALUE is the section text`);
    assert.equal(typeof c.metadata.order, "number", `${c.metadata.key} carries order`);
    assert.equal(typeof c.metadata.title, "string", `${c.metadata.key} carries title`);
    assert.ok(["llm", "human", "both"].includes(c.metadata.audience), `${c.metadata.key} carries audience`);
  }
  // sections are ordered: sorting by metadata.order is a permutation 0..n-1
  const orders = cels.map((c) => c.metadata.order).sort((a, b) => a - b);
  assert.deepEqual(orders, orders.map((_, i) => i), "orders are 0..n-1");
  // the intro leads; the catalog section carries the bake sentinel
  const byOrder = cels.sort((a, b) => a.metadata.order - b.metadata.order);
  assert.equal(byOrder[0].metadata.key, "guide.intro");
  assert.ok(state.cels.get("guide.catalog").v.includes("[[VOCAB_CATALOG]]"), "catalog placeholder survives as a cel value");
});

test("generate-llms: GENERATED header + a known section VERBATIM + sentinels", () => {
  const out = renderLlms(seed);
  assert.ok(out.startsWith("<!-- GENERATED from the guide segment"), "header comment leads the file");
  assert.ok(out.includes("edit the guide cels, not this file"), "header names the edit surface");
  // a known hand-tuned section survives byte-for-byte (the eval-tuned prose)
  const research = seed.cels.find((c) => c.key === "guide.research");
  assert.ok(out.includes(research.v), "guide.research renders verbatim");
  assert.ok(research.v.includes("FIRST — RESEARCH, DON'T GUESS"), "the known banner text is in the section");
  // ordering: intro before research before catalog
  const pos = (k) => out.indexOf(seed.cels.find((c) => c.key === k).v);
  assert.ok(pos("guide.intro") < pos("guide.research"), "order 0 renders before order 1");
  assert.ok(pos("guide.research") < pos("guide.catalog"), "the catalog closes the file");
  // the bundle.ts bake sentinels are preserved, not resolved
  assert.ok(out.includes("[[VOCAB_CATALOG]]"), "[[VOCAB_CATALOG]] placeholder kept for bundle.ts");
  assert.ok(out.includes("[[OTP_DEMO]]"), "[[OTP_DEMO]] placeholder kept for bundle.ts");
});

test("generate-llms: audience filter — human-only sections stay out of llms.md", () => {
  const synthetic = {
    name: "guide",
    cels: [
      ...seed.cels,
      { key: "guide.x-human", celType: "ValueCel", v: "HUMAN-ONLY-SECTION",
        metadata: { key: "guide.x-human", segment: "guide", order: 99, title: "x", audience: "human" } },
      { key: "guide.x-llm", celType: "ValueCel", v: "LLM-ONLY-SECTION [[unused]]",
        metadata: { key: "guide.x-llm", segment: "guide", order: 100, title: "y", audience: "llm" } },
    ],
  };
  const out = renderLlms(synthetic);
  assert.ok(!out.includes("HUMAN-ONLY-SECTION"), 'audience "human" is excluded');
  assert.ok(out.includes("LLM-ONLY-SECTION"), 'audience "llm" is included');
});

test("metadata.commentary flows into the vocabText catalog as indented lines", async () => {
  const state = await boot(["dom", "collections"]);
  const txt = vocabText(state, "collections");
  // rows/table carry doctrine commentary (collections-doctrine.md)
  assert.ok(txt.includes("reshaping by hand"), "rows commentary reaches the catalog");
  assert.ok(txt.includes("Tables are VIEWS over plain JSON-shaped values"), "table commentary reaches the catalog");
  // rendered as indented lines UNDER the verb (6-space indent, wrapped)
  const lines = txt.split("\n");
  const start = lines.findIndex((l) => l.startsWith("  table  — "));
  assert.ok(start >= 0, "the table verb line exists");
  const block = lines.slice(start + 1, start + 12).join("\n");
  assert.ok(/^ {6}\S/m.test(block), "commentary lines are indented under the verb");
  assert.ok(block.includes("Tables are VIEWS"), "the commentary sits under its verb");
});
