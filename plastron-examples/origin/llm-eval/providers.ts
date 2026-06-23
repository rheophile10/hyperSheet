// providers — call each model with (systemPrompt, userTask) → its raw text reply.
// Anthropic via the official SDK; xAI (Grok) and OpenAI via their OpenAI-shaped
// /chat/completions endpoints. A provider with a blank key is reported as skipped.
import Anthropic from "@anthropic-ai/sdk";

export interface Reply { provider: string; model: string; text: string | null; skipped?: boolean; error?: string }

const env = (k: string, d = "") => process.env[k]?.trim() || d;

// ── Anthropic (Claude) — official SDK ────────────────────────────────────────
const claude = async (system: string, task: string): Promise<Reply> => {
  const model = env("ANTHROPIC_MODEL", "claude-opus-4-8");
  const key = env("ANTHROPIC_API_KEY");
  if (!key) return { provider: "claude", model, text: null, skipped: true };
  try {
    const client = new Anthropic({ apiKey: key });
    const r = await client.messages.create({
      model, max_tokens: 4000,
      system, messages: [{ role: "user", content: task }],
    });
    const text = r.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
    return { provider: "claude", model, text };
  } catch (e) { return { provider: "claude", model, text: null, error: String((e as { message?: unknown })?.message ?? e) }; }
};

// ── OpenAI-shaped /chat/completions (used for xAI Grok + OpenAI) ──────────────
const openaiShaped = async (provider: string, base: string, keyVar: string, modelVar: string, modelDefault: string, system: string, task: string): Promise<Reply> => {
  const model = env(modelVar, modelDefault);
  const key = env(keyVar);
  if (!key) return { provider, model, text: null, skipped: true };
  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: task }] }),
    });
    if (!resp.ok) return { provider, model, text: null, error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}` };
    const j = await resp.json() as { choices?: { message?: { content?: string } }[] };
    return { provider, model, text: j.choices?.[0]?.message?.content ?? null };
  } catch (e) { return { provider, model, text: null, error: String((e as { message?: unknown })?.message ?? e) }; }
};

// ── local model on the user's box (3090) via an OpenAI-compatible server ──────
// Ollama (default :11434), LM Studio (:1234), llama.cpp/vLLM all expose
// /v1/chat/completions. Enabled when LOCAL_MODEL is set; if the endpoint is down
// it reports skipped (with a reason) so the matrix run continues.
const localOpenai = async (system: string, task: string): Promise<Reply> => {
  const model = env("LOCAL_MODEL");
  const base = env("LOCAL_BASE_URL", "http://localhost:11434/v1");
  if (!model) return { provider: "local-3090", model: "(LOCAL_MODEL unset)", text: null, skipped: true };
  const key = env("LOCAL_API_KEY", "ollama");   // most local servers ignore the key
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300_000);   // local generation can be slow
  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: task }], temperature: 0.2, stream: false }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return { provider: "local-3090", model, text: null, error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}` };
    const j = await resp.json() as { choices?: { message?: { content?: string } }[] };
    return { provider: "local-3090", model, text: j.choices?.[0]?.message?.content ?? null };
  } catch (e) {
    const msg = String((e as { message?: unknown })?.message ?? e);
    // a connection refused / abort = the box isn't serving → skip, don't fail the run
    return { provider: "local-3090", model, text: null, skipped: true, error: `endpoint ${base} unreachable (${msg.slice(0, 80)})` };
  } finally { clearTimeout(timer); }
};

export const callAll = (system: string, task: string): Promise<Reply>[] => [
  claude(system, task),
  openaiShaped("grok", "https://api.x.ai/v1", "XAI_API_KEY", "XAI_MODEL", "grok-4", system, task),
  openaiShaped("chatgpt", "https://api.openai.com/v1", "OPENAI_API_KEY", "OPENAI_MODEL", "gpt-5", system, task),
  localOpenai(system, task),
];
