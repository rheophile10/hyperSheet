import { test } from "bun:test";
import assert from "node:assert/strict";

// sheetsync (LWW-Map) WIRE codec + receive pipeline, unit-tested in-process. Two
// independent PEERS can't coexist here (keystore KEYRING + sheetsync DATAKEYS are
// module-scope singletons — one page = one peer), so cross-peer convergence +
// cross-identity gating are the two-page WebRTC e2e. Here, single-replica:
// keystore.wrapTo/unwrapFrom, an ENCRYPTED per-cell op leaking no plaintext, and
// sheetsync.recv decrypting → verifying → gating → LWW-merging an op. Unique seg
// names per test (module-scope state leaks across tests in one process).

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-sheetsync-net";
const { createInitialState, precomputeOptional, resolveFn } = await import("../dist/index.js");

const boot = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["sheetsync", "keystore", "sheetkeys", "crypto", "sheets", "peer", "file-store"]);
  await resolveFn(s, "hydrate")(s, [], []);
  await precomputeOptional(s);
  await resolveFn(s, "runCycle")(s);
  await resolveFn(s, "keystore.create")(s, "netpass", "Owner");
  return s;
};
const F = (s, k) => resolveFn(s, k);
const cel = (s, k) => s.cels.get(k)?.v;

test("keystore.wrapTo / unwrapFrom round-trips a data key (ECDH peer key-exchange)", async () => {
  const s = await boot();
  const myEcdh = cel(s, "keystore.ecdhpub");
  const dk = F(s, "crypto.datakey")();
  const w = await F(s, "keystore.wrapTo")(s, dk, myEcdh);
  assert.equal(w.ok, true);
  assert.ok(/^[^.]+\.[^.]+$/.test(w.env), "env is iv.cipher");
  assert.equal(w.fromPub, myEcdh, "fromPub is the wrapper's ecdh pub");
  const u = await F(s, "keystore.unwrapFrom")(s, w.env, w.fromPub);
  assert.equal(u.ok, true);
  assert.equal(u.dataKey, dk, "the same data key comes back");
  const bad = await F(s, "keystore.unwrapFrom")(s, w.env.replace(/.$/, "X"), w.fromPub);
  assert.equal(bad.ok, false);
});

test("sheetsync.share mints a per-seg data key; the key is module-scope, NOT a cel", async () => {
  const s = await boot();
  const seg = "wsdoc1";
  assert.equal(F(s, "sheetsync.haskey")(s, seg), false, "no key before share");
  const r = await F(s, "sheetsync.share")(s, seg, cel(s, "keystore.ecdhpub"));
  assert.equal(r.ok, true);
  assert.equal(r.frame.t, "key", "share emits a key frame");
  assert.equal(F(s, "sheetsync.haskey")(s, seg), true, "key is held after share");
  assert.equal(s.cels.get(`${seg}.datakey`), undefined, "the data key never becomes a cel");
  assert.ok(r.frame.env && r.frame.fromPub, "frame carries the ECDH-wrapped data key");
  assert.ok(typeof r.frame.map === "string", "frame carries the encrypted map snapshot");
});

test("a SYNCED commit emits an encrypted op-frame that leaks no plaintext source", async () => {
  const s = await boot();
  const seg = "wsdoc2";
  await F(s, "sheetsync.share")(s, seg, cel(s, "keystore.ecdhpub"));   // hold a data key → commits broadcast
  const r = await F(s, "sheetsync.commit")(s, seg, `${seg}.A1`, "topsecret-7");
  assert.equal(r.ok, true);
  assert.ok(r.frame && r.frame.t === "op", "a synced commit returns an op frame");
  assert.match(r.frame.enc, /^[^.]+\.[^.]+$/, "the op is an iv.cipher envelope");
  assert.ok(!JSON.stringify(r.frame).includes("topsecret-7"), "the plaintext source is NOT on the wire");
  assert.equal(cel(s, `${seg}.A1`), "topsecret-7", "but it applied locally");
});

test("an UNSYNCED commit (no data key) stays local — no frame", async () => {
  const s = await boot();
  const seg = "wsdoc3";
  const r = await F(s, "sheetsync.commit")(s, seg, `${seg}.A1`, "5");
  assert.equal(r.ok, true);
  assert.equal(r.frame, null, "no data key → no broadcast frame");
});

test("sheetsync.recv decrypts → verifies → gates → LWW-merges an op-frame", async () => {
  const s = await boot();
  const seg = "wsdoc4";
  await F(s, "sheetsync.share")(s, seg, cel(s, "keystore.ecdhpub"));
  const r = await F(s, "sheetsync.commit")(s, seg, `${seg}.A1`, "42");
  const frame = r.frame;
  // simulate a fresh replica that holds the key but not this op: clear the map + cell.
  await F(s, "setCel")(s, `${seg}.crdt`, { celType: "ValueCel", v: {}, metadata: { key: `${seg}.crdt`, segment: seg, name: "crdt" } });
  await F(s, "setCel")(s, `${seg}.A1`, { celType: "ValueCel", v: 0, metadata: { key: `${seg}.A1`, segment: seg, name: "A1" } });
  const d = await F(s, "sheetsync.recv")(s, frame);
  assert.equal(d, "applied", "the op-frame applied");
  assert.equal(cel(s, `${seg}.A1`), 42, "recv projected the op into the source cel");
  assert.equal(Object.keys(cel(s, `${seg}.crdt`)).length, 1, "one cell in the map");
  // idempotent: replaying the same op doesn't change anything (loses the merge)
  const again = await F(s, "sheetsync.recv")(s, frame);
  assert.equal(again, "applied");
  assert.equal(Object.keys(cel(s, `${seg}.crdt`)).length, 1, "duplicate op deduped (LWW no-op)");
  assert.equal(cel(s, `${seg}.A1`), 42);
});

test("sheetsync.recv rejects a tampered op-frame and an unkeyed segment", async () => {
  const s = await boot();
  const seg = "wsdoc5";
  await F(s, "sheetsync.share")(s, seg, cel(s, "keystore.ecdhpub"));
  const r = await F(s, "sheetsync.commit")(s, seg, `${seg}.A1`, "9");
  const tampered = { ...r.frame, enc: r.frame.enc.replace(/.$/, r.frame.enc.endsWith("A") ? "B" : "A") };
  assert.equal(await F(s, "sheetsync.recv")(s, tampered), "dropped:decrypt", "tampered ciphertext rejected");
  const noKey = { t: "op", seg: "never-shared", enc: r.frame.enc };
  assert.equal(await F(s, "sheetsync.recv")(s, noKey), "dropped:nokey", "no data key → dropped");
  assert.equal(await F(s, "sheetsync.recv")(s, { t: "hello", pub: "peerSign", ecdh: "peerEcdh" }), "hello");
});
