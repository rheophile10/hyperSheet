import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../dist/index.js";
import { documentSegments, isSubstrateSegment, dumpArchive, loadArchive } from "../dist/甲骨坑/library/segment-io/index.js";

// segment-io core — the document-segment discriminator (segment-kinds-and-io.md).
// Export scope is boot-set membership: the bundled substrate (state.segments) is
// never exportable; runtime-minted document segments (cels/winapp genesis) are.

const mkEl = (t) => ({ nodeType: 1, tag: t, tagName: t.toUpperCase(), childNodes: [], attrs: {}, style: { props: {}, setProperty() {}, removeProperty() {} }, get firstChild() { return this.childNodes[0] ?? null; }, get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }, setAttribute() {}, removeAttribute() {}, appendChild(c) { this.childNodes.push(c); return c; }, removeChild(c) { return c; }, replaceChild(n, o) { return o; }, insertBefore(n) { this.childNodes.push(n); return n; }, replaceChildren(...c) { this.childNodes = [...c]; }, addEventListener() {}, removeEventListener() {} });

const boot = async () => {
  const root = mkEl("app");
  globalThis.document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }), querySelector: (s) => (s === "#app" ? root : null), addEventListener() {}, removeEventListener() {} };
  const q = [];
  const state = createInitialState();
  setPainter(state, createPainter(state, { raf: (cb) => q.push(cb), caf: () => {}, isBrowser: true, doc: globalThis.document, resolveMount: (x) => (x === "#app" ? root : null) }));
  await resolveFn(state, "ensureSegments")(state, ["origin"]);
  await resolveFn(state, "hydrate")(state, [], []);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  const put = async (src, key = "元") => {
    await resolveFn(state, "origin.edit")(state, key);
    await resolveFn(state, "setValue")(state, "元.draft", src);
    await resolveFn(state, "origin.run")(state, key);
    for (let i = 0; i < 5; i++) { await resolveFn(state, "runCycle")(state); if (state.cels.get("genesis.commit")) await resolveFn(state, "drain")(state, "genesis.commit"); }
  };
  return { state, put };
};

test("the bundled substrate is recognised as boot-set; minted segments are not", async () => {
  const { state } = await boot();
  for (const sub of ["origin", "net", "dom", "window", "kernel"]) {
    assert.ok(isSubstrateSegment(state, sub), `${sub} is substrate (boot set)`);
  }
  assert.ok(!isSubstrateSegment(state, "books"), "an un-minted name is not substrate");
});

test("documentSegments lists runtime-minted segments, never the substrate", async () => {
  const { state, put } = await boot();
  // commit each genesis to its OWN cell — re-committing the same key (元) replaces
  // its prior genesis (regeneration sweeps the old cels; cross-segment writes are
  // open now that 访 is gone, so the old isolation no longer keeps both alive).
  await put('(cels 2 2 "books" (at "B2" 7))', "books_gen");
  await put('(wopen "dash" "Dashboard" "(dom \'h2\' \'hi\')")', "dash_gen");

  const docs = documentSegments(state);
  assert.ok(docs.includes("books"), "the workbook segment is a document segment");
  assert.ok(docs.includes("win.dash"), "the wopen window segment is a document segment");

  // the substrate (and runtime INFRA like the base `win` namespace) must NOT leak
  for (const sub of ["origin", "net", "dom", "window", "win"]) {
    assert.ok(!docs.includes(sub), `${sub} must not appear in the export set`);
  }
});

test("dumpArchive → loadArchive round-trips a document segment into a fresh state", async () => {
  const a = await boot();
  await a.put('(cels 2 2 "books" (at "A1" "title") (at "B2" 7))', "books_gen");
  assert.equal(a.state.cels.get("books.B2")?.v, 7, "minted in state A");
  const archive = dumpArchive(a.state, "books");
  assert.match(archive, /"books\.B2"/, "the archive carries the segment's cels");

  // hydrate it into a SEPARATE, freshly-booted origin state
  const b = await boot();
  assert.equal(b.state.cels.get("books.B2"), undefined, "state B starts without books");
  const added = await loadArchive(b.state, archive);
  assert.ok(added.includes("books"), "load reports the segment it installed");
  assert.equal(b.state.cels.get("books.B2")?.v, 7, "the cel value round-trips");
  assert.equal(b.state.cels.get("books.A1")?.v, "title", "string cel round-trips");
  assert.ok(documentSegments(b.state).includes("books"), "and it lands as a document segment");
});
