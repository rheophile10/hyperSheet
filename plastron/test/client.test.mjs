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

test("client.send guards a non-client input", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["llm"]);
  const r = await resolveFn(state, "client.send")({ not: "a client" }, "hi");
  assert.ok(String(r).includes("not a client"), "client.send rejects non-clients gracefully");
});
