import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter, getSegmentManifest } from "../dist/index.js";
import { documentSegments, isSubstrateSegment } from "../dist/甲骨坑/library/segment-io/index.js";

// segment-nav-and-memory keystone: a layered genesis (=cels/=winapp/=doom) registers
// a 冊 manifest {kind, role:"user"} — so a minted segment is a real state.segments
// member: segments() lists it, documentSegments uses the registry (no heuristic), and
// the boot-set guard is role substrate-vs-user.

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
    for (let i = 0; i < 6; i++) { await resolveFn(state, "runCycle")(state); if (state.cels.get("genesis.commit")) await resolveFn(state, "drain")(state, "genesis.commit"); if (state.cels.get("origin.effects")) await resolveFn(state, "drain")(state, "origin.effects"); }
  };
  return { state, put };
};

test("=cels mints a registered workbook segment (kind + role:user)", async () => {
  const { state, put } = await boot();
  await put('(cels 2 2 "books" (at "B2" 7))', "books_gen");
  const m = getSegmentManifest(state, "books");
  assert.ok(m, "books is now a registered segment");
  assert.equal(m.role, "user", "role:user (a document segment)");
  assert.ok(m.kind, "carries a kind"); // the =cels constructor passes "workbook"; genesis defaults "document"
  assert.ok(documentSegments(state).includes("books"), "documentSegments lists it via the registry");
  assert.equal(isSubstrateSegment(state, "books"), false, "not substrate");
});

test("=winapp → kind:winapp; =doom → kind:wasm; both role:user", async () => {
  const { state, put } = await boot();
  await put('(winapp "dash" "Dashboard" "(dom \'h2\' \'hi\')")', "dash_gen");
  await put('=doom()', "doom_gen");
  assert.equal(getSegmentManifest(state, "win.dash")?.kind, "winapp");
  assert.equal(getSegmentManifest(state, "wasm.doom")?.kind, "wasm");
  for (const s of ["win.dash", "wasm.doom"]) assert.equal(getSegmentManifest(state, s)?.role, "user", `${s} is role:user`);
  const docs = documentSegments(state);
  assert.ok(docs.includes("win.dash") && docs.includes("wasm.doom"), "both listed as document segments");
});

test("the substrate stays role substrate (never role:user)", async () => {
  const { state } = await boot();
  for (const sub of ["origin", "net", "dom", "windows", "kernel"]) {
    const m = getSegmentManifest(state, sub);
    assert.ok(m && m.role !== "user", `${sub} is substrate (role ${m?.role})`);
    assert.equal(isSubstrateSegment(state, sub), true, `${sub} is boot substrate`);
  }
  assert.ok(!documentSegments(state).includes("origin"), "substrate excluded from documentSegments");
});
