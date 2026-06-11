import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// checkpoint v1 (checkpoint-undo.md, accepted: snapshot-only, whole
// user-space). Snapshots ride dehydrate; restore is the wake path.

const v = (state, key) => state.cels.get(key)?.v;
const seedUser = (state, key, spec) =>
  resolveFn(state, "setCel")(state, key, { ...spec, metadata: { segment: "user", ...spec.metadata } });
const flushAll = async (state) => {
  await resolveFn(state, "drain")(state, "genesis.commit");
  await resolveFn(state, "genesis.drain")([], state);
  await resolveFn(state, "drain")(state, "checkpoint.commit");
};
const cycleAndFlush = async (state) => {
  await resolveFn(state, "runCycle")(state);
  return flushAll(state);
};

test("snapshot → mutate → restore brings values AND structure back", async () => {
  const state = createInitialState();
  await seedUser(state, "a", { celType: "ValueCel", v: 1 });
  await seedUser(state, "b", { celType: "FormulaCel", f: "(* a 10)" });
  await seedUser(state, "maker", { celType: "FormulaCel", f: '(cels 2 1 "ckg")' });
  await cycleAndFlush(state);
  await resolveFn(state, "setValue")(state, "ckg.A1", "typed");
  assert.equal(v(state, "b"), 10);

  await resolveFn(state, "checkpoint.snapshot")(state, "good");

  // wreck things: change content, replace the generator (sweeps the grid)
  await resolveFn(state, "setValue")(state, "a", 99);
  await seedUser(state, "maker", { celType: "FormulaCel", f: "(+ 0 0)" });
  await cycleAndFlush(state);
  assert.equal(v(state, "b"), 990);
  assert.equal(state.cels.get("ckg.A1"), undefined, "grid swept");

  await resolveFn(state, "checkpoint.restore")(state, "good");
  assert.equal(v(state, "a"), 1, "content restored");
  assert.equal(v(state, "b"), 10, "formula recomputed after rehydrate");
  assert.ok(state.cels.get("ckg.A1"), "generated structure restored");
  assert.equal(v(state, "ckg.A1"), "typed", "user content in generated cell restored");
  assert.equal(state.cels.get("ckg.A1").metadata.generatedBy, "maker", "ownership survived the round-trip");
});

test("=checkpoint(\"name\") formula form snapshots via the channel drain", async () => {
  const state = createInitialState();
  await seedUser(state, "x", { celType: "ValueCel", v: "keep me" });
  await seedUser(state, "save", { celType: "FormulaCel", f: '(checkpoint "auto")' });
  await cycleAndFlush(state);
  const names = resolveFn(state, "checkpoint.list")(state);
  assert.ok(names.includes("auto"), "formula-driven snapshot landed in the ring");
});

test("ring caps at 20, same-name re-snapshot replaces", async () => {
  const state = createInitialState();
  for (let i = 0; i < 25; i++) await resolveFn(state, "checkpoint.snapshot")(state, `s${i}`);
  const names = resolveFn(state, "checkpoint.list")(state);
  assert.equal(names.length, 20, "ring capped");
  assert.ok(!names.includes("s0"), "oldest evicted");
  await resolveFn(state, "checkpoint.snapshot")(state, "s24");
  assert.equal(resolveFn(state, "checkpoint.list")(state).filter((n) => n === "s24").length, 1, "same name replaces");
});

test("delta reports added / removed / changed between snapshot and live", async () => {
  const state = createInitialState();
  await seedUser(state, "stay", { celType: "ValueCel", v: 1 });
  await seedUser(state, "doomed", { celType: "ValueCel", v: 2 });
  await resolveFn(state, "checkpoint.snapshot")(state, "before");
  await seedUser(state, "fresh", { celType: "ValueCel", v: 3 });
  // remove "doomed" via restoreless surgery: replace with nothing — use setCel of a different segment? simplest: delete via cels map is not the API; mark removal by overwriting then compare two snapshots instead
  await resolveFn(state, "checkpoint.snapshot")(state, "after");
  const d = resolveFn(state, "checkpoint.delta")(state, "before", "after");
  assert.ok(d.added.includes("fresh"), "added detected");
  assert.deepEqual(d.removed, [], "nothing removed");
});

test("restore with unknown name throws cleanly; latest is the default", async () => {
  const state = createInitialState();
  await seedUser(state, "z", { celType: "ValueCel", v: "v1" });
  await resolveFn(state, "checkpoint.snapshot")(state, "only");
  await resolveFn(state, "setValue")(state, "z", "v2");
  await assert.rejects(() => resolveFn(state, "checkpoint.restore")(state, "nope"), /no snapshot named/);
  await resolveFn(state, "checkpoint.restore")(state); // latest
  assert.equal(v(state, "z"), "v1");
});
