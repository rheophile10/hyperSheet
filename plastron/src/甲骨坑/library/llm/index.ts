import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, isSecretHandle, resolveFn, withAccessor, parseA1 } from "../../../kernel/index.js";
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

// readReply — parse an llm completion response DEFENSIVELY. A browser CORS
// block (x.ai/anthropic direct), a missing key, or a captive-portal proxy
// answers with an HTML error page, not JSON; JSON.parse then throws
// "Unexpected token '<'" and the raw error leaks into the chat. So: check
// res.ok, sniff the content-type, and try/catch the .json() — on any
// non-JSON/non-ok response return a clear, friendly note instead of the throw.
const readReply = async (res: Response, label: string): Promise<string> => {
  const ct = res.headers.get("content-type") ?? "";
  const looksJson = ct.includes("json");
  if (!res.ok || !looksJson) {
    let body = "";
    try { body = (await res.text()).trim(); } catch { /* body unreadable */ }
    const html = /^<|<!doctype/i.test(body);
    if (html || !looksJson) return `(${label} unreachable — browser CORS blocks ${label} direct calls, or no api key)`;
    return `(${label} ${res.status}: ${body.slice(0, 200)})`;
  }
  let j: { choices?: { message?: { content?: string } }[] } | undefined;
  try { j = await res.json() as { choices?: { message?: { content?: string } }[] }; }
  catch { return `(${label} unreachable — browser CORS blocks ${label} direct calls, or no api key)`; }
  return j?.choices?.[0]?.message?.content ?? JSON.stringify(j).slice(0, 500);
};

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
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/chat/completions", {
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
  } catch { return "(claude unreachable — browser CORS blocks claude direct calls, or no api key)"; }
  return readReply(res, "claude");
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
  const label = u.includes("x.ai") ? "grok" : u.includes("anthropic") ? "claude" : "chat";
  let res: Response;
  try {
    res = await fetch(u, {
      method: "POST", headers,
      body: JSON.stringify({ model: m, messages: [{ role: "user", content: String(prompt ?? "") }] }),
    });
  } catch { return `(${label} unreachable — browser CORS blocks ${label} direct calls, or no api key)`; }
  return readReply(res, label);
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

const ENTRY = "clients.D1";
const SHEET = "clients";   // the chat's worksheet — the prefix every command write is forced into; C1 holds the history
type Msg = { from?: string; text?: string };

// ── agentic command model (the "agentic chat in a sealed closure" goal) ──────
// A message may EDIT CELS, not just append text. Plain text is the DEFAULT
// (append a {from,text} to the history); a COMMAND names a cel RANGE + a
// value/formula and WRITES it into that range — but ONLY into the chat's own
// worksheet, because every write runs under withAccessor(state, "clients", …),
// so Layer 1 CONFINES it (the kernel refuses a cross-segment write, the same
// sealed-closure guarantee window-sheet-isolation.test.mjs proves). A range
// outside reach resolves to a refused/#DENIED write, never landing.
//
// Two surfaces, ONE executor:
//   • a human/bot LINE — `set <RANGE> = <value-or-formula>` (RANGE = A1 or
//     A1:B2). A body that starts with ( or = becomes a FORMULA cel; else a
//     VALUE cel. Any non-`set` text is the message that appends.
//   • a fenced ```plastron JSON block — [{op:"cel",addr,formula|value},
//     {op:"msg",text}] — the shape the bot is told to emit.
type ChatCmd = { op: "cel"; addr: string; formula?: string; value?: unknown } | { op: "msg"; text: string };

// appendMsg — push a {from,text} onto the chat's message block (<seg>.C1, the
// history) and repaint. The DEFAULT for plain text and the carrier for msg
// commands. A plain setValue of the grown array — the graph owns the log.
const appendMsg = async (state: State, seg: string, m: Msg): Promise<void> => {
  const key = `${seg}.C1`;
  const cur = state.cels.get(key)?.v;
  const log = Array.isArray(cur) ? [...cur as Msg[], m] : [m];
  await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, key, log));
  await Promise.resolve((resolveFn(state, "drain") as Fn)(state, "dom.paint"));
};

