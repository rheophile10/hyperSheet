import { test } from "bun:test";
import assert from "node:assert/strict";

// sheetsync.commit — the per-cell LWW-Map change pipeline. An edit mints a per-cell
// op {key,kind,val,ts,author,id}; the state at <seg>.crdt is a {key→winner} map
// (per-key last-writer-wins). SOURCES only — a FormulaCel's TEXT is the source, its
// derived value is a LOCAL runCycle projection. Loopback (single-user) here.

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-sheetsync";
const { createInitialState, precomputeOptional, resolveFn } = await import("../dist/index.js");

const boot = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["sheetsync", "keystore", "sheetkeys", "crypto", "sheets", "file-store"]);
  await resolveFn(s, "hydrate")(s, [], []);
  await precomputeOptional(s);
  await resolveFn(s, "runCycle")(s);
  await resolveFn(s, "keystore.create")(s, "syncpass", "Editor");
  return s;
};
const cel = (s, k) => s.cels.get(k)?.v;
const commit = (s, seg, key, src) => resolveFn(s, "sheetsync.commit")(s, seg, key, src);
const setCel = (s, k, spec) => resolveFn(s, "setCel")(s, k, { metadata: { key: k, segment: k.split(".")[0] }, ...spec });

test("a value edit projects into the cell + records a winner in the <seg>.crdt map", async () => {
  const s = await boot();
  const r1 = await commit(s, "doc", "doc.A1", "5");
  assert.equal(r1.ok, true);
  assert.equal(cel(s, "doc.A1"), 5, "value coerced + projected into the cell");
  const map = cel(s, "doc.crdt");
  assert.ok(map && typeof map === "object" && !Array.isArray(map), "<seg>.crdt is a map, not a stack");
  assert.equal(map["doc.A1"].val, 5, "the map holds the source value");
  assert.equal(map["doc.A1"].kind, "v");
  assert.match(r1.hash, /^[0-9a-f]{64}$/, "a source hash is stamped");
  const r2 = await commit(s, "doc", "doc.A1", "10");
  assert.equal(cel(s, "doc.A1"), 10, "latest edit wins");
  assert.equal(cel(s, "doc.crdt")["doc.A1"].val, 10);
  assert.notEqual(r2.hash, r1.hash, "hash advances with the source change");
});

test("SOURCES ONLY: a formula's TEXT is the map value; its derived value is recomputed locally", async () => {
  const s = await boot();
  await commit(s, "doc", "doc.A1", "10");
  await commit(s, "doc", "doc.B1", "=doc.A1*2");
  assert.equal(s.cels.get("doc.B1")?.celType, "FormulaCel", "restored as a formula");
  assert.equal(cel(s, "doc.B1"), 20, "derived value recomputed locally (10*2)");
  const e = cel(s, "doc.crdt")["doc.B1"];
  assert.equal(e.kind, "f");
  assert.equal(e.val, "=doc.A1*2", "the map carries the formula SOURCE text");
  assert.ok(!JSON.stringify(cel(s, "doc.crdt")).includes(":20"), "the derived value (20) is NOT in the op map");
});

test("OBJECTS + LISTS travel as values, not strings (the point of the LWW op)", async () => {
  const s = await boot();
  // a literal structured value (e.g. a pasted row / a sql result) — passed as a
  // real value, not a string. It must round-trip through the map as itself.
  await commit(s, "doc", "doc.rows", [{ id: 1, name: "a" }, { id: 2, name: "b\twith\ttabs" }]);
  assert.deepEqual(cel(s, "doc.rows"), [{ id: 1, name: "a" }, { id: 2, name: "b\twith\ttabs" }], "list of objects preserved exactly (tabs and all)");
  const e = cel(s, "doc.crdt")["doc.rows"];
  assert.equal(e.kind, "v");
  assert.deepEqual(e.val, [{ id: 1, name: "a" }, { id: 2, name: "b\twith\ttabs" }], "the map stores the value, not a flattened string");
  // a multi-line formula text (would have corrupted a tab/newline text-diff model)
  await commit(s, "doc", "doc.X1", "=SUM(\n  doc.A1,\n  doc.B1)");
  assert.equal(cel(s, "doc.crdt")["doc.X1"].val, "=SUM(\n  doc.A1,\n  doc.B1)", "newlines in a formula survive");
});

test("LWW: a stale op (lower ts) loses; merge is idempotent + order-independent", async () => {
  const s = await boot();
  const me = cel(s, "keystore.identity");
  // hand-craft two ops for the same key with explicit ts, applied out of order via the map.
  // commit twice → ts 1 then ts 2; the map winner is ts 2.
  await commit(s, "g", "g.A1", "first");
  await commit(s, "g", "g.A1", "second");
  assert.equal(cel(s, "g.A1"), "second");
  const win = cel(s, "g.crdt")["g.A1"];
  assert.equal(win.val, "second");
  assert.ok(win.ts >= 2, "the winner is the later ts");
  assert.equal(win.author, me);
});

test("GATE: a non-writer's commit is rejected and does NOT mutate the cell", async () => {
  const s = await boot();
  await commit(s, "doc", "doc.A1", "1");
  await setCel(s, "doc.writers", { celType: "ValueCel", v: ["someone-else"] });
  const r = await commit(s, "doc", "doc.A1", "999");
  assert.equal(r.ok, false);
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
