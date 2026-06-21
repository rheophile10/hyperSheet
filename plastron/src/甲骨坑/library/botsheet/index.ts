import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import { el as makeEl, text as T } from "../dom/index.js";
import seed from "./甲骨.json" with { type: "json" };

// botsheet — an "ask a bot" whose conversation surface is a cel GRID inside a
// jail() (sandboxed iframe, its own kernel). The PARENT holds the keys + mediates
// the LLM call (jail.serve); the jail only round-trips the grid via =jailask. The
// bot replies by writing formulas/values into cells (which render live in the
// jail). Keys never cross in; the consent blacklist stays parent-side.

type V = unknown;
const el = makeEl as unknown as (t: string, a?: Record<string, unknown>, c?: V[], e?: Record<string, unknown>) => V;
const setV = (state: State, k: string, v: unknown): Promise<unknown> => Promise.resolve((resolveFn(state, "setValue") as Fn)(state, k, v));

// ── PARENT: =botsheet([provider]) opens a window holding the jailed grid ──────
const botsheetFn: Fn = ((provider: unknown): unknown => {
  const p = String(provider ?? "grok");
  // the seed runs in the jail's OWN kernel. jail() rewrites " → ' so write the
  // seed with ' delimiters already to survive the round-trip. cels() makes the
  // editable grid; botbar() seeds bot.provider/bot.status + the Send bar.
  const seedF = `(doc (cels 14 8 'bot') (botbar '${p}'))`;
  return { genesis: true, layer: "win.bot", cels: {
    "win.bot.state":   { celType: "ValueCel", v: { ref: "win.bot.state", x: 70, y: 50, w: 720, h: 540, z: 1, min: 0, max: 0, closed: 0, title: `🤖 ask a bot (${p})` }, metadata: { name: "state" } },
    "win.bot.content": { celType: "FormulaCel", f: `(jail "${seedF}")`, metadata: { name: "content", parser: "f" } },
    "win.bot.frame":   { celType: "FormulaCel", f: `(mount ".origin" (winframe win.bot.state win.active win.bot.content))`, metadata: { name: "frame", parser: "f", channel: ["dom.paint"] } },
  } };
}) as Fn;

// ── JAIL: botbar(provider) — seeds bot.provider/bot.status + mounts the Send bar ──
const botbarFn: Fn = ((provider: unknown): unknown => {
  const p = String(provider ?? "grok");
  return { genesis: true, layer: "botbar", cels: {
    "bot.provider": { celType: "ValueCel", v: p, metadata: { key: "bot.provider", segment: "botbar", name: "provider" } },
    "bot.status":   { celType: "ValueCel", v: "", metadata: { key: "bot.status", segment: "botbar", name: "status" } },
    "botbar.view":  { celType: "FormulaCel", f: `(mount ".origin" (botsendbar "${p}" bot.status))`, metadata: { key: "botbar.view", segment: "botbar", name: "view", parser: "f", channel: ["dom.paint"] } },
  } };
}) as Fn;

// ── JAIL: the floating Send bar (the grid itself is the cels(…) sheet) ────────
const botSendBarFn: Fn = ((provider: unknown, status: unknown): V =>
  el("div", { style: "position:fixed;bottom:1rem;right:1rem;z-index:99;display:flex;gap:.6rem;align-items:center;font:13px ui-sans-serif,system-ui" }, [
    el("span", { style: "opacity:.6" }, [T(String(status ?? "") || `🤖 ${String(provider ?? "bot")}`)]),
    el("button", { style: "padding:.55rem 1.1rem;border:0;border-radius:.55rem;background:#4a90d9;color:white;cursor:pointer;font-weight:600" }, [T("▶ Send")], { pointerdown: { dispatch: "winx.stop" }, click: { dispatch: "bot.send" } }),
  ])) as Fn;

// ── JAIL: bot.send — serialize the grid → jailask (parent mediates the LLM) →
// parse `set ADDR = …` lines → write them into the bot.* cells (render live) ──
const botSendFn: Fn = (async (state: State): Promise<void> => {
  const provider = String(state.cels.get("bot.provider")?.v ?? "grok");
  const lines: string[] = [];
  for (const [k, c] of state.cels) {
    if (!k.startsWith("bot.") || !/[A-Za-z]+\d+$/.test(k)) continue;
    const cc = c as { f?: unknown; v?: unknown };
    if (cc.f != null && cc.f !== "") lines.push(`${k.slice(4)} = =${String(cc.f)}`);
    else if (cc.v !== "" && cc.v != null) lines.push(`${k.slice(4)} = ${typeof cc.v === "object" ? JSON.stringify(cc.v) : String(cc.v)}`);
  }
  const grid = lines.length ? lines.sort().join("\n") : "(the grid is empty)";
  await setV(state, "bot.status", "…thinking");
  let reply: string;
  try {
    reply = String(await (resolveFn(state, "jailask") as Fn)({
      provider,
      grid: "This is the current grid (cell = value-or-=formula):\n" + grid + "\n\nReply, and write any cells you want with `set ADDR = …` lines.",
    }));
  } catch (e) { reply = "⚠ " + String((e as { message?: unknown })?.message ?? e); }
  // apply the bot's cell-writes
  let applied = 0;
  const setCel = resolveFn(state, "setCel") as Fn;
  for (const line of reply.split("\n")) {
    const m = /^\s*set\s+([A-Za-z]+\d+)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const addr = m[1]!, body = m[2]!.trim(), isF = /^[(=]/.test(body), key = `bot.${addr}`;
    const spec = isF
      ? { celType: "FormulaCel", f: body.replace(/^=/, ""), metadata: { key, segment: "bot", name: addr, parser: "infix" } }
      : { celType: "ValueCel", v: body, metadata: { key, segment: "bot", name: addr } };
    try { await Promise.resolve(setCel(state, key, spec)); applied++; } catch { /* skip */ }
  }
  const prose = reply.split("\n").filter((l) => !/^\s*set\s+[A-Za-z]+\d+\s*=/.test(l)).join(" ").trim();
  await setV(state, "bot.status", applied ? `✎ wrote ${applied} cell(s)` : (prose.slice(0, 90) || "(no changes)"));
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
}) as Fn;

export const name = "botsheet" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["botsheet", botsheetFn],
  ["botbar", botbarFn],
  ["botsendbar", botSendBarFn],
  ["bot.send", botSendFn],
]));
