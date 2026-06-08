import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// loadScript — the kernel's host capability for pulling an external resource
// (a CDN script) at runtime. Off-browser it's a no-op that resolves; the
// browser path (script injection) is covered by the origin =cdn Playwright case.

test("loadScript is a kernel cel; off-browser it resolves to a no-op", async () => {
  const state = createInitialState();
  const loadScript = resolveFn(state, "loadScript");
  assert.equal(typeof loadScript, "function", "loadScript is registered in the kernel");
  // no `document` in bun:test → resolves immediately, no throw
  await loadScript(state, "https://cdn.jsdelivr.net/npm/whatever.js");
  await loadScript(state, ""); // empty url is harmless
});
