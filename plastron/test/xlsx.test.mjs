import { test } from "bun:test";
import assert from "node:assert/strict";
import { toXlsx, fromXlsx } from "../dist/甲骨坑/library/xlsx/index.js";
import { createInitialState, resolveFn } from "../dist/index.js";

// xlsx — read/write .xlsx into/out of cels (DEFLATE via Compression/Decompression
// Stream — the real .xlsx path; round-trip proves both compress + inflate).
const norm = (a) => a.map((c) => `${c.ref}=${typeof c.value}:${c.value}`).sort().join("|");

test("round-trip: cells -> .xlsx (real ZIP+DEFLATE) -> cells", async () => {
  const cells = [
    { ref: "A1", value: "Name" }, { ref: "B1", value: "Age" },
    { ref: "A2", value: "Ada" }, { ref: "B2", value: 42 },
    { ref: "A3", value: "Grace" }, { ref: "B3", value: 0 },
    { ref: "C1", value: "a<b & c>d \"q\"" }, // xml-escaping survives
  ];
  const bytes = await toXlsx(cells);
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b); // "PK" — a real zip
  const back = await fromXlsx(bytes);
  assert.equal(norm(back), norm(cells), "values + types + refs round-trip");
});

test("numbers stay numbers, strings stay strings", async () => {
  const back = await fromXlsx(await toXlsx([{ ref: "A1", value: 3.14 }, { ref: "A2", value: "3.14" }]));
  const a1 = back.find((c) => c.ref === "A1"), a2 = back.find((c) => c.ref === "A2");
  assert.equal(typeof a1.value, "number"); assert.equal(a1.value, 3.14);
  assert.equal(typeof a2.value, "string"); assert.equal(a2.value, "3.14");
});

test("xlsxexport -> xlsximport verbs round-trip through a genesis request", async () => {
  const s = createInitialState();
  for (const [k, v, name] of [["sh.A1", "Item", "A1"], ["sh.B1", "Qty", "B1"], ["sh.A2", "Widget", "A2"], ["sh.B2", 7, "B2"]])
    await resolveFn(s, "setCel")(s, k, { celType: "ValueCel", v, metadata: { key: k, segment: "sh", name } });
  const b64 = await resolveFn(s, "xlsxexport")(s, "sh");
  assert.equal(typeof b64, "string");
  const req = await resolveFn(s, "xlsximport")(s, b64);
  assert.equal(req.genesis, true);
  assert.equal(req.cels["xlsx.A1"].v, "Item");
  assert.equal(req.cels["xlsx.B2"].v, 7);
});
