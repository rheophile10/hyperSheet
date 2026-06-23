import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, buildSheet } from "../dist/index.js";
import { dumpArchive, loadArchive, validateArchive } from "../dist/甲骨坑/library/segment-io/index.js";

// archive.validate — the completeness gate behind SEGMENT(json) / import / paste.

test("a real dump is complete and round-trips through loadArchive", async () => {
  const state = createInitialState();
  const seg = buildSheet({ rows: 4, cols: 4, cells: { A1: "10", B1: "=A1*2" } });
  await resolveFn(state, "hydrate")(state, [seg], [seg]);
  await resolveFn(state, "runCycle")(state);

  const json = dumpArchive(state, "sheet-grid");
  assert.deepEqual(validateArchive(json), [], "a dehydrated dump has no completeness problems");

  const b = createInitialState();
  await loadArchive(b, json);
  assert.equal(b.cels.get("sheet.B1")?.v, 20, "round-trip restores the computed value");
});

test("validateArchive flags missing key / unknown celType / missing source body", () => {
  const bad = JSON.stringify({ segments: [{ name: "x", cels: [
    { key: "x.A1", celType: "FormulaCel", metadata: { key: "x.A1", segment: "x", parser: "infix" } }, // no f
    { celType: "ValueCel", metadata: {} },                       // no key
    { key: "x.B1", celType: "Nope", metadata: {} },              // unknown celType
  ] }] });
  const p = validateArchive(bad);
  assert.ok(p.some((x) => /source body/.test(x.message)), "FormulaCel without f");
  assert.ok(p.some((x) => /non-empty string `key`/.test(x.message)), "cel without key");
  assert.ok(p.some((x) => /unknown celType/.test(x.message)), "unknown celType");
});

test("validateArchive flags a segment with no name and a non-array/non-JSON archive", () => {
  assert.ok(validateArchive(JSON.stringify({ segments: [{ cels: [] }] })).some((x) => /string `name`/.test(x.message)));
  assert.ok(validateArchive(JSON.stringify({})).some((x) => /segments/.test(x.message)));
  assert.ok(validateArchive("{not json").some((x) => /not valid JSON/.test(x.message)));
});

test("loadArchive refuses an incomplete archive before touching state", async () => {
  const bad = JSON.stringify({ segments: [{ name: "x", cels: [
    { key: "x.A1", celType: "FormulaCel", metadata: { key: "x.A1", segment: "x" } }, // no f
  ] }] });
  const b = createInitialState();
  await assert.rejects(() => loadArchive(b, bad), /incomplete archive/);
  assert.equal(b.cels.has("x.A1"), false, "nothing hydrated from the rejected archive");
});
