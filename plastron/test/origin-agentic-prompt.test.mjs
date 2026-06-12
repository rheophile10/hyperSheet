import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, setAccessPolicy } from "../dist/index.js";

// ============================================================================
// origin-agentic-prompt — the per-turn system prompt chat.cellsend sends to the
// armed client is ENRICHED: it catalogs the editing verbs (each verb's prose
// read VERBATIM from the registry's metadata.description) AND lists the chat's
// CURRENT cel state (every clients.* cel + its source). The catalog/state are
// SCOPED to the chat's own segment — sealed secrets.* and other windows never
// leak. The confined command execution is unchanged (proved in
// origin-agentic-chat.test.mjs); here we only assert the outbound prompt.
// ============================================================================

const SEG = "clients";

// arm a ready client at clients.A1 and capture the prompt that reaches the wire.
// makeclient stashes the (literal) key in the module keystore, so client.send →
// claudeFn → fetch carries the prompt in the request body's user message.
const armedChat = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["dom", "plastron-canvas", "sheet", "builtins", "llm"]);
  const setCel = resolveFn(state, "setCel");
  for (const [addr, spec] of [
    ["C1", { celType: "ValueCel", v: [] }],
    ["D1", { celType: "ValueCel", v: "" }],
    ["E1", { celType: "ValueCel", v: "hello world" }],
    ["F1", { celType: "FormulaCel", f: "(* 6 7)", metadata: { parser: "f" } }],
    ["G1", { celType: "ValueCel", v: "" }],
  ]) {
    await setCel(state, `${SEG}.${addr}`, { ...spec, metadata: { ...(spec.metadata ?? {}), key: `${SEG}.${addr}`, segment: SEG, name: addr } });
  }
  const client = resolveFn(state, "makeclient")("claude", "sk-ant-REALKEY", "");
  await setCel(state, `${SEG}.A1`, { celType: "ValueCel", v: client, metadata: { key: `${SEG}.A1`, segment: SEG, name: "A1" } });
  setAccessPolicy(state, SEG, { get: ["origin"], set: "private" });
  await resolveFn(state, "runCycle")(state);
  return state;
};

// run a send with fetch mocked to capture the prompt the bot receives.
const sendAndCapture = async (state, typed) => {
  await resolveFn(state, "setValue")(state, `${SEG}.D1`, typed);
  let captured = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    try { captured = JSON.parse(init.body).messages[0].content; } catch { captured = String(init?.body ?? ""); }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  try { await resolveFn(state, "chat.cellsend")(state); } finally { globalThis.fetch = realFetch; }
  return captured;
};

test("the prompt CATALOGS the editing verbs, prose taken VERBATIM from metadata.description", async () => {
  const state = await armedChat();
  const prompt = await sendAndCapture(state, "hi there");
  // a known dom builder + its exact description
  const domDesc = state.cels.get("dom")?.metadata?.description;
  assert.ok(domDesc, "dom cel has a description (precondition)");
  assert.ok(prompt.includes("dom:"), "the catalog labels the dom verb");
  assert.ok(prompt.includes(domDesc), "dom's metadata.description appears VERBATIM");
  // a cel-creating verb
  const celsDesc = state.cels.get("cels")?.metadata?.description;
  assert.ok(celsDesc, "cels cel has a description (precondition)");
  assert.ok(prompt.includes(celsDesc), "cels' metadata.description appears VERBATIM");
  // a canvas op
  const rectDesc = state.cels.get("rect")?.metadata?.description;
  assert.ok(rectDesc && prompt.includes(rectDesc), "a canvas op's description appears");
  // the command syntax preamble is still there
  assert.ok(/set <RANGE>/.test(prompt), "the set-line command syntax is described");
});

test("the prompt appends the CURRENT cel state — keys with their source f/v", async () => {
  const state = await armedChat();
  const prompt = await sendAndCapture(state, "what's in the sheet?");
  assert.ok(/Current cells/i.test(prompt), "a current-cells section is present");
  assert.ok(prompt.includes("clients.E1 = hello world"), "a value cel shows its v");
  assert.ok(prompt.includes("clients.F1 = =(* 6 7)"), "a formula cel shows its f source");
});

test("the appended state is SCOPED to the chat segment — sealed secrets.* / other windows do NOT leak", async () => {
  const state = await armedChat();
  // a sealed foreign secret and a foreign window cel
  await resolveFn(state, "setCel")(state, "secrets.A1", { celType: "ValueCel", v: "sk-ant-TOPSECRET", metadata: { key: "secrets.A1", segment: "secrets", name: "A1" } });
  setAccessPolicy(state, "secrets", { get: "private", set: "private", setSealed: true });
  await resolveFn(state, "setCel")(state, "win.other.A1", { celType: "ValueCel", v: "OTHERWINDOW", metadata: { key: "win.other.A1", segment: "win.other", name: "A1" } });
  const prompt = await sendAndCapture(state, "hello");
  assert.ok(!prompt.includes("TOPSECRET"), "sealed secrets.* value did NOT leak into the prompt");
  assert.ok(!prompt.includes("secrets.A1"), "secrets.* key is not in the appended state");
  assert.ok(!prompt.includes("OTHERWINDOW"), "another window's cel did NOT leak");
  assert.ok(!prompt.includes("win.other"), "another window's key is not in the appended state");
  assert.ok(prompt.includes("clients.E1"), "the chat's OWN cells are still listed (scoping, not blanking)");
});

test("the confined command execution is UNCHANGED — a set-line still edits the scratch cel, a foreign addr still #DENIED", async () => {
  const state = await armedChat();
  // a sealed foreign segment the chat must not touch
  await resolveFn(state, "setCel")(state, "vault.A1", { celType: "ValueCel", v: "KEEP", metadata: { key: "vault.A1", segment: "vault", name: "A1" } });
  setAccessPolicy(state, "vault", { get: "private", set: "private", setSealed: true });
  await sendAndCapture(state, "set G1 = banana\nset vault!A1 = pwned");
  assert.equal(state.cels.get(`${SEG}.G1`)?.v, "banana", "the in-segment set-line still landed");
  assert.equal(state.cels.get("vault.A1")?.v, "KEEP", "the foreign write was still refused (confinement intact)");
  const log = state.cels.get(`${SEG}.C1`)?.v ?? [];
  assert.ok(log.some((m) => /#DENIED/.test(String(m.text))), "a #DENIED note still surfaced");
});
