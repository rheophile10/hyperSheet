import { test } from "bun:test";
import assert from "node:assert/strict";

// sheetkeys.hash — deterministic SHA-256 of a segment's SOURCE cels (Phase 2B).
// Sources only: a FormulaCel hashes its TEXT, not its derived value; a ValueCel
// hashes its literal. Exclusions drop ranges. Same sources ⇒ same hash anywhere.
const { createInitialState, precomputeOptional, resolveFn } = await import("../dist/index.js");

const boot = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["sheetkeys"]);
  await resolveFn(s, "hydrate")(s, [], []);
  await precomputeOptional(s);
  return s;
};
const put = (s, k, spec) => resolveFn(s, "setCel")(s, k, { metadata: { key: k, segment: k.split(".")[0] }, ...spec });
const H = (s, seg, ex) => resolveFn(s, "sheetkeys.hash")(s, seg, ex);

test("hash is a 64-hex SHA-256 over a segment's source cels, stable + order-independent", async () => {
  const s = await boot();
  await put(s, "foo.A1", { celType: "ValueCel", v: 5 });
  await put(s, "foo.B2", { celType: "ValueCel", v: "hi" });
  const h1 = await H(s, "foo");
  assert.match(h1, /^[0-9a-f]{64}$/, "64-hex digest");
  // re-hash same state → identical
  assert.equal(await H(s, "foo"), h1, "deterministic");
  // a fresh state with the SAME sources (inserted in a different order) → same hash
  const s2 = await boot();
  await put(s2, "foo.B2", { celType: "ValueCel", v: "hi" });
  await put(s2, "foo.A1", { celType: "ValueCel", v: 5 });
  assert.equal(await H(s2, "foo"), h1, "order-independent: sorted by key");
});

test("changing a SOURCE changes the hash; a FormulaCel hashes its TEXT not its value", async () => {
  const s = await boot();
  await put(s, "g.A1", { celType: "ValueCel", v: 1 });
  await put(s, "g.A2", { celType: "FormulaCel", f: "=g.A1*2", v: 2 });
  const before = await H(s, "g");
  // mutate only the DERIVED value of the formula cell (not its .f) → SAME hash
  await put(s, "g.A2", { celType: "FormulaCel", f: "=g.A1*2", v: 999 });
  assert.equal(await H(s, "g"), before, "derived value is NOT part of the hash (sources only)");
  // change the formula TEXT → hash changes
  await put(s, "g.A2", { celType: "FormulaCel", f: "=g.A1*3", v: 999 });
  assert.notEqual(await H(s, "g"), before, "formula text IS a source");
  // change a value source → hash changes
  await put(s, "g.A2", { celType: "FormulaCel", f: "=g.A1*2", v: 2 });
  const base = await H(s, "g");
  await put(s, "g.A1", { celType: "ValueCel", v: 7 });
  assert.notEqual(await H(s, "g"), base, "value source change shifts the hash");
});

test("exclude patterns drop ranges (exact + trailing-* prefix)", async () => {
  const s = await boot();
  await put(s, "x.A1", { celType: "ValueCel", v: 1 });
  await put(s, "x.live", { celType: "ValueCel", v: 111 });
  await put(s, "x.live2", { celType: "ValueCel", v: 222 });
  const full = await H(s, "x");
  assert.notEqual(await H(s, "x", ["x.live*"]), full, "excluding a range changes the hash");
  // excluding the live range == a state without those cels
  const s2 = await boot();
  await put(s2, "x.A1", { celType: "ValueCel", v: 1 });
  assert.equal(await H(s, "x", ["x.live*"]), await H(s2, "x"), "exclude(live*) ≡ absent");
  // comma-string form works too
  assert.equal(await H(s, "x", "x.live,x.live2"), await H(s2, "x"), "comma-string exclude");
});

test("hash of an empty/unknown segment is the empty-set digest, and '' for no seg", async () => {
  const s = await boot();
  assert.equal(await H(s, ""), "", "no segment → empty string");
  assert.match(await H(s, "nope"), /^[0-9a-f]{64}$/, "unknown segment → digest of nothing (still 64-hex)");
});

// ── sealsheet / opensheet (envelope to the wallet keypair) ────────────────────
process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-sheetkeys";
const bootCrypto = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["sheetkeys", "keystore", "crypto", "file-store"]);
  await resolveFn(s, "hydrate")(s, [], []);
  await precomputeOptional(s);
  await resolveFn(s, "runCycle")(s);
  await resolveFn(s, "keystore.create")(s, "sealpass", "Owner");   // unlock an identity
  return s;
};

