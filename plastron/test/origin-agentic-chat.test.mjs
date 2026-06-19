import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// ============================================================================
// origin-agentic-chat — the boot chat (the clients sheet: C1 history, D1 entry,
// E1+ scratch) is AGENTIC. A message can EDIT CELS, confined to the chat's
// closure (the `clients` segment). Plain text appends a {from,text}; a command
// (set RANGE = value/formula, or a fenced ```plastron block) writes into the
// range — but ONLY into clients.*, because every write runs under
// withAccessor(state, "clients", …) and Layer 1 refuses a cross-segment write.
// ============================================================================

const SEG = "clients";
const seedChat = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["llm"]);
  const setCel = resolveFn(state, "setCel");
  // the chat's worksheet: history C1, entry D1, a couple of scratch cels E1/F1.
  for (const [addr, v] of [["C1", []], ["D1", ""], ["E1", ""], ["F1", ""]]) {
    await setCel(state, `${SEG}.${addr}`, { celType: "ValueCel", v, metadata: { key: `${SEG}.${addr}`, segment: SEG, name: addr } });
  }
  // the chat is a sealed closure: only itself writes its cels.
  return state;
};
const C1 = (state) => state.cels.get(`${SEG}.C1`)?.v ?? [];

// 1. plain text → a {from,text} message appended to clients.C1
test("a plain-text command appends a {from:'me', text} message to clients.C1", async () => {
  const state = await seedChat();
  await resolveFn(state, "chat.cellrun")(state, SEG, [{ op: "msg", text: "hey whats up" }]);
  const log = C1(state);
  assert.equal(log.length, 1, "one message appended");
  assert.deepEqual(log[0], { from: SEG, text: "hey whats up" }, "msg op appends {from,text}");
});

// 2. a command writes a formula/value to a target range (in-segment → applied)
test("a command writes a value AND a formula into the chat's scratch range", async () => {
  const state = await seedChat();
  const applied = await resolveFn(state, "chat.cellrun")(state, SEG, [
    { op: "cel", addr: "E1", value: "hello" },
    { op: "cel", addr: "F1", formula: "(* 6 7)" },
  ]);
  assert.deepEqual(applied, ["E1", "F1"], "both writes landed (no #DENIED)");
  assert.equal(state.cels.get(`${SEG}.E1`)?.v, "hello", "value written into E1");
  await resolveFn(state, "runCycle")(state);
  assert.equal(state.cels.get(`${SEG}.F1`)?.v, 42, "formula (* 6 7) evaluated in F1");
  assert.equal(state.cels.get(`${SEG}.F1`)?.metadata?.segment, SEG, "scoped to the chat's segment");
});

// 3. a command targeting a cel OUTSIDE the chat segment is REFUSED — the seal holds
// 3b. the bot writes DOT-keyed addresses (clients.E1) — exactly what the prompt's
// cel-state listing shows — so the parser MUST accept dots, or the bot's commands
// are silently ignored (appended as prose). A foreign dot is still #DENIED.
// 4. the SEND path: plain text appends; a set-line edits confined
test("chat.cellsend: plain text appends, a set-line edits the scratch cel confined", async () => {
  const state = await seedChat();
  await resolveFn(state, "setValue")(state, `${SEG}.D1`, "just a note");
  await resolveFn(state, "chat.cellsend")(state);
  let log = C1(state);
  assert.ok(log.some((m) => m.from === "me" && m.text === "just a note"), "plain text appended as a {from:'me'} message");

  await resolveFn(state, "setValue")(state, `${SEG}.D1`, "set E1 = banana");
  await resolveFn(state, "chat.cellsend")(state);
  assert.equal(state.cels.get(`${SEG}.E1`)?.v, "banana", "the set-line wrote the value into E1");
});

// 4b. a set-line targeting a foreign segment is refused on the SEND path too
// 6. grok non-JSON / CORS → a friendly message, NOT a JSON.parse throw
test("grok: an HTML page yields an honest diagnostic (not a parse throw, not a bogus CORS claim)", async () => {
  const state = await seedChat();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<!doctype html><html><body>error</body></html>", {
    status: 200, headers: { "content-type": "text/html" },
  });
  try {
    const r = String(await resolveFn(state, "llm.chat")("hi", "xai-KEY", "grok-3-mini", "https://api.x.ai/v1/chat/completions"));
    assert.ok(!/Unexpected token|is not valid JSON/.test(r), `must not leak the parse error (got ${r})`);
    assert.match(r, /HTML page|not JSON|wrong endpoint/i, "honest HTML-page diagnostic");
    assert.ok(!/CORS blocks/i.test(r), "does NOT falsely blame CORS for an HTML response");
  } finally { globalThis.fetch = realFetch; }
});

test("grok: an empty url goes to api.x.ai, not the local page (the || fix)", async () => {
  const state = await seedChat();
  const realFetch = globalThis.fetch;
  let seenUrl = null;
  globalThis.fetch = async (u) => { seenUrl = String(u); return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } }); };
  try {
    await resolveFn(state, "llm.chat")("hi", "xai-KEY", "grok-3-mini", ""); // client.send passes "" for grok
    assert.ok(seenUrl && seenUrl.includes("api.x.ai"), `empty url must default to x.ai, not "" (got ${seenUrl})`);
  } finally { globalThis.fetch = realFetch; }
});

test("grok: a non-ok JSON error still reports cleanly", async () => {
  const state = await seedChat();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "bad key" }), {
    status: 401, headers: { "content-type": "application/json" },
  });
  try {
    const r = String(await resolveFn(state, "llm.chat")("hi", "xai-KEY", "grok-3-mini", "https://api.x.ai/v1/chat/completions"));
    assert.ok(!/Unexpected token/.test(r), "no parse throw");
    assert.match(r, /grok 401|bad key/i, "surfaces the 401");
  } finally { globalThis.fetch = realFetch; }
});

// 5. the BOT reply path parses + runs commands confined