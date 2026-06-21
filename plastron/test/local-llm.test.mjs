import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, isDangerous } from "../dist/index.js";

// local — an in-browser LLM (WebLLM + Qwen2.5-0.5B) selected the SAME way as
// claude/grok (a "local" provider). These tests run in Bun (no WebGPU), so they
// pin the capability probe + the provider wiring; a real completion needs a
// browser with WebGPU (the e2e).

// =localcheck() probes the machine and downloads nothing. Under Bun there's a
// navigator but no navigator.gpu → webgpu:false, canRun:false, with a reason.
test("localcheck probes WebGPU/memory/storage and reports canRun (false in Bun — no WebGPU)", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["llm"]);
  const c = await resolveFn(state, "localcheck")();
  assert.equal(typeof c, "object", "returns a capability object");
  assert.equal(c.webgpu, false, "no WebGPU under Bun");
  assert.equal(c.canRun, false, "→ can't run a local model here");
  assert.match(c.reason, /WebGPU/, "the reason explains why");
  assert.equal(typeof c.gpuMaxBufferMB, "number");
  assert.equal(typeof c.storageFreeMB, "number");
});

// makeclient("local") is KEYLESS — it runs in-browser. Always ready, no secret.
test("makeclient('local') → a ready, keyless client (selected like claude/grok)", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["llm"]);
  const h = resolveFn(state, "makeclient")("local");
  assert.equal(h.__client, true);
  assert.equal(h.provider, "local");
  assert.equal(h.status, "ready", "local needs no key — always ready");
  assert.equal(h.id, "local");
});

// client.send routes a local client to the in-browser model. Under Bun (no
// WebGPU) the load fails with #UNSUPPORTED — proving the route, not the model.
test("client.send routes provider 'local' to the in-browser model", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["llm"]);
  const h = resolveFn(state, "makeclient")("local");
  const r = String(await resolveFn(state, "client.send")(h, "hi"));
  assert.match(r, /#ERROR|UNSUPPORTED|WebGPU/, "routes to local, which can't load without WebGPU here");
});

// =localchat returns the reply directly (reactive, like =claude). No WebGPU here
// → a clean #ERROR, never a throw into the cell.
test("localchat returns a clean error (not a throw) when WebGPU is absent", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["llm"]);
  const r = String(await resolveFn(state, "localchat")("hello"));
  assert.match(r, /#ERROR|UNSUPPORTED|WebGPU/, "a graceful error, never a thrown exception");
  const empty = String(await resolveFn(state, "localchat")(""));
  assert.match(empty, /ask something|#ERROR|WebGPU/, "an empty prompt is handled");
});

// the blacklist PROPERTY — localload/localchat are DANGEROUS (net); the central
// consent machinery gates the ~400MB download. localcheck is a harmless probe.
test("localload + localchat are blacklisted (DANGEROUS); localcheck is not", () => {
  assert.equal(isDangerous("localload"), true, "the model download is blacklisted");
  assert.equal(isDangerous("localchat"), true, "running the model (first use downloads) is blacklisted");
  assert.equal(isDangerous("localcheck"), false, "the capability probe downloads nothing — not dangerous");
});

// clientsheet() mints clients.local alongside clients.claude / clients.grok, so
// the local provider is pickable from the same sheet.
test("clientsheet mints a clients.local client", async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["llm"]);
  const g = resolveFn(state, "clientsheet")();
  assert.ok(g.cels["clients.local"], "clients.local is seeded");
  assert.match(g.cels["clients.local"].f, /makeclient "local"/, "it makes a local client (no key)");
});
