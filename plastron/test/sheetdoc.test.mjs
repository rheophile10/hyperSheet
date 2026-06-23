import { test } from "bun:test";
import assert from "node:assert/strict";

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-sheetdoc";

const { createInitialState, resolveFn } = await import("../dist/index.js");
const { dumpSegments } = await import("../dist/甲骨坑/library/segment-io/index.js");

const boot = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["origin", "sheets", "window"]);
  await resolveFn(s, "hydrate")(s, [], []);
  return s;
};

// A worksheet DOCUMENT: cels keyed in their own segment "turtles".
const seedDoc = async (s) => {
  const setCel = resolveFn(s, "setCel");
  await setCel(s, "turtles.A1", { celType: "ValueCel", metadata: { key: "turtles.A1", segment: "turtles" }, v: "speed" });
  await setCel(s, "turtles.B1", { celType: "ValueCel", metadata: { key: "turtles.B1", segment: "turtles" }, v: 10 });
  await setCel(s, "turtles.B2", { celType: "FormulaCel", metadata: { key: "turtles.B2", segment: "turtles", parser: "infix" }, f: "=turtles.B1*2" });
  await resolveFn(s, "runCycle")(s);
};

test("sheetcells zips keys+vals into grid entries with col/row from the A1 suffix", async () => {
  const s = await boot();
  const cells = resolveFn(s, "sheetcells")(["turtles.A1", "turtles.C3"], ["x", "y"]);
  assert.deepEqual(cells, [
    { key: "turtles.A1", col: 0, row: 0, value: "x" },
    { key: "turtles.C3", col: 2, row: 2, value: "y" },
  ]);
});

test("sheetgrid renders the entries as a real grid vnode", async () => {
  const s = await boot();
  const grid = resolveFn(s, "sheetgrid")("turtles", resolveFn(s, "sheetcells")(["turtles.A1"], ["x"]));
  assert.equal(grid.tag, "div");
  assert.equal(grid.attrs.class, "grid-scroll");
  assert.match(JSON.stringify(grid), /table/);
});

test("sheetdoc opens a worksheet window whose content REFERENCES each doc cel (reactive)", async () => {
  const s = await boot();
  await seedDoc(s);
  await resolveFn(s, "sheetdoc")(s, "turtles", "🐢 Turtles");
  const drain = resolveFn(s, "drain"), runCycle = resolveFn(s, "runCycle");
  for (let i = 0; i < 6; i++) { await runCycle(s); if (s.cels.get("genesis.commit")) await drain(s, "genesis.commit"); }

  assert.equal(s.cels.has("win.turtles.state"), true, "the worksheet window opened");
  const content = s.cels.get("win.turtles.content");
  assert.equal(content?.metadata?.error ?? null, null, "the grid content evaluated cleanly");
  const deps = Object.values(content?.metadata?.inputMap ?? {}).flat();
  for (const k of ["turtles.A1", "turtles.B1", "turtles.B2"]) assert.ok(deps.includes(k), `content references ${k}`);

  // editing a cell flows through: B2 = B1*2 recomputes
  await resolveFn(s, "setValue")(s, "turtles.B1", 100);
  await runCycle(s);
  assert.equal(s.cels.get("turtles.B2").v, 200, "the document's formulas recompute");
});

test("dumpSegments exports ONLY the document segment's cels (the origin-user portion)", async () => {
  const s = await boot();
  await seedDoc(s);
  await resolveFn(s, "sheetdoc")(s, "turtles");
  // even with the window (program) open, dumping the doc captures just its cels
  const arch = JSON.parse(dumpSegments(s, ["turtles"]));
  assert.equal(arch.segments.length, 1, "one segment");
  assert.equal(arch.segments[0].name, "turtles");
  assert.deepEqual(arch.segments[0].cels.map((c) => c.key).sort(), ["turtles.A1", "turtles.B1", "turtles.B2"]);
  // the window/program cels (win.turtles.*) are NOT in the document export
  assert.ok(!arch.segments[0].cels.some((c) => c.key.startsWith("win.")), "no program/window cels in the doc");
});
