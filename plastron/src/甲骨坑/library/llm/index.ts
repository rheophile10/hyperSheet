import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, isSecretHandle, resolveFn } from "../../../kernel/index.js";
import { el, text as T } from "../dom/index.js";
import seed from "./甲骨.json" with { type: "json" };

type V = { type: "el" | "text"; tag?: string; attrs?: Record<string, unknown>; events?: Record<string, unknown>; children?: V[]; text?: string };
const elx = el as unknown as (tag: string, attrs?: Record<string, unknown>, children?: V[], events?: Record<string, unknown>) => V;

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
interface ClientHandle { __client: true; id: string; provider: string; model?: string; status: "ready" | "error"; error?: string }
const clientKeys = new Map<string, unknown>();   // id → key (SecretHandle or literal) — out of the graph
// a resolved key is REAL when it's a non-empty string that is not one of the
// wallet's refusal sentinels (#DENIED / #NOKEY / a ✗ marker). The handle keeps
// only the non-secret status; the key itself stays in the keystore, never the value.
const keyIsReal = (k: string): boolean => k !== "" && !/^#DENIED|^#NOKEY|^✗/.test(k);
const makeClientFn: Fn = ((provider: unknown, key: unknown, model: unknown): ClientHandle => {
  const prov = String(provider ?? "claude");
  const keyName = isSecretHandle(key) ? (key as { name: string }).name : "key";
  const id = `${prov}:${keyName}`;                // deterministic — same wallet key → same client id (no re-render churn)
  clientKeys.set(id, key);
  const resolved = (isSecretHandle(key) ? String((key as { resolve: () => string }).resolve() ?? "") : String(key ?? "")).trim();
  const ready = keyIsReal(resolved);
  const h: ClientHandle = ready
    ? { __client: true, id, provider: prov, status: "ready" }
    : { __client: true, id, provider: prov, status: "error", error: "✗ no key" };
  if (model != null && model !== "") h.model = String(model);
  return h;
}) as Fn;
// clientlight(client) — a tiny dom indicator reading the client's `status`:
// 🟢 when ready (a real key armed it), 🔴 on error. Pass a clients.* cell so it
// re-fires when the client (re)mints. Reads only the non-secret status field.
const clientLightFn: Fn = ((client: unknown): V => {
  const c = client as ClientHandle | undefined;
  const ok = !!(c && c.__client === true && c.status === "ready");
  return elx("span", { class: "client-light", title: ok ? "ready" : (c?.error ?? "error"), style: "font-size:.9rem" }, [T(ok ? "🟢" : "🔴")]);
}) as Fn;
// chathistory(messages) — a scrollable dom rendering of a message list
// [{from, text}, …]; one row per message, the sender labeled above its text.
// Pass a messages cell so it re-renders as the conversation grows.
const chatHistoryFn: Fn = ((messages: unknown): V => {
  const msgs = (Array.isArray(messages) ? messages : []) as { from?: unknown; text?: unknown }[];
  const rows = msgs.map((m) => {
    const from = String(m?.from ?? "?"), me = from === "me";
    return elx("div", { class: "chat-msg", style: `align-self:${me ? "flex-end" : "flex-start"};max-width:82%;padding:.3rem .55rem;border-radius:.6rem;background:${me ? "#4a90d9" : "#8883"};color:${me ? "white" : "CanvasText"};font-size:.85rem;white-space:pre-wrap` }, [
      elx("div", { style: "font-size:.62rem;opacity:.65;margin-bottom:.1rem" }, [T(from)]),
      T(String(m?.text ?? "")),
    ]);
  });
  const starter = elx("div", { class: "chat-empty", style: "align-self:center;opacity:.5;font-size:.8rem;padding:.6rem" }, [T("ask the bots anything…")]);
  return elx("div", { class: "chat-history", style: "display:flex;flex-direction:column;gap:.35rem;overflow:auto;max-height:18rem;padding:.2rem" }, rows.length ? rows : [starter]);
}) as Fn;
const clientSendFn: Fn = (async (client: unknown, message: unknown): Promise<string> => {
  const c = client as ClientHandle | undefined;
  if (!c || c.__client !== true) return "(not a client — make one with makeclient(provider, key))";
  const key = clientKeys.get(c.id);
  return c.provider === "grok"
    ? String(await chatFn(message, key, c.model, ""))
    : String(await claudeFn(message, key, c.model));
}) as Fn;

