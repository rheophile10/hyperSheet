import { test, beforeAll, beforeEach, afterAll } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-origin-lifecycle";

const { createInitialState, resolveFn } = await import("../dist/index.js");

let activeRoot;
const wipeStore = async () => {
  if (activeRoot !== undefined) {
    await fs.rm(path.resolve(activeRoot, "plastron"), { recursive: true, force: true });
  }
};
beforeAll(async () => { activeRoot = createInitialState().cels.get("file-store.root").v; await wipeStore(); });
beforeEach(wipeStore);
afterAll(wipeStore);

const fn = (s, k) => resolveFn(s, k);

// Boot a state with a role:"application" segment loaded + seeded.
const bootWithApp = async (appName = "calc") => {
  const state = createInitialState();
  await fn(state, "hydrate")(
    state,
    [{ name: appName, cels: [] }],
    [{ name: appName, version: "1.0.0", description: "test app", role: "application", dependencies: [] }],
  );
  await fn(state, "seedStore")(state);
  return state;
};

test("origin-lifecycle seeds its channel, drain, descriptor verbs, and dispatcher", () => {
  const state = createInitialState();
  for (const k of ["origin.io.drain", "origin.new", "origin.save", "origin.load",
                    "origin.open", "origin.close", "origin.flush", "origin.fire"]) {
    assert.equal(typeof resolveFn(state, k), "function", `${k} should resolve to a fn`);
  }
  assert.equal(state.cels.get("origin.io")?.celType, "ChannelCel", "origin.io is a channel");
});

test("descriptor verbs are pure builders carrying emitsTo:origin.io", () => {
  const state = createInitialState();
  assert.deepEqual(resolveFn(state, "origin.save")("doc"), { op: "save", name: "doc" });
  assert.deepEqual(resolveFn(state, "origin.new")("calc", "doc"), { op: "new", app: "calc", name: "doc" });
  assert.equal(state.cels.get("origin.save")?.metadata.emitsTo, "origin.io", "verb emits to origin.io");
});

test("the drain dispatches a {op:new} descriptor to newUserSpace", async () => {
  const state = await bootWithApp("calc");
  const drain = resolveFn(state, "origin.io.drain");
  await drain([{ cel: { v: { op: "new", app: "calc", name: "d2" } }, state }], state);
  assert.equal(await resolveFn(state, "store.has")(state, "d2"), true, "newUserSpace ran + autosaved d2");
});

test("kernel flush hook runs <seg>.flush (save) before evicting the cels", async () => {
  const state = await bootWithApp("calc");
  await fn(state, "newUserSpace")(state, "doc", "calc");

  // A flush slot: an origin-user's `<seg>.flush` FormulaCel → {op:flush, save:true}.
  await fn(state, "setCel")(state, "doc.flush", {
    celType: "FormulaCel", f: "=origin.flush('doc', true)",
    metadata: { key: "doc.flush", segment: "doc", parser: "infix" },
  });
  await fn(state, "runCycle")(state);

  // The emitsTo wiring landed the channel on the slot.
  assert.ok((state.cels.get("doc.flush").metadata.channel ?? []).includes("origin.io"),
    "flush slot is wired to origin.io");

  // Live data the flush must persist.
  await fn(state, "setCel")(state, "doc.A1", {
    celType: "ValueCel", v: 42, metadata: { key: "doc.A1", segment: "doc" },
  });

  // Flush the doc: kernel hook enqueues doc.flush → drain saves → cels evicted.
  await fn(state, "flush")(state, "doc");
  assert.equal(state.cels.has("doc.A1"), false, "doc cels evicted by flush");

  // Reload from the store: the flush saved A1=42 BEFORE eviction.
  await fn(state, "loadUserSpace")(state, "doc");
  assert.equal(state.cels.get("doc.A1")?.v, 42, "flush persisted the live value before evicting");
});

const appManifest = { name: "calc", version: "1.0.0", description: "v1", role: "application", dependencies: [] };
const calcX = (v) => ({ name: "calc", cels: [{ key: "calc.X", celType: "ValueCel", metadata: { key: "calc.X", segment: "calc" }, v }] });

test("save stamps a content sha; newUserSpace pins it on the origin-user", async () => {
  const state = await bootWithApp("calc");
  await fn(state, "store.put")(state, "calc", "1.0.0", { ...appManifest }, { name: "calc", cels: [] });
  const sha0 = (await fn(state, "store.get")(state, "calc")).manifest.sha;
  assert.equal(typeof sha0, "string", "store.put stamped the app sha");

  await fn(state, "newUserSpace")(state, "doc", "calc");
  const docM = (await fn(state, "store.get")(state, "doc")).manifest;
  assert.equal(docM.applicationSha, sha0, "the origin-user pinned the app's sha");
});

test("origin.load gate REFUSES an origin-user pinned to an incompatible app sha", async () => {
  const state = await bootWithApp("calc");
  await fn(state, "store.put")(state, "calc", "1.0.0", { ...appManifest }, { name: "calc", cels: [] });
  await fn(state, "newUserSpace")(state, "doc", "calc");          // pins the empty-calc sha
  await fn(state, "store.put")(state, "calc", "1.0.0", { ...appManifest, description: "v2" }, calcX(1)); // new sha, no compat

  const drain = resolveFn(state, "origin.io.drain");
  await assert.rejects(
    () => drain([{ cel: { v: { op: "load", name: "doc" } }, state }], state),
    /incompatible|cannot load/,
  );
});

test("origin.load gate ALLOWS when the pinned sha is in the app's compat list", async () => {
  const state = await bootWithApp("calc");
  await fn(state, "store.put")(state, "calc", "1.0.0", { ...appManifest }, { name: "calc", cels: [] });
  const sha0 = (await fn(state, "store.get")(state, "calc")).manifest.sha;
  await fn(state, "newUserSpace")(state, "doc", "calc");          // pins sha0
  await fn(state, "store.put")(state, "calc", "1.0.0", { ...appManifest, description: "v2", compat: [sha0] }, calcX(2)); // new sha, compat lists sha0

  const drain = resolveFn(state, "origin.io.drain");
  await assert.doesNotReject(() => drain([{ cel: { v: { op: "load", name: "doc" } }, state }], state));
});
