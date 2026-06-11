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

// ── client — a CAPTURED llm client (capability C). makeclient(provider, key,
// model?) returns a CLIENT HANDLE that captured the key in a module-scope
// keystore — NEVER in the cel value (mirrors SecretHandle/CryptoKeyHandle).
// client.send(handle, msg) resolves the key at the effect site. So a chat uses
// the CLIENT cel, never the key, and the wallet (the key's segment) stays sealed:
// only the client-maker reads the wallet; downstream sees only the client.
interface ClientHandle { __client: true; id: string; provider: string; model?: string }
const clientKeys = new Map<string, unknown>();   // id → key (SecretHandle or literal) — out of the graph
const makeClientFn: Fn = ((provider: unknown, key: unknown, model: unknown): ClientHandle => {
  const prov = String(provider ?? "claude");
  const keyName = isSecretHandle(key) ? (key as { name: string }).name : "key";
  const id = `${prov}:${keyName}`;                // deterministic — same wallet key → same client id (no re-render churn)
  clientKeys.set(id, key);
  const h: ClientHandle = { __client: true, id, provider: prov };
  if (model != null && model !== "") h.model = String(model);
  return h;
}) as Fn;
const clientSendFn: Fn = (async (client: unknown, message: unknown): Promise<string> => {
  const c = client as ClientHandle | undefined;
  if (!c || c.__client !== true) return "(not a client — make one with makeclient(provider, key))";
  const key = clientKeys.get(c.id);
  return c.provider === "grok"
    ? String(await chatFn(message, key, c.model, ""))
    : String(await claudeFn(message, key, c.model));
}) as Fn;

// clientsheet() — GENESIS: a "sheet of clients" minted from the wallet. Each cel
// reactively makes a client from a wallet apiKey handle (the key is captured, not
// stored). This segment READS the wallet (apiKey) but never writes it; the chat
// reads these client cels. =clientsheet() then =chatapp("claude","Claude") talks
// to Claude through clients.claude — the key never in the chat's reach.
const clientsheetFn: Fn = ((): unknown => ({
  genesis: true, layer: "clients",
  cels: {
    "clients.claude": { celType: "FormulaCel", f: '(makeclient "claude" (apiKey "anthropic"))', metadata: { name: "claude", parser: "f" } },
    "clients.grok": { celType: "FormulaCel", f: '(makeclient "grok" (apiKey "xai"))', metadata: { name: "grok", parser: "f" } },
  },
})) as Fn;

export const name = "llm" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["claude", claudeFn],
  ["llm.chat", chatFn],
  ["makeclient", makeClientFn],
  ["client.send", clientSendFn],
  ["clientsheet", clientsheetFn],
]));
