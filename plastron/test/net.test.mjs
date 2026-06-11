import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// net — the network governance gate. The kernel owns the stateless fetch door
// (kernel/fetch.ts); this segment owns the stateful gate: a wrapped global
// fetch, the traffic log (netlog), and the host allowlist (netallow), all
// surfaced as cell values.

test("net seeds the gate verbs", () => {
  const state = createInitialState();
  for (const k of ["fetch", "netlog", "netallow"]) {
    assert.ok(state.cels.get(k), `${k} cel missing`);
  }
});

test("the gate wraps globalThis.fetch (idempotent)", () => {
  createInitialState();
  // importing the segment installs the wrapper once
  assert.equal(globalThis.fetch.__netGated, true, "globalThis.fetch should be gated");
});

test("netallow declares the whitelist; off-list fetches are BLOCKED + logged; netlog surfaces it", async () => {
  const state = createInitialState();
  const netallow = resolveFn(state, "netallow");
  const netlog = resolveFn(state, "netlog");

  // declare an allowlist that does NOT include example.org
  const policy = netallow("api.anthropic.com");
  assert.match(policy, /api\.anthropic\.com/);

  // a fetch to an off-list host is blocked BEFORE hitting the network (no
  // network in this test) — it throws and is recorded
  await assert.rejects(
    () => globalThis.fetch("https://example.org/secret"),
    /blocked .* not in net\.allowlist/,
  );

  const wiretap = netlog();
  assert.match(wiretap, /BLOCKED/);
  assert.match(wiretap, /example\.org/);

  // reset to allow-all so the module-global allowlist doesn't leak into other
  // tests in this process
  const reset = netallow("*");
  assert.match(reset, /all hosts allowed/);
});

test("netallow() with no args surfaces the current policy", () => {
  const state = createInitialState();
  const netallow = resolveFn(state, "netallow");
  netallow("*"); // ensure allow-all
  assert.match(netallow(), /all hosts allowed/);
});

// provenance (network-governance Layer 5): the net gate attributes a request to
// the CEL that caused it (getCurrentCel, stamped around fireCel in runCycle).
test("net.log attributes a request to the cel that caused it (provenance)", async () => {
  const s = createInitialState();
  const netallow = resolveFn(s, "netallow"), netlog = resolveFn(s, "netlog");
  netallow("api.anthropic.com"); // block example.org
  await resolveFn(s, "hydrate")(s, [{ name: "u", cels: [
    { key: "caller", celType: "FormulaCel", metadata: { key: "caller", segment: "u", parser: "f" }, f: '(fetch "https://example.org/x")' },
  ]}], [{ name: "u", version: "0", description: "", dependencies: [] }]);
  await resolveFn(s, "runCycle")(s);
  assert.match(netlog(), /\(caller\)/, "the blocked request is attributed to the caller cel");
  netallow("*"); // reset
});
