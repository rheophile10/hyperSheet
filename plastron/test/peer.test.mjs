import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// peer — the p2p security core. A remote peer is UNTRUSTED; peer.apply gates
// every inbound message against the 4 rules (p2p-peer-transport.md stage 1).
const apply = (s, msg) => resolveFn(s, "peer.apply")(s, msg);
const val = (s, k) => s.cels.get(k)?.v;

test("rule 1 — setValue-ONLY: a structure message is dropped", async () => {
  const s = createInitialState();
  resolveFn(s, "peerallow")("shared.");
  assert.equal(await apply(s, { t: "setCel", k: "shared.x", v: 1 }), "dropped:tier");
  assert.equal(await apply(s, { t: "set" }), "dropped:tier"); // no key
});

test("rule 2 — namespace allowlist: outside-namespace writes are dropped (default-deny)", async () => {
  const s = createInitialState();
  resolveFn(s, "peerallow")("shared.");
  assert.equal(await apply(s, { t: "set", k: "private.secret", v: 9 }), "dropped:namespace");
  assert.equal(val(s, "private.secret"), undefined);
});

test("a clean data write IN the namespace is APPLIED", async () => {
  const s = createInitialState();
  resolveFn(s, "peerallow")("shared.");
  assert.equal(await apply(s, { t: "set", k: "shared.x", v: 42 }), "applied");
  assert.equal(val(s, "shared.x"), 42);
  assert.equal(await apply(s, { t: "set", k: "shared.name", v: "ada" }), "applied");
  assert.equal(val(s, "shared.name"), "ada");
});

test("rule 3 — 函 quarantine: JSON-shaped executables are rejected (incl. nested)", async () => {
  const s = createInitialState();
  resolveFn(s, "peerallow")("shared.");
  for (const v of [
    { genesis: true, cels: {} },              // structure request
    { defn: true, name: "evil" },             // function def
    { type: "el", events: { click: {} } },    // a raw vnode (carries events)
    { __mount: ".origin", vnode: {} },        // a placement
    { celType: "LockedLambdaCel", _fn: 1 },   // a cel/lambda spec
    { ok: 1, nested: { genesis: true } },     // hidden deep
  ]) {
    assert.equal(await apply(s, { t: "set", k: "shared.x", v }), "quarantined", JSON.stringify(v));
  }
  // none of them were applied
  assert.equal(val(s, "shared.x"), undefined);
});

test("rule 4 — no secret exfil: a write onto a secret-holding cel is dropped", async () => {
  const s = createInitialState();
  resolveFn(s, "peerallow")("shared.");
  // plant a secret-shaped value locally
  await resolveFn(s, "setCel")(s, "shared.key", { celType: "ValueCel", v: { __secretHandle: true, name: "anthropic" }, metadata: { key: "shared.key", segment: "app" } });
  assert.equal(await apply(s, { t: "set", k: "shared.key", v: "stolen" }), "dropped:secret");
});

test("outbound — broadcast ships only allowed, non-secret, non-executable VALUES", async () => {
  const s = createInitialState();
  resolveFn(s, "peerallow")("shared.");
  const sent = [];
  resolveFn(s, "peer.connect")(s, { send: (m) => sent.push(JSON.parse(m)) });
  await resolveFn(s, "setCel")(s, "shared.a", { celType: "ValueCel", v: 1, metadata: { key: "shared.a", segment: "app" } });
  await resolveFn(s, "setCel")(s, "private.b", { celType: "ValueCel", v: 2, metadata: { key: "private.b", segment: "app" } });
  await resolveFn(s, "setCel")(s, "shared.fn", { celType: "ValueCel", v: { defn: true }, metadata: { key: "shared.fn", segment: "app" } });
  const n = resolveFn(s, "peer.broadcast")(s, ["shared.a", "private.b", "shared.fn"]);
  assert.equal(n, 1, "only shared.a ships");
  assert.deepEqual(sent, [{ t: "set", k: "shared.a", v: 1 }]);
});

test("rule 5 — size cap: an oversized value or key is dropped (DoS guard)", async () => {
  const s = createInitialState();
  resolveFn(s, "peerallow")("shared.");
  const big = "x".repeat(70 * 1024);              // > 64KB value
  assert.equal(await apply(s, { t: "set", k: "shared.x", v: big }), "dropped:size");
  assert.equal(await apply(s, { t: "set", k: "shared." + "k".repeat(300), v: 1 }), "dropped:size");
  assert.equal(val(s, "shared.x"), undefined);
  // a normal-sized value still applies
  assert.equal(await apply(s, { t: "set", k: "shared.ok", v: "fine" }), "applied");
});
