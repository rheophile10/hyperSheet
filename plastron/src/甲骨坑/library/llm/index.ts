import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns, isSecretHandle } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// llm — talk to an LLM from a formula. A reusable CAPABILITY (tier-boundary
// doctrine: a thing you'd write TypeScript for → a library), extracted from
// origin so any host can mount it. Network IO rides the `net` gate (claude's
// fetch goes through the wrapped globalThis.fetch — logged + allowlist-checked).
//
// claude() is REACTIVE: the kernel awaits the Promise, the reply becomes the
// cell's value, the formula survives, and editing the prompt re-asks. It
// accepts a SecretHandle (from the wallet's apiKey("…")) so the key is resolved
// at the effect site and never enters the graph.
// ============================================================================

const claudeFn: Fn = async (prompt: unknown, key: unknown, model: unknown): Promise<string> => {
  const p = String(prompt ?? "").trim();
  // accept a kernel SecretHandle (from apiKey("…")) OR a literal key string /
  // cel value. The handle keeps the secret out of the graph — resolution
  // happens HERE, at the effect site, and the secret is never stored.
  const isHandle = isSecretHandle(key);
  const k = (isHandle ? String(key.resolve() ?? "") : String(key ?? "")).trim();
  if (!p) return "(ask something — the reply lands here when the prompt cel has text)";
  if (isHandle && !k) return `(wallet has no usable "${key.name}" — =unlockWallet(), then =apiKeys())`;
  if (!k) return "(no api key — put an sk-ant-… key in the key cel, or use key(\"anthropic\") with the wallet)";
  const res = await fetch("https://api.anthropic.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${k}`,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: model == null || model === "" ? "claude-fable-5" : String(model),
      messages: [{ role: "user", content: p }],
    }),
  });
  if (!res.ok) return `(claude ${res.status}: ${(await res.text()).slice(0, 200)})`;
  const j = await res.json() as { choices?: { message?: { content?: string } }[] };
  return j?.choices?.[0]?.message?.content ?? JSON.stringify(j).slice(0, 500);
};

// llm.chat — a generic OpenAI-shaped chat completion (POST messages, return the
// reply text). The host's chat()/grok() verbs emit a descriptor whose drain
// delegates here. Stateless (just fetch, over the net gate).
const chatFn: Fn = (async (prompt: unknown, key: unknown, model: unknown, url: unknown): Promise<string> => {
  const u = String(url ?? "https://api.x.ai/v1/chat/completions");
  const m = String(model ?? "grok-3-mini");
  const k = String(key ?? "");
  if (!k) return `(no api key — pass one: =claude("hi", "sk-ant-…") / =grok("hi", "xai-…") or a cel holding it)`;
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${k}` };
  if (u.includes("api.anthropic.com")) headers["anthropic-dangerous-direct-browser-access"] = "true";
  const res = await fetch(u, {
    method: "POST", headers,
    body: JSON.stringify({ model: m, messages: [{ role: "user", content: String(prompt ?? "") }] }),
  });
  if (!res.ok) return `(chat ${res.status}: ${(await res.text()).slice(0, 200)})`;
  const j = await res.json() as { choices?: { message?: { content?: string } }[] };
  return j?.choices?.[0]?.message?.content ?? JSON.stringify(j).slice(0, 500);
}) as Fn;

export const name = "llm" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["claude", claudeFn],
  ["llm.chat", chatFn],
]));
