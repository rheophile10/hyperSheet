import { test } from "bun:test";
import assert from "node:assert/strict";

// sheetsync.commit — the CRDT change pipeline (Phase 3). A SOURCE edit is gated,
// diffed into the segment's grow-only crdt stack (signed), and folded back to the
// source cels; derived FormulaCel values are a LOCAL runCycle projection, never in
// the op-log. Loopback (single-user) here — the real sign→verify→gate→append path.

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-sheetsync";
const { createInitialState, precomputeOptional, resolveFn } = await import("../dist/index.js");

const boot = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["sheetsync", "crdt", "keystore", "sheetkeys", "crypto", "sheets", "file-store"]);
  await resolveFn(s, "hydrate")(s, [], []);
  await precomputeOptional(s);
  await resolveFn(s, "runCycle")(s);
  await resolveFn(s, "keystore.create")(s, "syncpass", "Editor");   // unlock identity
  return s;
};
const cel = (s, k) => s.cels.get(k)?.v;
const commit = (s, seg, key, src) => resolveFn(s, "sheetsync.commit")(s, seg, key, src);
const setCel = (s, k, spec) => resolveFn(s, "setCel")(s, k, { metadata: { key: k, segment: k.split(".")[0] }, ...spec });

test("a value edit folds through the pipeline into the source cel + grows the stack", async () => {
  const s = await boot();
  const r1 = await commit(s, "doc", "doc.A1", "5");
  assert.equal(r1.ok, true); assert.equal(r1.layers, 1, "one crdt layer");
  assert.equal(cel(s, "doc.A1"), 5, "folded into the source cel (number-coerced)");
  assert.match(r1.hash, /^[0-9a-f]{64}$/, "a source hash is stamped");
  const r2 = await commit(s, "doc", "doc.A1", "10");
  assert.equal(r2.layers, 2, "stack grows");
  assert.equal(cel(s, "doc.A1"), 10, "latest edit folds");
  assert.notEqual(r2.hash, r1.hash, "hash advances with the source change");
});

test("SOURCES ONLY: a formula's TEXT is in the op-log; its derived value is recomputed locally", async () => {
  const s = await boot();
  await commit(s, "doc", "doc.A1", "10");
  const r = await commit(s, "doc", "doc.B1", "=doc.A1*2");
  assert.equal(r.ok, true);
  assert.equal(s.cels.get("doc.B1")?.celType, "FormulaCel", "restored as a formula");
  assert.equal(cel(s, "doc.B1"), 20, "derived value recomputed locally via runCycle (10*2)");
  // the crdt stack carries the FORMULA TEXT, never the derived 20
  const folded = resolveFn(s, "crdt.resolve")(cel(s, "doc.crdt"));
  assert.ok(folded.includes("doc.B1\tf\t=doc.A1*2"), "op-log holds the formula source");
  assert.ok(!/doc\.B1\tv\t20/.test(folded), "the derived value is NOT in the op-log");
});

test("GATE: a non-writer's commit is rejected and does NOT mutate the cell", async () => {
  const s = await boot();
  await commit(s, "doc", "doc.A1", "1");                 // creates doc (me is open writer)
  await setCel(s, "doc.writers", { celType: "ValueCel", v: ["someone-else"] });  // restrict to others
  const r = await commit(s, "doc", "doc.A1", "999");
  assert.equal(r.ok, false, "rejected");
  assert.match(r.error, /writer/i);
  assert.equal(cel(s, "doc.A1"), 1, "the cell was NOT mutated by the rejected edit");
});

test("commit refuses when the wallet is locked", async () => {
  const s = await boot();
  await resolveFn(s, "keystore.lock")(s);
  const r = await commit(s, "doc", "doc.A1", "1");
  assert.equal(r.ok, false);
  assert.match(r.error, /unlock/i);
});

test("deterministic fold: resolving the stack reproduces the same sources", async () => {
  const s = await boot();
  await commit(s, "doc", "doc.A1", "7");
  await commit(s, "doc", "doc.A2", "=doc.A1+1");
  const folded = resolveFn(s, "crdt.resolve")(cel(s, "doc.crdt"));
  // a second replica folding the SAME stack lands the same source lines
  assert.ok(folded.includes("doc.A1\tv\t7") && folded.includes("doc.A2\tf\t=doc.A1+1"), "both sources present, order-independent");
});