// messages(from1, text1, …) — build a message LIST [{from, text}, …] as a
// plain value (renders as JSON in the grid). Seeds the conversation cell;
// chat.cellsend appends to it. =messages("system", "ask the bots anything")
const messagesFn: Fn = ((...pairs: unknown[]): Msg[] => {
  const out: Msg[] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) out.push({ from: String(pairs[i] ?? ""), text: String(pairs[i + 1] ?? "") });
  return out;
}) as Fn;

const MSGS = "clients.C1", ENTRY = "clients.D1";
type Msg = { from?: string; text?: string };

// chat.cellinput — the entry input's `input` handler: stash the live typed text
// in the clients.D1 buffer cel (read off the event target), so the input is an
// uncontrolled field authorable purely with (on "input" "chat.cellinput") in a
// dom() formula — no {set}/extract binding that the on-verb can't express.
const chatCellInput: Fn = (async (state: State, _p: unknown, event?: { target?: { value?: unknown } }): Promise<void> => {
  await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, ENTRY, String(event?.target?.value ?? "")));
}) as Fn;

// chat.cellsend — append the `clients.D1` text to the messages cell
// (clients.C1) and ask an available client; the reply appends too. Spreadsheet-
// native chat send: the message list and entry are CELS the graph owns.
const readMsgs = (state: State): Msg[] => { const v = state.cels.get(MSGS)?.v; return Array.isArray(v) ? v as Msg[] : []; };
const setMsgs = (state: State, log: Msg[]): Promise<unknown> =>
  Promise.resolve((resolveFn(state, "setValue") as Fn)(state, MSGS, log))
    .then(() => (resolveFn(state, "drain") as Fn)(state, "dom.paint"));
const firstClient = (state: State): ClientHandle | undefined => {
  for (const k of ["clients.A1", "clients.A2"]) { const v = state.cels.get(k)?.v as ClientHandle | undefined; if (v && v.__client === true && v.status === "ready") return v; }
  return undefined;
};
const chatCellSend: Fn = (async (state: State): Promise<void> => {
  const text = String(state.cels.get(ENTRY)?.v ?? "").trim();
  if (!text) return;
  await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, ENTRY, ""));
  await setMsgs(state, [...readMsgs(state), { from: "me", text }]);
  const client = firstClient(state);
  let reply: string;
  if (client) { try { reply = String(await (resolveFn(state, "client.send") as Fn)(client, text)); } catch (e) { reply = "⚠ " + String((e as { message?: unknown })?.message ?? e); } }
  else reply = "(no armed client — set an api key in secrets)";
  await setMsgs(state, [...readMsgs(state), { from: client?.provider ?? "system", text: reply }]);
}) as Fn;
const chatCellKey: Fn = (async (state: State, _p: unknown, event?: { key?: string; preventDefault?: () => void }): Promise<void> => {
  if (event?.key === "Enter") { try { event.preventDefault?.(); } catch { /* */ } await (chatCellSend as unknown as (s: State) => Promise<void>)(state); }
}) as Fn;

// clientsheet() — GENESIS: a "sheet of clients" minted from the wallet. Each cel
// reactively makes a client from a wallet apiKey handle (the key is captured, not
// stored). This segment READS the wallet (apiKey) but never writes it; the chat
// reads these client cels. =clientsheet() then =chatapp("claude","Claude") talks
// to Claude through clients.claude — the key never in the chat's reach.
// The `clients` segment is minted with a STATIC get-whitelist: itself (so its
// makeclient formulas can read the wallet's apiKey via the secrets gate) PLUS
// `win.chat-claude` (the Claude chat's segment), so a chat formula may read
// clients.* — but NOT secrets.* (the secrets segment is sealed; bundling never
// opens a seal, and the chat is not in secrets.get). Claude gets the safe
// CLIENT handle, never the key.
const clientsheetFn: Fn = ((): unknown => ({
  genesis: true, layer: "clients",
  access: { get: ["clients", "win.chat-claude"], set: "private" },
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
  ["clientlight", clientLightFn],
  ["messages", messagesFn],
  ["chathistory", chatHistoryFn],
  ["chat.cellinput", chatCellInput],
  ["chat.cellsend", chatCellSend],
  ["chat.cellkey", chatCellKey],
  ["clientsheet", clientsheetFn],
]));
