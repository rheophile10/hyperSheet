import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// registry-query: a cel depends on "all cels matching a predicate" (segment /
// prefix / generated). The keystone — generalizes RangeCels; the kernel
// maintains the query-cel's inputMap each precompute, so a matching cel
// added/removed/changed re-fires it (no imperative rewire).
test("a query-cel reactively tracks all cels in a segment", async () => {
  const s = createInitialState();
  const setCel = resolveFn(s, "setCel"), runCycle = resolveFn(s, "runCycle"), setValue = resolveFn(s, "setValue");
  await setCel(s, "gview", { celType: "FormulaCel", f: "members", metadata: { key: "gview", segment: "test", query: { as: "members", match: "segment:g" }, inputMap: { members: [] } } });
  await setCel(s, "g.A1", { celType: "ValueCel", v: 10, metadata: { key: "g.A1", segment: "g" } });
  await setCel(s, "g.A2", { celType: "ValueCel", v: 20, metadata: { key: "g.A2", segment: "g" } });
  await runCycle(s);
  const m1 = s.cels.get("gview")?.v;
  assert.deepEqual([...(Array.isArray(m1) ? m1 : [])].sort((a, b) => a - b), [10, 20], `query-cel sees both g cels (got ${JSON.stringify(m1)})`);
  // a NEW matching cel re-fires the query-cel
  await setCel(s, "g.A3", { celType: "ValueCel", v: 30, metadata: { key: "g.A3", segment: "g" } });
  await runCycle(s);
  const m2 = s.cels.get("gview")?.v;
  assert.ok(Array.isArray(m2) && m2.includes(30), `new member g.A3 appears (got ${JSON.stringify(m2)})`);
  // a member VALUE change propagates
  await setValue(s, "g.A1", 99);
  const m3 = s.cels.get("gview")?.v;
  assert.ok(Array.isArray(m3) && m3.includes(99), `value change propagates (got ${JSON.stringify(m3)})`);
});
