import { test, beforeAll, beforeEach, afterAll } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-app-install";

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

// origin is PARKED by default (createInitialState lazies it); wake it so the
// origin.install/launch/boot.run host verbs are present.
const boot = async () => {
  const state = createInitialState();
  await fn(state, "ensureSegments")(state, ["origin"]);
  await fn(state, "hydrate")(state, [], []);
  return state;
};

// A minimal origin-application archive (dumpSegments shape): one ValueCel, no
// deps, no `.entry` (so origin.launch's render settle loop is skipped — Phase 1
// asserts the persist/load tiers, not the DOM render path).
const widgetArchive = (v = 7) => ({
  formatVersion: 1,
  segments: [{ name: "widget", cels: [{ key: "widget.X", celType: "ValueCel", metadata: { key: "widget.X", segment: "widget" }, v }] }],
  manifests: [{ name: "widget", version: "1.0.0", description: "test widget app", role: "application", dependencies: [] }],
});

test("app.install persists an archive to the store WITHOUT adding cels to state", async () => {
  const state = await boot();
  assert.equal(state.cels.has("widget.X"), false, "precondition: not in state");

  const status = await fn(state, "origin.install")(state, widgetArchive());

  assert.equal(await fn(state, "store.has")(state, "widget"), true, "widget persisted to the store");
  assert.equal(state.cels.has("widget.X"), false, "install must NOT hydrate cels into state");
  assert.match(status, /installed: \[widget\]/, "status reports the install");

  // The stored payload is the real archive (round-trips through store.get).
  const rec = await fn(state, "store.get")(state, "widget");
  assert.equal(rec.segment.cels[0].v, 7, "stored cel value preserved");
  assert.equal(rec.manifest.role, "application", "stored manifest role preserved");
});

test("app.install is idempotent (re-install of a stored app is skipped)", async () => {
  const state = await boot();
  await fn(state, "origin.install")(state, widgetArchive());
  const status = await fn(state, "origin.install")(state, widgetArchive(99));
  assert.match(status, /skipped: \[widget\]/, "second install is skipped");
  const rec = await fn(state, "store.get")(state, "widget");
  assert.equal(rec.segment.cels[0].v, 7, "the original (not the v99 re-install) is kept");
});

test("app.install accepts a JSON string and rejects an incomplete archive", async () => {
  const state = await boot();
  await fn(state, "origin.install")(state, JSON.stringify(widgetArchive()));
  assert.equal(await fn(state, "store.has")(state, "widget"), true, "JSON-string form installs");

  const broken = { segments: [{ name: "bad", cels: [{ key: "bad.X" /* no celType */, metadata: {} }] }], manifests: [] };
  await assert.rejects(() => fn(state, "origin.install")(state, broken), /incomplete archive/);
  assert.equal(await fn(state, "store.has")(state, "bad"), false, "a rejected archive writes nothing");
});

test("origin.launch hydrates an installed app into state (the load tier)", async () => {
  const state = await boot();
  await fn(state, "origin.install")(state, widgetArchive());
  assert.equal(state.cels.has("widget.X"), false, "still not in state after install");

  await fn(state, "origin.launch")(state, "widget");
  assert.equal(state.cels.get("widget.X")?.v, 7, "launch hydrated the app's cels from the store");
});

test("boot.run installs the baked manifest, then launches the open target", async () => {
  const state = await boot();
  const manifest = { widget: widgetArchive() };

  // open:false → install only (persisted, not hydrated)
  await fn(state, "boot.run")(state, { manifest, open: false });
  assert.equal(await fn(state, "store.has")(state, "widget"), true, "boot.run installed to the store");
  assert.equal(state.cels.has("widget.X"), false, "open:false does not hydrate");

  // open:"widget" → install (idempotent) + launch (hydrate)
  await fn(state, "boot.run")(state, { manifest, open: "widget" });
  assert.equal(state.cels.get("widget.X")?.v, 7, "boot.run launched + hydrated the open target");
});

// --- integration: the REAL baked archives (plastron-examples/origin/apps/*.json) ---
const loadBakedManifest = async () => {
  const appsDir = path.resolve(import.meta.dir, "../../plastron-examples/origin/apps");
  const manifest = {};
  for (const f of await fs.readdir(appsDir)) {
    if (!f.endsWith(".json")) continue;
    manifest[f.replace(/\.json$/, "")] = JSON.parse(await fs.readFile(path.join(appsDir, f), "utf8"));
  }
  return manifest;
};

test("boot.run installs the real desktop archive WITHOUT hydrating it", async () => {
  const state = await boot();
  const manifest = await loadBakedManifest();
  await fn(state, "boot.run")(state, { manifest, open: false });
  assert.equal(await fn(state, "store.has")(state, "desktop"), true, "desktop installed to OPFS");
  // sheetapp is no longer a baked archive — it's a real segment loaded with origin.
  assert.equal(state.cels.has("desktop.iconbar.frame"), false, "install did not hydrate the desktop chrome");
});

test("boot.run open:desktop hydrates the desktop shell + materializes the taskbar", async () => {
  const state = await boot();
  const manifest = await loadBakedManifest();
  await fn(state, "boot.run")(state, { manifest, open: "desktop" });

  for (const k of ["desktop.entry", "desktop.bg.frame", "desktop.iconbar.frame", "desktop.graph.frame", "desktop.taskbar.sync"]) {
    assert.equal(state.cels.has(k), true, `${k} hydrated`);
  }
  // the taskbar.sync genesis ran in the settle loop → frame minted
  assert.equal(state.cels.has("desktop.taskbar.frame"), true, "taskbar genesis materialized desktop.taskbar.frame");
  // the chrome formulas evaluated without error
  for (const k of ["desktop.bg.frame", "desktop.iconbar.frame", "desktop.graph.frame"]) {
    assert.equal(state.cels.get(k)?.metadata?.error ?? null, null, `${k} evaluated cleanly`);
  }
});

test("the Sheet icon (do:origin.newsheet) creates a new worksheet document", async () => {
  const state = await boot();
  const manifest = await loadBakedManifest();
  await fn(state, "boot.run")(state, { manifest, open: "desktop" });
  // sheetapp is a real segment loaded with origin (origin depends on it), so its
  // program marker is present once the desktop (origin) is up.
  assert.equal(state.cels.has("sheetapp.program"), true, "sheetapp loaded with origin");

  await fn(state, "origin.navOpen")(state, "do:origin.newsheet");
  // newsheet (now owned by the sheetapp segment) opens a fresh worksheet doc window
  assert.ok([...state.cels.keys()].some((k) => /^win\.sheet\d+\.state$/.test(k)), "a new worksheet window opened");
});
