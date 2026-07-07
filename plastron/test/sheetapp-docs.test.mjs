import { test, beforeEach } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-sheetapp-docs";

const { createInitialState, resolveFn } = await import("../dist/index.js");

const root = createInitialState().cels.get("file-store.root").v;
beforeEach(async () => { await fs.rm(path.resolve(root, "plastron"), { recursive: true, force: true }); });

const boot = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["origin", "sheets", "window", "origin-lifecycle", "user-space-ops", "segment-store", "opfs-seeding"]);
  await resolveFn(s, "hydrate")(s, [], []);
  return s;
};

// sheetapp = a role:"application" origin-app (no origin-rendered entry → clears the
// one-direction rule). A document = a role:"user-space" segment pinned to it.
const sheetappArchive = {
  formatVersion: 1,
  segments: [{ name: "sheetapp", cels: [{ key: "sheetapp.program", celType: "ValueCel", metadata: { key: "sheetapp.program", segment: "sheetapp" }, v: "worksheet" }] }],
  manifests: [{ name: "sheetapp", version: "1.0.0", description: "sheet app", role: "application", kind: "origin-application", dependencies: [] }],
};
const turtlesDoc = {
  formatVersion: 1,
  segments: [{ name: "turtles", cels: [
    { key: "turtles.A1", celType: "ValueCel", metadata: { key: "turtles.A1", segment: "turtles" }, v: "speed" },
    { key: "turtles.B1", celType: "ValueCel", metadata: { key: "turtles.B1", segment: "turtles" }, v: 10 },
    { key: "turtles.B2", celType: "FormulaCel", metadata: { key: "turtles.B2", segment: "turtles", parser: "infix" }, f: "=turtles.B1*2" },
  ] }],
  manifests: [{ name: "turtles", version: "0.0.1", description: "turtle doc", role: "user-space", applications: ["sheetapp"], dependencies: ["sheetapp"] }],
};

test("origin.opendoc loads BOTH the app + the doc and renders a worksheet window", async () => {
  const s = await boot();
  await resolveFn(s, "origin.install")(s, sheetappArchive);
  await resolveFn(s, "origin.install")(s, turtlesDoc);
  // sheetapp is now a real segment loaded with origin (origin depends on it), so
  // its program marker is present from boot; the DOC archive (install ≠ load) is not.
  assert.equal(s.cels.has("sheetapp.program"), true, "sheetapp is a real segment, loaded with origin");
  assert.equal(s.cels.has("turtles.A1"), false, "install did not hydrate the doc");

  await resolveFn(s, "origin.opendoc")(s, "turtles");
  const drain = resolveFn(s, "drain"), runCycle = resolveFn(s, "runCycle");
  for (let i = 0; i < 6; i++) { await runCycle(s); if (s.cels.get("genesis.commit")) await drain(s, "genesis.commit"); }

  assert.equal(s.cels.has("sheetapp.program"), true, "opendoc auto-started the parent app");
  assert.equal(s.cels.has("turtles.A1"), true, "opendoc hydrated the document cels");
  assert.equal(s.cels.has("win.turtles.state"), true, "a worksheet window rendered the doc");
});

test("origin.savedoc records the document's edited cel states (just the doc)", async () => {
  const s = await boot();
  await resolveFn(s, "origin.install")(s, sheetappArchive);
  await resolveFn(s, "origin.install")(s, turtlesDoc);
  await resolveFn(s, "origin.opendoc")(s, "turtles");

  await resolveFn(s, "setValue")(s, "turtles.B1", 100);
  await resolveFn(s, "runCycle")(s);
  assert.equal(s.cels.get("turtles.B2").v, 200, "the doc's formula recomputed");

  await resolveFn(s, "origin.savedoc")(s, "turtles");
  const rec = await resolveFn(s, "store.get")(s, "turtles");
  // a dehydrated ValueCel carries its value in metadata.v
  const b1 = rec.segment.cels.find((c) => c.key === "turtles.B1");
  assert.equal(b1?.v ?? b1?.metadata?.v, 100, "the edited cel state was recorded");
  assert.equal(rec.manifest.role, "user-space", "saved as an origin-user segment");
  assert.deepEqual(rec.manifest.applications, ["sheetapp"], "still pinned to sheetapp");
  // the program/window cels are NOT in the saved document
  assert.ok(!rec.segment.cels.some((c) => c.key.startsWith("win.") || c.key.startsWith("sheetapp.")), "saved just the doc, not the program");
});