test("sealsheet → opensheet round-trips a segment through ciphertext", async () => {
  const s = await bootCrypto();
  await put(s, "doc.A1", { celType: "ValueCel", v: 5 });
  await put(s, "doc.A2", { celType: "FormulaCel", f: "=doc.A1*2", v: 10 });
  const sealed = await resolveFn(s, "sheetkeys.sealsheet")(s, "doc");
  assert.equal(sealed.ok, true, "sealed");
  assert.ok(!/"v":\s*5|doc\.A1\*2/.test(sealed.blob), "the blob is ciphertext — no source leaks");
  const blob = JSON.parse(sealed.blob);
  assert.equal(blob.seg, "doc"); assert.match(blob.hash, /^[0-9a-f]{64}$/, "carries a source hash");
  // clobber the live cels, then open the sealed blob → restores the sources
  await put(s, "doc.A1", { celType: "ValueCel", v: 999 });
  const opened = await resolveFn(s, "sheetkeys.opensheet")(s, sealed.blob);
  assert.equal(opened.ok, true);
  assert.equal(opened.seg, "doc");
  assert.equal(s.cels.get("doc.A1")?.v, 5, "value source restored");
  assert.equal(s.cels.get("doc.A2")?.celType, "FormulaCel", "formula source restored");
});

test("a tampered blob and a wrong-key blob fail cleanly", async () => {
  const s = await bootCrypto();
  await put(s, "t.A1", { celType: "ValueCel", v: 1 });
  const { blob } = await resolveFn(s, "sheetkeys.sealsheet")(s, "t");
  const tampered = blob.replace(/"cipher":"./, '"cipher":"X');
  assert.equal((await resolveFn(s, "sheetkeys.opensheet")(s, tampered)).ok, false, "tamper rejected");
  // a blob wrapped to a key we never held
  const fake = JSON.stringify({ ...JSON.parse(blob), pub: "AAAA-unheld" });
  assert.equal((await resolveFn(s, "sheetkeys.opensheet")(s, fake)).ok, false, "unheld key rejected");
});

test("a sheet sealed BEFORE a reshuffle still opens (history key)", async () => {
  const s = await bootCrypto();
  await put(s, "h.A1", { celType: "ValueCel", v: 42 });
  const { blob } = await resolveFn(s, "sheetkeys.sealsheet")(s, "h");
  await resolveFn(s, "keystore.reshuffle")(s);             // rotate the key
  await put(s, "h.A1", { celType: "ValueCel", v: 0 });     // clobber
  const opened = await resolveFn(s, "sheetkeys.opensheet")(s, blob);
  assert.equal(opened.ok, true, "the retired key still opens it");
  assert.equal(s.cels.get("h.A1")?.v, 42);
});

test("sealsheet/opensheet refuse when the wallet is locked", async () => {
  const s = await bootCrypto();
  await put(s, "L.A1", { celType: "ValueCel", v: 1 });
  const { blob } = await resolveFn(s, "sheetkeys.sealsheet")(s, "L");
  await resolveFn(s, "keystore.lock")(s);
  assert.equal((await resolveFn(s, "sheetkeys.sealsheet")(s, "L")).ok, false, "seal refused when locked");
  assert.equal((await resolveFn(s, "sheetkeys.opensheet")(s, blob)).ok, false, "open refused when locked");
});

// ── writers gate ──────────────────────────────────────────────────────────────
test("writableBy: open when no allow-list, restricted to members otherwise", async () => {
  const s = await bootCrypto();
  const W = resolveFn(s, "writableBy");
  assert.equal(W("anyone", undefined), true, "no writers list → open");
  assert.equal(W("anyone", []), true, "empty list → open");
  assert.equal(W("alice", ["alice", "bob"]), true, "member writes");
  assert.equal(W("carol", ["alice", "bob"]), false, "non-member is read-only");
  assert.equal(W("", ["alice"]), false, "locked/empty identity is never a writer of a restricted sheet");
});

test("sealing a sheet records the sealer as a writer, and it round-trips", async () => {
  const s = await bootCrypto();
  const me = s.cels.get("keystore.identity")?.v;
  await put(s, "w.A1", { celType: "ValueCel", v: 1 });
  const { blob } = await resolveFn(s, "sheetkeys.sealsheet")(s, "w");
  assert.deepEqual(s.cels.get("w.writers")?.v, [me], "sealer added to <seg>.writers");
  // the writers list is sealed IN (it's a seg cel) and restores on open
  await resolveFn(s, "setCel")(s, "w.writers", { celType: "ValueCel", v: ["someone-else"], metadata: { key: "w.writers", segment: "w", name: "writers" } });
  await resolveFn(s, "sheetkeys.opensheet")(s, blob);
  assert.deepEqual(s.cels.get("w.writers")?.v, [me], "opensheet restored the sealed writers list");
  // and the gate agrees: I can write, a stranger cannot
  assert.equal(resolveFn(s, "writableBy")(me, s.cels.get("w.writers")?.v), true);
  assert.equal(resolveFn(s, "writableBy")("stranger", s.cels.get("w.writers")?.v), false);
});
