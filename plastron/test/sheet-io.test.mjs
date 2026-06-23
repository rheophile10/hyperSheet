import { test } from "bun:test";
import assert from "node:assert/strict";
import { toCsv, parseCsv, csvToCells, toJia, jiaToCells } from "../dist/甲骨坑/library/sheet-io/index.js";

// sheet-io owns worksheet serialization (extracted from sheet-host). These pin
// the pure serializers: CSV (values-only) + .甲 (the rich archive — cels +
// formulas round-trip). saveSheet/openAsSheet themselves drive genesis.drain +
// the windowing geom, exercised in the origin e2e suites; here we cover the
// format round-trips that don't need a live kernel.

// a minimal State stand-in: just a .cels Map of A1-addressed grid cels.
const mkState = (seg, grid) => {
  const cels = new Map();
  for (const [addr, spec] of Object.entries(grid)) {
    cels.set(`${seg}.${addr}`, { celType: spec.f !== undefined ? "FormulaCel" : "ValueCel", v: spec.v, f: spec.f, metadata: { segment: seg, name: addr } });
  }
  return { cels };
};

test("toCsv lays grid cels out in A1 row×col order with RFC-4180 quoting", () => {
  const state = mkState("s1", { A1: { v: "name" }, B1: { v: "qty" }, A2: { v: "a,b" }, B2: { v: 3 }, A3: { v: 'he"llo' } });
  const csv = toCsv(state, "s1");
  assert.equal(csv, 'name,qty\n"a,b",3\n"he""llo",');
});

test("parseCsv round-trips through csvToCells: numeric fields become numbers, blanks drop", () => {
  const rows = parseCsv('name,qty\n"a,b",3\n,5');
  assert.deepEqual(rows, [["name", "qty"], ["a,b", "3"], ["", "5"]]);
  const cells = csvToCells("s2", rows);
  assert.equal(cells["s2.A1"].v, "name");
  assert.equal(cells["s2.A2"].v, "a,b");
  assert.equal(cells["s2.B2"].v, 3);            // numeric coercion
  assert.equal(cells["s2.A3"], undefined);      // blank field dropped
  assert.equal(cells["s2.B3"].v, 5);
});

test(".甲 archive round-trips cels AND formulas (the rich form CSV can't)", async () => {
  const state = mkState("s3", { A1: { v: "total" }, A2: { v: 6, f: "(+ 1 2 3)" }, B1: { v: 42 } });
  const bytes = await toJia(state, "s3");
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0);
  const cells = await jiaToCells("s3", bytes);
  assert.equal(cells["s3.A1"].celType, "ValueCel");
  assert.equal(cells["s3.A1"].v, "total");
  assert.equal(cells["s3.A2"].celType, "FormulaCel");
  assert.equal(cells["s3.A2"].f, "(+ 1 2 3)");  // formula preserved
  assert.equal(cells["s3.B1"].v, 42);
});

test("jiaToCells rejects an archive with no sheet.json", async () => {
  await assert.rejects(() => jiaToCells("s4", new Uint8Array([1, 2, 3])));
});
