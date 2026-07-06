import { test, afterAll } from "bun:test";
import assert from "node:assert/strict";

// grok — the LLM-in-a-sheet bridge. We stand up a STUB edge function (a tiny Bun
// server mimicking POST /functions/v1/grok) and prove the client path end to end:
// grok.ask assembles the SEGMENT context + the question, supabase.invoke posts it
// with the project's auth, and the reply (a plastron formula) comes back. No xAI
// key needed — the stub echoes what it received so we can assert the context flowed.

const { createInitialState, precomputeOptional, resolveFn } = await import("../dist/index.js");

// stub edge function: capture the last request body, return a canned formula.
let lastBody = null;
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/functions/v1/grok" && req.method === "POST") {
      lastBody = await req.json().catch(() => ({}));
      return new Response(JSON.stringify({ reply: "=SUM(doc.A1:doc.A3)" }), { headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  },
});
const STUB_URL = `http://127.0.0.1:${stub.port}`;

const boot = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["grok", "supabase", "sheets"]);
  await resolveFn(s, "hydrate")(s, [], []);
  await precomputeOptional(s);
  await resolveFn(s, "runCycle")(s);
  // point the "default" supabase project at the stub
  const setCel = (k, v, name) => resolveFn(s, "setCel")(s, k, { celType: "ValueCel", v, metadata: { key: k, segment: "supabase", name } });
  await setCel("sb.default.url", STUB_URL, "default.url");
  await setCel("sb.default.anonkey", "stub-anon", "default.anonkey");
  return s;
};
const F = (s, k) => resolveFn(s, k);
const put = (s, k, spec) => resolveFn(s, "setCel")(s, k, { metadata: { key: k, segment: k.split(".")[0] }, ...spec });

test("supabase.invoke posts to /functions/v1/<fn> and returns the JSON reply", async () => {
  const s = await boot();
  const r = await F(s, "supabase.invoke")(s, "default", "grok", { messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.reply, "=SUM(doc.A1:doc.A3)", "the stub reply came back");
  assert.ok(Array.isArray(lastBody.messages), "the body reached the function");
});

test("grok.ask sends the SEGMENT context + the question, returns a formula", async () => {
  const s = await boot();
  // build a little sheet
  await put(s, "doc.A1", { celType: "ValueCel", v: 5 });
  await put(s, "doc.A2", { celType: "ValueCel", v: 10 });
  await put(s, "doc.B1", { celType: "FormulaCel", f: "=doc.A1*2", v: 10 });
  const r = await F(s, "grok.ask")(s, "doc", "sum the A column");
  assert.equal(r.ok, true);
  assert.equal(r.reply, "=SUM(doc.A1:doc.A3)", "got a formula back");
  assert.equal(r.bot, "smith", "asked the default bot");
  // the request carried a system primer + the sheet context + the question
  const sys = lastBody.messages.find((m) => m.role === "system")?.content ?? "";
  const usr = lastBody.messages.find((m) => m.role === "user")?.content ?? "";
  assert.match(sys, /plastron|formula/i, "system prompt is the formula primer");
  assert.match(usr, /doc\.A1 = 5/, "the value cell is in the context");
  assert.match(usr, /doc\.B1: =doc\.A1\*2/, "the formula cell's TEXT (source) is in the context");
  assert.match(usr, /sum the A column/, "the question is included");
});

test("grok.context lists source cells (formula text + value json), skips control cels", async () => {
  const s = await boot();
  await put(s, "g.A1", { celType: "ValueCel", v: 7 });
  await put(s, "g.B1", { celType: "FormulaCel", f: "=g.A1+1", v: 8 });
  await put(s, "g.crdt", { celType: "ValueCel", v: { "g.A1": { kind: "v", val: 7 } } }); // control: excluded
  const ctx = F(s, "grok.context")(s, "g");
  assert.match(ctx, /g\.A1 = 7/);
  assert.match(ctx, /g\.B1: =g\.A1\+1/);
  assert.ok(!ctx.includes("g.crdt"), "the sync control cel is excluded from context");
});

test("a different bot can be chosen by handle", async () => {
  const s = await boot();
  await put(s, "doc.A1", { celType: "ValueCel", v: 1 });
  const r = await F(s, "grok.ask")(s, "doc", "make something playful", "muse");
  assert.equal(r.ok, true);
  assert.equal(r.bot, "muse");
  const sys = lastBody.messages.find((m) => m.role === "system")?.content ?? "";
  assert.match(sys, /Playful|lateral/i, "the muse persona is layered onto the primer");
});

afterAll(() => stub.stop());