const AGENT_PREAMBLE =
  "You are in a plastron spreadsheet chat. You MAY edit THIS chat's worksheet cels (and ONLY this chat's — writes elsewhere are refused). To change a cell, put a line `set <RANGE> = <value-or-formula>` (RANGE is A1 or A1:B2; a body starting with ( or = is an s-expression formula, e.g. set E1 = (* 6 7)). Or end with a fenced ```plastron block holding a JSON array of {\"op\":\"cel\",\"addr\":\"E1\",\"formula\":\"(+ 1 2)\"} / {\"op\":\"cel\",\"addr\":\"E1\",\"value\":42} / {\"op\":\"msg\",\"text\":\"…\"}. Use a command ONLY when you actually want to change something; otherwise just reply in prose. A cell holding a dom(…)/canvas(…) formula renders as live UI in place.";

// CATALOG_VERBS — the curated set of editing verbs surfaced to the bot. Each
// entry is a cel key; the prose is the cel's metadata.description, read from the
// live registry (state.cels) so the catalog stays in sync with the seeds and
// only lists verbs the host actually mounted. Grouped: dom builders, the canvas
// drawing ops, and the cel-creating verbs + the json reader.
const CATALOG_VERBS = [
  "dom", "style", "on", "attr", "img",
  "canvas", "rect", "text", "line", "circle", "wedge", "orbit",
  "cels", "cel", "def", "json",
] as const;

// buildCatalog — assemble the "functions you can use" section from the registry.
// Skips any verb the host didn't load (description undefined). The description
// prose is emitted VERBATIM so the bot reads the same usage notes the grid shows.
const buildCatalog = (state: State): string => {
  const lines: string[] = [];
  for (const key of CATALOG_VERBS) {
    const d = state.cels.get(key)?.metadata?.description;
    if (typeof d === "string" && d.trim()) lines.push(`${key}: ${d.trim()}`);
  }
  return lines.length ? "Functions you can use (call them in formulas):\n" + lines.join("\n") : "";
};

// buildCelState — a compact listing of the chat's OWN sheet, scoped strictly to
// the `seg.` prefix so sealed secrets.* and other windows' cels never leak. Each
// cel shows its source: a FormulaCel by its f (=<formula>), a ValueCel by its v.
const buildCelState = (state: State, seg: string): string => {
  const prefix = seg + ".";
  const lines: string[] = [];
  for (const [key, cel] of state.cels) {
    if (!key.startsWith(prefix)) continue;
    const c = cel as { f?: unknown; v?: unknown };
    const src = c.f != null ? "=" + String(c.f)
      : c.v === undefined || c.v === "" ? "(empty)"
      : typeof c.v === "object" ? JSON.stringify(c.v)
      : String(c.v);
    lines.push(`${key} = ${src}`);
  }
  lines.sort();
  return lines.length ? "Current cells (this is the sheet you can modify):\n" + lines.join("\n") : "";
};

// buildAgentPrompt — the per-turn system prompt: the preamble (rules + command
// syntax), the verb CATALOG (from the registry's descriptions), and the chat's
// live cel STATE. Built fresh each send so the bot sees the sheet as it stands.
const buildAgentPrompt = (state: State, seg: string): string =>
  [AGENT_PREAMBLE, buildCatalog(state), buildCelState(state, seg)].filter(Boolean).join("\n\n") + "\n\n";