test("a reopened doc restores its saved state (round-trip through the store)", async () => {
  const s1 = await boot();
  await resolveFn(s1, "origin.install")(s1, sheetappArchive);
  await resolveFn(s1, "origin.install")(s1, turtlesDoc);
  await resolveFn(s1, "origin.opendoc")(s1, "turtles");
  await resolveFn(s1, "setValue")(s1, "turtles.B1", 42);
  await resolveFn(s1, "origin.savedoc")(s1, "turtles");

  // a FRESH session that only has the store
  const s2 = await boot();
  await resolveFn(s2, "loadUserSpace")(s2, "turtles");
  assert.equal(s2.cels.get("turtles.B1")?.v, 42, "the recorded state came back");
  assert.equal(s2.cels.has("sheetapp.program"), true, "loadUserSpace auto-started the parent app");
});

test("documents accumulate under their app's store subfolder (not flat)", async () => {
  const s = await boot();
  await resolveFn(s, "origin.install")(s, sheetappArchive);
  await resolveFn(s, "origin.install")(s, turtlesDoc);
  // the doc still loads by name (the index records its app) ...
  const rec = await resolveFn(s, "store.get")(s, "turtles");
  assert.equal(rec.manifest.role, "user-space");
  // ... and on disk it lives under sheetapp/documents/, NOT flat segments/turtles/
  const base = path.resolve(root, "plastron", "segments");
  assert.ok(await fs.stat(path.join(base, "sheetapp", "documents", "turtles")).then(() => true).catch(() => false), "doc under app/documents/");
  assert.ok(!(await fs.stat(path.join(base, "turtles")).then(() => true).catch(() => false)), "not flat");
});

test("origin.editapp edits another segment's cels — the source commits back to the cel", async () => {
  const s = await boot();
  await resolveFn(s, "setCel")(s, "myapp.greet", { celType: "FormulaCel", metadata: { key: "myapp.greet", segment: "myapp", parser: "infix" }, f: "=1+1" });
  await resolveFn(s, "runCycle")(s);

  await resolveFn(s, "origin.editapp")(s, "myapp");
  assert.equal(s.cels.has("win.editapp_myapp.state"), true, "editor window opened");
  assert.match(JSON.stringify(s.cels.get("editapp.myapp.view").v), /=1\+1/, "editor shows the cel's source");

  await resolveFn(s, "origin.editAppCel")(s, { app: "myapp", key: "myapp.greet" }, { key: "Enter", target: { value: "=10*5" } });
  await resolveFn(s, "runCycle")(s);
  assert.equal(s.cels.get("myapp.greet").f, "=10*5", "the edited source committed to the cel");
  assert.equal(s.cels.get("myapp.greet").v, 50, "and recomputed");
});

test("closing the editapp window flushes it — editapp.* and win.editapp_* leave state", async () => {
  const s = await boot();
  await resolveFn(s, "setCel")(s, "myapp.greet", { celType: "FormulaCel", metadata: { key: "myapp.greet", segment: "myapp", parser: "infix" }, f: "=1+1" });
  await resolveFn(s, "runCycle")(s);

  await resolveFn(s, "origin.editapp")(s, "myapp");
  assert.equal(s.cels.has("win.editapp_myapp.flush"), true, "the editor window has a flush lambda");

  await resolveFn(s, "window.close")(s, "win.editapp_myapp.state");
  const leftovers = [...s.cels.keys()].filter((k) => k.startsWith("editapp.myapp.") || k.startsWith("win.editapp_myapp."));
  assert.deepEqual(leftovers, [], "the editor's cels were swept on close");
  assert.equal(s.cels.get("myapp.greet").v, 2, "the edited app itself survives");

  // reopen after the sweep — the create path runs again from a clean slate
  await resolveFn(s, "origin.editapp")(s, "myapp");
  assert.equal(s.cels.has("win.editapp_myapp.state"), true, "editor reopens after a close");
});

test("closing a doc window flushes it — saves the edits then evicts the doc", async () => {
  const s = await boot();
  await resolveFn(s, "origin.install")(s, sheetappArchive);
  await resolveFn(s, "origin.install")(s, turtlesDoc);
  await resolveFn(s, "origin.opendoc")(s, "turtles");
  assert.equal(s.cels.has("win.turtles.flush"), true, "the window has a doc-flush lambda");

  await resolveFn(s, "setValue")(s, "turtles.B1", 77);
  await resolveFn(s, "runCycle")(s);
  await resolveFn(s, "window.close")(s, "win.turtles.state");

  assert.equal(s.cels.has("turtles.B1"), false, "the doc cels were evicted on close");
  const rec = await resolveFn(s, "store.get")(s, "turtles");
  const b1 = rec.segment.cels.find((c) => c.key === "turtles.B1");
  assert.equal(b1?.v ?? b1?.metadata?.v, 77, "the edit was saved before eviction");
});
