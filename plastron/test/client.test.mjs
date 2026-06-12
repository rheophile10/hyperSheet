import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// capability C — a captured llm client; the key is NEVER in the cel value.
test("makeclient captures the key — the client handle holds NO secret", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["llm"]);
  const handle = resolveFn(state, "makeclient")("claude", "sk-ant-SECRET123", "");
  assert.equal(handle.__client, true);
  assert.equal(handle.provider, "claude");
  assert.ok(!JSON.stringify(handle).includes("SECRET"), "the API key is NOT in the client handle value");
  const h2 = resolveFn(state, "makeclient")("claude", "sk-ant-OTHER", "");
  assert.equal(h2.id, handle.id, "deterministic id (same provider+keyname) — no re-render churn");
});

// the VALUE shows status (non-secret): a real key → ready; empty / refusal → error.
test("makeclient's VALUE shows status: real key → ready, empty/#DENIED → ✗ no key", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["llm"]);
  const ready = resolveFn(state, "makeclient")("claude", "sk-ant-REAL", "");
  assert.equal(ready.status, "ready", "a real key arms the client (status ready)");
  assert.equal(ready.error, undefined, "no error when ready");

  const empty = resolveFn(state, "makeclient")("grok", "", "");
  assert.equal(empty.status, "error", "an empty key → error status");
  assert.equal(empty.error, "✗ no key", "the non-secret error reads ✗ no key");

  const denied = resolveFn(state, "makeclient")("grok", '#DENIED(apiKey "xai": …)', "");
  assert.equal(denied.status, "error", "a #DENIED refusal → error status");
  const nokey = resolveFn(state, "makeclient")("grok", '#NOKEY(apiKey "xai": …)', "");
  assert.equal(nokey.status, "error", "a #NOKEY refusal → error status");
  assert.ok(!JSON.stringify(ready).includes("sk-ant-REAL"), "the key is still NOT in the value");
});

// clientlight — a 🟢 / 🔴 dom indicator over the client's status.
test("clientlight renders 🟢 for a ready client and 🔴 for an error client", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["llm"]);
  const ready = resolveFn(state, "makeclient")("claude", "sk-ant-REAL", "");
  const errc = resolveFn(state, "makeclient")("grok", "", "");
  const green = resolveFn(state, "clientlight")(ready);
  const red = resolveFn(state, "clientlight")(errc);
  const txt = (n) => (n.type === "text" ? n.text : (n.children ?? []).map(txt).join(""));
  assert.equal(txt(green), "🟢", "ready client → green light");
  assert.equal(txt(red), "🔴", "error client → red light");
});

// chathistory — a scrollable dom rendering of a message list.
test("chathistory renders one bubble per {from, text} message", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["llm"]);
  const msgs = resolveFn(state, "messages")("me", "hello", "claude", "hi there");
  assert.deepEqual(msgs, [{ from: "me", text: "hello" }, { from: "claude", text: "hi there" }], "messages() builds the list");
  const hist = resolveFn(state, "chathistory")(msgs);
  assert.equal(hist.type, "el", "chathistory is a dom vnode");
  const txt = (n) => (n.type === "text" ? n.text : (n.children ?? []).map(txt).join(""));
  const flat = txt(hist);
  assert.match(flat, /hello/, "renders the first message text");
  assert.match(flat, /hi there/, "renders the second message text");
  assert.match(flat, /claude/, "labels the sender");
  // a non-array → empty (no throw)
  assert.equal(resolveFn(state, "chathistory")("").type, "el", "chathistory tolerates a non-array (empty)");
});

test("client.send guards a non-client input", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["llm"]);
  const r = await resolveFn(state, "client.send")({ not: "a client" }, "hi");
  assert.ok(String(r).includes("not a client"), "client.send rejects non-clients gracefully");
});