// expand an A1 RANGE to the sheet's dot-keyed cel keys (clients.E1, …) — the
// boot grid keys cells <seg>.<A1>, not comma-coords, so this mirrors that
// addressing rather than rangeToKeys' comma form. A bare range stays in the
// chat's own sheet; an explicit `<seg>!<RANGE>` targets another segment — which
// the confined accessor then DENIES (the sealed-closure proof, not mere syntax).
const colA = (n: number): string => { let s = "", x = n; while (x > 0) { s = String.fromCharCode(65 + (x - 1) % 26) + s; x = Math.floor((x - 1) / 26); } return s; };
const expandRange = (chatSeg: string, range: string): { seg: string; keys: string[] } => {
  const bang = range.indexOf("!");
  const seg = bang >= 0 ? range.slice(0, bang) : chatSeg;
  const body = bang >= 0 ? range.slice(bang + 1) : range;
  const [a, b] = body.split(":");
  const lo = parseA1(String(a ?? "").trim()); if (!lo) return { seg, keys: [] };
  const hi = b ? parseA1(String(b).trim()) : lo; if (!hi) return { seg, keys: [] };
  const [r0, c0] = lo, [r1, c1] = hi;
  const keys: string[] = [];
  for (let r = Math.min(r0!, r1!); r <= Math.max(r0!, r1!); r++)
    for (let c = Math.min(c0!, c1!); c <= Math.max(c0!, c1!); c++) keys.push(`${seg}.${colA(c)}${r}`);
  return { seg, keys };
};

// parse a message body into commands + the leftover prose (which appends as a
// message). Recognizes `set <RANGE> = <body>` lines and one fenced block.
const parseChatCommands = (body: string): { commands: ChatCmd[]; prose: string } => {
  const commands: ChatCmd[] = [];
  let rest = body;
  const fence = rest.match(/```(?:plastron|cmds|json)?\s*(\[[\s\S]*?\])\s*```/);
  if (fence) {
    rest = rest.replace(fence[0], "").trim();
    try {
      const j = JSON.parse(fence[1]!);
      if (Array.isArray(j)) for (const c of j) {
        const o = c as { op?: string; addr?: string; key?: string; formula?: string; value?: unknown; text?: string };
        if (o.op === "msg" && o.text != null) commands.push({ op: "msg", text: String(o.text) });
        else if (o.op === "cel" && (o.addr || o.key)) commands.push({ op: "cel", addr: String(o.addr ?? o.key), formula: o.formula != null ? String(o.formula) : undefined, value: o.value });
      }
    } catch { /* malformed block → ignored, prose still appends */ }
  }
  const kept: string[] = [];
  for (const line of rest.split("\n")) {
    const m = /^\s*set\s+((?:[\w.-]+!)?[A-Za-z]+[0-9]+(?::[A-Za-z]+[0-9]+)?)\s*=\s*(.*)$/.exec(line);
    if (m) {
      const addr = m[1]!, rhs = m[2]!.trim();
      const isFormula = /^[(=]/.test(rhs);
      commands.push({ op: "cel", addr, formula: isFormula ? rhs.replace(/^=/, "") : undefined, value: isFormula ? undefined : rhs });
    } else kept.push(line);
  }
  return { commands, prose: kept.join("\n").trim() };
};

// runChatCommands — execute parsed commands CONFINED to the chat's worksheet.
// Every setCel runs under withAccessor(state, seg, …); a target outside the
// segment's set-policy is refused by the kernel (canSet false → throw / no
// write), so a command can't escape the closure. Returns a per-command log.
const runChatCommands: Fn = (async (state: State, seg: unknown, commands: unknown): Promise<string[]> => {
  const chatSeg = String(seg ?? SHEET);
  const setCel = resolveFn(state, "setCel") as Fn;
  const applied: string[] = [];
  for (const c of (Array.isArray(commands) ? commands : []) as ChatCmd[]) {
    if (c.op === "msg") { await appendMsg(state, chatSeg, { from: chatSeg, text: c.text }); applied.push("msg"); continue; }
    if (c.op === "cel") {
      const { seg: targetSeg, keys } = expandRange(chatSeg, c.addr);
      if (!keys.length) { applied.push(`bad range ${c.addr}`); continue; }
      for (const key of keys) {
        const name = key.slice(targetSeg.length + 1);
        const spec = c.formula != null
          ? { celType: "FormulaCel", f: c.formula, metadata: { key, segment: targetSeg, name, parser: "f" } }
          : { celType: "ValueCel", v: c.value, metadata: { key, segment: targetSeg, name } };
        try {
          // ALWAYS confined to the CHAT's segment — a foreign targetSeg is
          // refused by canSet (Layer 1), proving the sealed closure.
          await withAccessor(state, chatSeg, () => Promise.resolve(setCel(state, key, spec)));
          applied.push(targetSeg === chatSeg ? name : `${targetSeg}.${name}`);
        } catch { applied.push(`#DENIED ${targetSeg}.${name}`); }
      }
    }
  }
  return applied;
}) as Fn;

// chat.cellinput — the entry input's `input` handler: stash the live typed text
// in the clients.D1 buffer cel (read off the event target), so the input is an
// uncontrolled field authorable purely with (on "input" "chat.cellinput") in a
// dom() formula — no {set}/extract binding that the on-verb can't express.
const chatCellInput: Fn = (async (state: State, _p: unknown, event?: { target?: { value?: unknown } }): Promise<void> => {
  await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, ENTRY, String(event?.target?.value ?? "")));
}) as Fn;

