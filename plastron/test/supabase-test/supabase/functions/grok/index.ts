// grok — a generic xAI chat-completion proxy (Deno edge function), ripped from
// ccfr-apps' bot-responder. The browser sends { messages, model?, search?,
// tools?, tool_choice? }; this calls xAI with the SERVER-SIDE XAI_API_KEY and
// returns { reply, tool_calls? }. The key never reaches the browser. `tools`
// are forwarded UNTOUCHED and any tool_calls in the model reply come back
// UNTOUCHED — the CLIENT applies them through the user's own commit path and
// sends follow-up {role:"tool"} messages (grok-chat-bots.md: the proxy is a
// dumb forwarder; no privileged mutation surface lives here). With no key set
// it returns a clearly-marked STUB formula so the whole client pipeline is
// testable end to end without a provider key.
//
//   client: supabase.invoke(project, 'grok', { messages, tools })
//   deploy: supabase functions deploy grok ; supabase secrets set XAI_API_KEY=...
//
// Auth: deploy with verify_jwt so only signed-in callers reach it; the function
// itself needs no DB access (context comes in the body from the segment).

const XAI_API_KEY = Deno.env.get("XAI_API_KEY") ?? "";
const XAI_API_URL = Deno.env.get("XAI_API_URL") ?? "https://api.x.ai/v1/chat/completions";
const DEFAULT_MODEL = Deno.env.get("XAI_DEFAULT_MODEL") ?? "grok-4.20-non-reasoning-latest";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { messages, model, search, tools, tool_choice } = await req.json().catch(() => ({}));
    if (!Array.isArray(messages) || !messages.length) return json({ error: "messages[] required" }, 400);

    if (!XAI_API_KEY) {
      // STUB so the pipeline is testable without a key: a benign formula that
      // echoes the last user line (proves the round-trip + that context arrived).
      const last = String([...messages].reverse().find((m) => m?.role === "user")?.content ?? "").slice(0, 60).replace(/"/g, "'");
      return json({ reply: `="grok stub — set XAI_API_KEY. asked: ${last}"`, stub: true });
    }

    const body: Record<string, unknown> = { model: model || DEFAULT_MODEL, messages };
    if (search) body.search_parameters = { mode: "auto" };
    if (Array.isArray(tools) && tools.length) {
      body.tools = tools;                       // forwarded untouched
      if (tool_choice !== undefined) body.tool_choice = tool_choice;
    }
    const res = await fetch(XAI_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${XAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return json({ error: `xAI ${res.status}`, detail: (await res.text().catch(() => "")).slice(0, 300) }, 502);
    const data = await res.json();
    const msg = data?.choices?.[0]?.message ?? {};
    const out: Record<string, unknown> = { reply: msg?.content ?? "" };
    if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length) out.tool_calls = msg.tool_calls; // returned untouched
    return json(out);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
