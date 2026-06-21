import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../dist/index.js";

// origin segment import/export — =export(seg) dumps a 甲骨 archive json; =import(str)
// loads it into the document stack (add / wholesale-replace), refusing boot-set
// names. (origin-segment-import-export.md)

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
  const val = (k = "元") => String(state.cels.get(k)?.v ?? "");
  return { state, put, val };
};

test("=export(seg) → 甲骨 archive json of just that segment", async () => {
  const { state, put, val } = await boot();
  await put('(cels 2 2 "books" (at "A1" "title") (at "B2" 7))', "books_gen");
  await put('=export("books")');
  const archive = val();
  assert.match(archive, /"books\.B2"/, "carries the segment's cels");
  assert.match(archive, /"formatVersion"/, "is a 甲骨 archive");
  assert.ok(!/"net\./.test(archive), "does not leak substrate cels");
});

test("=import(archive) adds the segment into a fresh sheet (round-trip)", async () => {
  const src = await boot();
  await src.put('(cels 2 2 "books" (at "A1" "title") (at "B2" 7))', "books_gen");
  await src.put('=export("books")');
  const archive = src.val();

  const dst = await boot();
  assert.equal(dst.state.cels.get("books.B2"), undefined, "fresh sheet has no books");
  await dst.put(`=import('${archive}')`); // single-quote delimiter: json's double-quotes ride inside
  assert.match(dst.val(), /imported books/, "import confirms");
  assert.equal(dst.state.cels.get("books.B2")?.v, 7, "the cel value round-trips");
  assert.equal(dst.state.cels.get("books.A1")?.v, "title", "string cel round-trips");
});

test("=export(seg, 'formula') → the re-minting formula; replays into a fresh sheet", async () => {
  const a = await boot();
  await a.put('(cels 2 2 "books" (at "A1" "title") (at "B2" 7))', "books_gen");
  await a.put('=export("books", "formula")');
  const formula = a.val();
  assert.match(formula, /^=cels\("books"/, "a =cels(...) minting formula, not an archive");
  assert.match(formula, /title/, "carries the cell content");

  // a formula IS the entry gesture — paste it into a cell to replay it
  const b = await boot();
  await b.put(formula, "replay");
  assert.equal(b.state.cels.get("books.B2")?.v, 7, "formula round-trips B2");
  assert.equal(b.state.cels.get("books.A1")?.v, "title", "and A1");
});

test("=export(seg, 'encrypt', pass) → an aes blob; =import(blob, pass) round-trips; wrong pass fails", async () => {
  const a = await boot();
  await a.put('(cels 2 2 "books" (at "B2" 7))', "books_gen");
  await a.put('=export("books", "encrypt", "hunter2")');
  const blob = a.val();
  assert.match(blob, /^aes256gcm:/, "an encrypted, self-describing blob");
  assert.ok(!/"books\.B2"/.test(blob), "the archive is NOT in cleartext");

  const b = await boot();
  await b.put(`=import('${blob}', "wrongpass")`);
  assert.match(b.val(), /#DENIED/, "wrong passphrase is rejected");
  assert.equal(b.state.cels.get("books.B2"), undefined, "nothing imported on bad pass");

  await b.put(`=import('${blob}', "hunter2")`);
  assert.match(b.val(), /imported books/, "right passphrase imports");
  assert.equal(b.state.cels.get("books.B2")?.v, 7, "decrypted archive round-trips");
});

test("=import over a LIVE generator wins (generator retired, no re-mint)", async () => {
  const { state, put } = await boot();
  await put('(cels 2 2 "books" (at "A1" "from generator"))', "books_gen");
  assert.equal(state.cels.get("books.A1")?.v, "from generator", "minted by the live generator");
  assert.ok(state.cels.get("books_gen"), "the generator cell exists");

  const other = await boot();
  await other.put('(cels 1 1 "books" (at "A1" "from import"))', "books_gen2");
  await other.put('=export("books")');
  await put(`=import('${other.val()}')`);

  assert.equal(state.cels.get("books.A1")?.v, "from import", "the imported version wins");
  assert.equal(state.cels.get("books_gen"), undefined, "the live generator was retired (can't re-mint)");
});

test("=import refuses a boot-set (substrate) name", async () => {
  const { put, val } = await boot();
  // a hand-built archive claiming the reserved name `net`
  const evil = '{"formatVersion":1,"segments":[{"name":"net","cels":[{"key":"net.x","celType":"ValueCel","metadata":{"segment":"net","generatedBy":"x","key":"net.x","v":1}}]}],"manifests":[]}';
  await put(`=import('${evil}')`);
  assert.match(val(), /#REFUSED/, "substrate name is refused");
  assert.match(val(), /\bnet\b/, "names the offending segment");
});

test("=import wholesale-replaces a same-named document segment (sweeps stale cels)", async () => {
  // build two real archives: a 3x3 books with C3, and a 1x1 books with only A1
  const big = await boot();
  await big.put('(cels 3 3 "books" (at "A1" "old") (at "C3" 99))', "books_gen");
  await big.put('=export("books")');
  const bigArchive = big.val();
  const small = await boot();
  await small.put('(cels 1 1 "books" (at "A1" "new"))', "books_gen");
  await small.put('=export("books")');
  const smallArchive = small.val();

  // import the big one (no live generator here), then import the small one over it
  const { state, put } = await boot();
  await put(`=import('${bigArchive}')`);
  assert.equal(state.cels.get("books.C3")?.v, 99, "C3 present after first import");
  await put(`=import('${smallArchive}')`);
  assert.equal(state.cels.get("books.A1")?.v, "new", "A1 replaced");
  assert.equal(state.cels.get("books.C3"), undefined, "stale C3 swept by wholesale replace");
});