const firstClient = (state: State): ClientHandle | undefined => {
  for (const k of ["clients.A1", "clients.A2"]) { const v = state.cels.get(k)?.v as ClientHandle | undefined; if (v && v.__client === true && v.status === "ready") return v; }
  return undefined;
};
// chat.cellsend — the agentic send. The typed text is parsed: COMMANDS (set
// lines / a fenced block) edit the chat's cels CONFINED to its closure; the
// leftover PROSE appends as {from:'me'}. Then the bot is asked with AGENT_PROMPT
// prepended, ITS reply is parsed the same way (commands run confined, prose
// appends). So both the user and the bot can edit the chat's cels — and nothing
// outside the chat's segment.
const chatCellSend: Fn = (async (state: State): Promise<void> => {
  const text = String(state.cels.get(ENTRY)?.v ?? "").trim();
  if (!text) return;
  await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, ENTRY, ""));
  const run = runChatCommands as unknown as (s: State, seg: unknown, cmds: unknown) => Promise<string[]>;
  // user message → confined commands + appended prose
  const { commands: userCmds, prose: userProse } = parseChatCommands(text);
  if (userProse) await appendMsg(state, SHEET, { from: "me", text: userProse });
  else if (!userCmds.length) await appendMsg(state, SHEET, { from: "me", text });   // pure whitespace-less edge
  if (userCmds.length) { const a = await run(state, SHEET, userCmds); if (a.length) await appendMsg(state, SHEET, { from: "system", text: "✎ " + a.join("; ") }); }
  // ask the bot — confined the same way
  const client = firstClient(state);
  if (!client) { await appendMsg(state, SHEET, { from: "system", text: "(no armed client — set an api key in secrets)" }); return; }
  let reply: string;
  const prompt = buildAgentPrompt(state, SHEET) + (userProse || text);
  try { reply = String(await (resolveFn(state, "client.send") as Fn)(client, prompt)); }
  catch (e) { reply = "⚠ " + String((e as { message?: unknown })?.message ?? e); }
  const { commands: botCmds, prose: botProse } = parseChatCommands(reply);
  await appendMsg(state, SHEET, { from: client.provider, text: botProse || reply });
  if (botCmds.length) { const a = await run(state, SHEET, botCmds); if (a.length) await appendMsg(state, SHEET, { from: "system", text: "✎ " + a.join("; ") }); }
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
  ["chat.cellrun", runChatCommands],
  ["clientsheet", clientsheetFn],
]));
