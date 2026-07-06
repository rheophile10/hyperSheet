import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import { dom, attr, on } from "../dom/utils/vocab.js";
import { sbConfig } from "../supabase/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// grok — the LLM-in-a-sheet bridge (grok-chat-bots.md).
//
// Formulas mint the client (=grokconfig), formulas mint the bots (=addbot →
// genesis: a grok.roster.<handle> cel that dehydrates with the document), and
// the chat pane (=chatcard → grok.ui) is a VIEW over the grok.transcript cel —
// a list of {role, bot?, text, ts?} message dicts (the collections hub form),
// so the thread renders reactively, archives, and is inspectable with
// =grok.transcript[-1].text.
//
// Bots SEE the workbook (grok.workbook-context walks the active wbframe's
// sheets + views) and ACT on it: replies may carry xAI tool calls
// (read_cells / write_cell / evaluate_formula / vocabulary) which the CLIENT
// applies through the user's own commit path (typed-entry sniff → setCel) —
// no privileged mutation surface — appending a receipt dict to the transcript
// for every application. The xAI key is NEVER in the browser: grok.ask goes
// through supabase.invoke → the `grok` edge function (user JWT), grok.fetch
// through a full .env-seeded URL (grok.url) with the same JWT.
// ============================================================================

const R = (state: State, k: string, ...a: unknown[]): unknown => (resolveFn(state, k) as Fn)(...a);

const CONTROL = (seg: string) => new Set([`${seg}.crdt`, `${seg}.writers`, `${seg}.hash`, `${seg}.datakey`]);

// the shared formula primer (the bot's persona is appended). {seg} is the sheet.
const primer = (seg: string): string =>
  `You are a plastron spreadsheet assistant. Reply with EXACTLY ONE plastron formula and NOTHING else — no prose, no backticks, no code fences.\n` +
  `A formula starts with "=". Syntax is Excel-like infix:\n` +
  `  arithmetic:  =${seg}.A1*2 + ${seg}.B1\n` +
  `  functions:   =SUM(${seg}!A1:A10)   =IF(${seg}.A1>0,"yes","no")   =CONCATENATE(${seg}.A1," ",${seg}.B1)\n` +
  `  cell refs use the sheet's segment prefix — cells in THIS sheet are named ${seg}.A1, ${seg}.B2, …; a RANGE uses the bang form ${seg}!A1:A10 (never dotted ends).\n` +
  `  string literals use double quotes: ="hello".\n` +
  `If the request is a question rather than a calculation, answer it as a formula whose value is the answer (e.g. ="…" for text). Return only the formula.`;

// the CHAT primer — conversational, tool-aware (grok.send / the chat pane).
const chatPrimer = (persona?: string): string =>
  `You are a plastron spreadsheet assistant chatting inside a live workbook. Be concise and concrete.\n` +
  `You can ACT on the workbook with the provided tools:\n` +
  `  read_cells(range) — read a rectangle of values, e.g. "sheet1.A1:C9" (or one key, "sheet1.B2").\n` +
  `  write_cell(key, content) — commit content into a cell exactly as a user would type it: "=SUM(A1:A9)" is a formula, "42" a number, anything else text. Each write is receipted in the chat.\n` +
  `  evaluate_formula(source) — dry-run a formula in a scratch cel and see its value without touching any sheet.\n` +
  `  vocabulary(segment?) — discover the callable formula verbs (with descriptions + examples).\n` +
  `Formulas are Excel-like infix. Inside a cell, same-sheet refs are plain (A1, B2) and a same-sheet range is A1:C4; a cell in ANOTHER sheet is sheet2.A1 and a range there is sheet2!A1:C4 (the bang form — range ends are never dotted). String literals use double quotes.\n` +
  `When the user asks for a change, apply it with write_cell, then confirm in one short sentence.` +
  (persona ? `\n\nPersona: ${persona}` : "");

// grok.context(state, seg) — the segment's SOURCE cells as plain lines (a formula
// shows its TEXT, a value shows its JSON). Excludes the sync control cels. Capped.
const contextFn: Fn = ((state: State, segArg?: unknown): string => {
  const seg = String(segArg ?? ""); if (!seg) return "";
  const prefix = `${seg}.`, control = CONTROL(seg), rows: string[] = [];
  for (const [k, cel] of state.cels) {
    if (!k.startsWith(prefix) || control.has(k) || rows.length >= 300) continue;
    if (cel.celType === "FormulaCel") rows.push(`${k}: ${String((cel as { f?: string }).f ?? "")}`);
    else if (cel.celType === "ValueCel") { const v = cel.v; if (v !== "" && v != null) rows.push(`${k} = ${JSON.stringify(v)}`); }
  }
  return rows.sort().join("\n").slice(0, 8000);
}) as Fn;

// ── grok.workbook-context — the sheetapp.context equivalent, from OUTSIDE ─────
// sheetapp (library tier): walk the ACTIVE workbook's window state (the wbframe
// shape: win.<wb>.state = { sheets:[{ref:"win.<wb>.view.<seg>", title}], views:
// [{ref, title}] }), emit every sheet's dims + source cells and every view's
// formula as capped plain text. This is the whole-workbook context the chat
// bots see (grok.context stays the one-segment form the 🔮 bar uses).
interface Tab { ref?: string; title?: string }
interface WbLike { title?: string; sheets?: Tab[]; views?: Tab[] }
const isWorkbookState = (v: unknown): v is WbLike =>
  !!v && typeof v === "object" && Array.isArray((v as WbLike).sheets);
const activeWorkbookRef = (state: State): string => {
  const act = String(state.cels.get("win.active")?.v ?? "");
  if (act && isWorkbookState(state.cels.get(act)?.v)) return act;
  for (const [k, c] of state.cels) if (k.endsWith(".state") && isWorkbookState(c.v)) return k;
  return "";
};
const segOfTab = (t: Tab): string => {
  const r = String(t.ref ?? "");
  return r.includes(".view.") ? r.split(".view.").slice(1).join(".view.") : String(t.title ?? "");
};
const workbookContextFn: Fn = ((state: State, wbArg?: unknown): string => {
  let ref = String(wbArg ?? "");
  if (!ref) ref = activeWorkbookRef(state);
  else if (!ref.startsWith("win.")) ref = `win.${ref}.state`;
  const st = state.cels.get(ref)?.v;
  if (!isWorkbookState(st)) return "";
  const lines: string[] = [`workbook ${ref}${st.title ? ` — "${st.title}"` : ""}`];
  for (const tab of st.sheets ?? []) {
    const seg = segOfTab(tab); if (!seg) continue;
    const dims = state.cels.get(`${seg}.dims`)?.v as { rows?: unknown; cols?: unknown } | undefined;
    lines.push("", `## sheet ${tab.title ?? seg} (segment ${seg}${dims ? `, ${Number(dims.rows) || "?"}×${Number(dims.cols) || "?"}` : ""})`);
    const src = String(contextFn(state, seg)).slice(0, 6000);
    lines.push(src || "(empty)");
  }
  for (const tab of st.views ?? []) {
    const c = tab.ref ? state.cels.get(tab.ref) : undefined;
    const f = (c as { f?: string } | undefined)?.f;
    lines.push("", `## view ${tab.title ?? tab.ref} (${tab.ref})`,
      f !== undefined ? String(f) : (JSON.stringify(c?.v ?? null) ?? "null").slice(0, 500));
  }
  return lines.join("\n").slice(0, 16000);
}) as Fn;

// ── the bestiary: grok.bots (seeded dict) + grok.roster.* (formula-minted) ───
interface Bot { name?: string; persona?: string; model?: string }
const ROSTER = "grok.roster.";
const botsOf = (state: State): Record<string, Bot> => {
  const v = state.cels.get("grok.bots")?.v;
  const out: Record<string, Bot> = (v && typeof v === "object" && !Array.isArray(v)) ? { ...(v as Record<string, Bot>) } : {};
  for (const [k, c] of state.cels) {
    if (!k.startsWith(ROSTER)) continue;
    const b = c.v;
    if (b && typeof b === "object" && !Array.isArray(b)) out[k.slice(ROSTER.length)] = b as Bot;
  }
  return out;
};
const slug = (s: unknown): string => String(s ?? "").trim().toLowerCase().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");

// =addbot(name, persona?, model?) — GENESIS: mint the bot as a grok.roster.<handle>
// cel owned by the authoring formula (bots are document recipe: delete the formula
// and the sweep retires the bot; it dehydrates with the sheet it was minted from).
const addbotFn: Fn = ((name?: unknown, persona?: unknown, model?: unknown): unknown => {
  const handle = slug(name);
  if (!handle) return { error: "addbot: =addbot(\"advisor\", \"terse formula expert\", \"grok-4\")" };
  const key = `${ROSTER}${handle}`;
  return { genesis: true, cels: { [key]: {
    celType: "ValueCel", reset: true,
    v: { name: String(name), persona: String(persona ?? ""), model: String(model ?? "") },
    metadata: { name: key.slice(key.indexOf(".") + 1), description: `bot "${String(name)}" — minted by =addbot; a {name, persona, model} dict merged into the bestiary (grok.bots + grok.roster.*).` },
  } } };
}) as Fn;

// grok.addbot(state, name, persona?, model?) — the DISPATCHED twin (card UI /
// headless): MERGE the bot into the grok.bots dict (the cel chat formulas
// already reference, so the new chip appears reactively) rather than minting a
// roster cel — the roster is the formula-owned (=addbot) form. Returns the handle.
const addbotHandlerFn: Fn = (async (state: State, name?: unknown, persona?: unknown, model?: unknown): Promise<string> => {
  const handle = slug(name);
  if (!handle) return "";
  const cur = state.cels.get("grok.bots")?.v;
  const bots = (cur && typeof cur === "object" && !Array.isArray(cur)) ? { ...(cur as Record<string, Bot>) } : {};
  bots[handle] = { name: String(name), persona: String(persona ?? ""), model: String(model ?? "") };
  await (resolveFn(state, "setValue") as Fn)(state, "grok.bots", bots);
  await repaint(state);
  return handle;
}) as Fn;

// ── the transcript cel — a LIST OF DICTS [{role, bot?, text, ts?}] ───────────
interface Msg { role: string; bot?: string; text?: string; ts?: number; tool?: string; error?: boolean; human?: boolean; id?: unknown }
const transcriptOf = (state: State): Msg[] => {
  const v = state.cels.get("grok.transcript")?.v;
  return Array.isArray(v) ? v as Msg[] : [];
};
// append message dicts. grok.reply MIRRORS the same list so the already-shipped
// card formula (=grok.ui(…, grok.reply)) re-renders the thread reactively without
// an origin edit; once the card formula passes grok.transcript the mirror can go.
const pushTranscript = async (state: State, msgs: Msg[]): Promise<Msg[]> => {
  const next = [...transcriptOf(state), ...msgs];
  await (resolveFn(state, "setValueBatch") as Fn)(state, [["grok.transcript", next], ["grok.reply", next]]);
  return next;
};

// ── the tool surface (grok-chat-bots.md: meta-tools, not verbs-as-tools) ─────
const TOOL_DEFS = [
  { type: "function", function: { name: "read_cells", description: "Read a rectangle of cells (or one cell). Returns 'key = value' lines; a formula cell also shows its source. Range: 'sheet1.A1:C9', 'sheet1.A1:sheet1.C9', or one key 'sheet1.B2'.", parameters: { type: "object", properties: { range: { type: "string", description: "e.g. sheet1.A1:C9" } }, required: ["range"] } } },
  { type: "function", function: { name: "write_cell", description: "Commit content into a cell THROUGH THE USER'S COMMIT PATH (typed-entry sniff: '=' infix formula, '(' s-expression, '{'/'[' JSON, numeric string a number, anything else text). Returns the cell's resulting value.", parameters: { type: "object", properties: { key: { type: "string", description: "e.g. sheet1.B2" }, content: { type: "string", description: "exactly what a user would type" } }, required: ["key", "content"] } } },
  { type: "function", function: { name: "evaluate_formula", description: "Dry-run: commit a formula to the grok.scratch cel and return its computed value. Never touches a sheet.", parameters: { type: "object", properties: { source: { type: "string", description: "e.g. =SUM(sheet1.A1:sheet1.A9)" } }, required: ["source"] } } },
  { type: "function", function: { name: "vocabulary", description: "The callable formula vocabulary as 'key — description' lines (with examples), optionally one segment's. Use it to discover verbs before writing formulas.", parameters: { type: "object", properties: { segment: { type: "string", description: "optional segment filter, e.g. 'charts'" } } } } },
];

// a LOCAL minimal typed-entry sniff — the same leading-char rules a keyboard
// commit gets in origin (grok is a library; importing the origin application
// would invert the tier DAG, so the tiny rule set is reimplemented here).
const sniff = (src: string): { celType: string; f?: string; v?: unknown; parser?: string } => {
  const t = String(src ?? "").trim();
  if (t === "") return { celType: "ValueCel", v: "" };
  if (t.startsWith("=")) return { celType: "FormulaCel", f: t, parser: "infix" };
  if (t.startsWith("(")) return { celType: "FormulaCel", f: t, parser: "f" };
  if (t.startsWith("{") || t.startsWith("[")) { try { return { celType: "ValueCel", v: JSON.parse(t) }; } catch { /* not JSON — fall through to text */ } }
  const n = Number(t);
  return { celType: "ValueCel", v: !Number.isNaN(n) ? n : src };
};

// keys a bot must not write: session/auth/key material, window chrome, and the
// grok segment's OWN state — a bot writes SHEET cels (sheet1.B2), never grok.*.
// Omitting `grok.` let a prompt-injected bot write grok.url and exfiltrate the
// user's JWT on the next send (the direct-URL path Bearer-attaches it), plus
// spoof grok.transcript / redirect grok.room. (audit 2026-07-06)
// grok.scratch is the ONE allowed grok.* target — evaluate_formula's dry-run
// cel, a throwaway value, never a JWT/transcript/config surface.
const DENY_WRITE = /^(session|sb|keystore|seal|win)\.|^grok\.(?!scratch$)/;
const isControlKey = (key: string): boolean => /\.(crdt|writers|hash|datakey)$/.test(key);

// commit `content` into `key` the way origin.commit does for a keyboard user:
// sniff → whole-cel setCel (recompile tier), metadata stamps carried forward,
// sparse birth inherits the sheet's generator stamps from `<seg>.dims`.
const commitCell = async (state: State, keyArg: unknown, contentArg: unknown): Promise<{ ok: boolean; value?: unknown; error?: string }> => {
  const key = String(keyArg ?? "").trim();
  const content = String(contentArg ?? "");
  if (!/^[A-Za-z_][\w-]*(\.[\w.-]+)$/.test(key)) return { ok: false, error: `write_cell: "${key}" is not a cel key (want e.g. sheet1.B2)` };
  if (DENY_WRITE.test(key) || isControlKey(key)) return { ok: false, error: `write_cell: "${key}" is off limits` };
  if (state.cels.get(key)?.locked) return { ok: false, error: `write_cell: "${key}" is locked` };
  const spec = sniff(content);
  const dot = key.indexOf(".");
  const prior = state.cels.get(key)?.metadata as { segment?: string; name?: string; generatedBy?: string; definedBy?: string; origin?: string } | undefined;
  const md: Record<string, unknown> = {
    key, segment: prior?.segment ?? key.slice(0, dot), name: prior?.name ?? key.slice(dot + 1),
  };
  if (prior?.generatedBy) md.generatedBy = prior.generatedBy;
  if (prior?.definedBy) md.definedBy = prior.definedBy;
  if (prior?.origin) md.origin = prior.origin;
  if (spec.parser) md.parser = spec.parser;
  // sparse birth into a sheet address: join the sheet's segment + inherit its
  // generator stamps (from `<seg>.dims`) so the sweep can still reclaim it.
  if (!prior && /^[A-Z]+\d+$/.test(key.slice(dot + 1))) {
    const dimsMd = state.cels.get(`${key.slice(0, dot)}.dims`)?.metadata as { generatedBy?: string; definedBy?: string; origin?: string } | undefined;
    if (dimsMd?.generatedBy) md.generatedBy = dimsMd.generatedBy;
    if (dimsMd?.definedBy) md.definedBy = dimsMd.definedBy;
    if (dimsMd?.origin) md.origin = dimsMd.origin;
  }
  try {
    await (resolveFn(state, "setCel") as Fn)(state, key, {
      celType: spec.celType,
      ...(spec.f !== undefined ? { f: spec.f } : {}),
      ...(spec.v !== undefined ? { v: spec.v } : {}),
      metadata: md,
    });
    await (resolveFn(state, "runCycle") as Fn)(state);
  } catch (e) {
    return { ok: false, error: `write_cell: ${String((e as { message?: unknown })?.message ?? e)}` };
  }
  return { ok: true, value: state.cels.get(key)?.v };
};

// read_cells — expand "seg.A1:C9" (or one key) into 'key = value' lines. Sparse
// addresses are skipped (they don't exist); formula cells show source AND value.
const colIdx = (s: string): number => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
const colLetter = (n: number): string => { let s = "", x = n; while (x > 0) { s = String.fromCharCode(65 + (x - 1) % 26) + s; x = Math.floor((x - 1) / 26); } return s; };
const cellLine = (state: State, k: string): string | undefined => {
  const c = state.cels.get(k); if (!c) return undefined;
  const f = (c as { f?: string }).f;
  return f !== undefined ? `${k}: ${f} = ${JSON.stringify(c.v)}` : `${k} = ${JSON.stringify(c.v)}`;
};
const readCellsTool = (state: State, rangeArg: unknown): string => {
  const r = String(rangeArg ?? "").trim();
  const m = /^([A-Za-z_][\w-]*)\.([A-Z]+)(\d+)(?::(?:([A-Za-z_][\w-]*)\.)?([A-Z]+)(\d+))?$/.exec(r);
  if (!m) { const one = cellLine(state, r); return one ?? `(read_cells: "${r}" — want sheet1.A1:C9, sheet1.B2, or a cel key)`; }
  const [, seg, c1, r1, seg2, c2, r2] = m;
  if (!c2 || !r2) return cellLine(state, r) ?? `(${r} is empty)`;
  if (seg2 && seg2 !== seg) return `(read_cells: a range stays within ONE sheet — got ${seg} and ${seg2})`;
  const cA = Math.min(colIdx(c1!), colIdx(c2)), cB = Math.max(colIdx(c1!), colIdx(c2));
  const rA = Math.min(Number(r1), Number(r2)), rB = Math.max(Number(r1), Number(r2));
  if ((cB - cA + 1) * (rB - rA + 1) > 400) return "(read_cells: range too large — cap 400 cells)";
  const lines: string[] = [];
  for (let row = rA; row <= rB; row++) for (let col = cA; col <= cB; col++) {
    const line = cellLine(state, `${seg}.${colLetter(col)}${row}`);
    if (line) lines.push(line);
  }
  return lines.length ? lines.join("\n") : `(${r} is empty)`;
};

// vocabulary — a self-contained catalog built from state.cels metadata (segment +
// key + description one-liner + example). The same data =help renders; grok
// (library) can't import origin's vocabText without inverting the tier DAG.
const vocabCatalog = (state: State, segArg?: unknown): string => {
  const seg = String(segArg ?? "").trim();
  const bySeg = new Map<string, string[]>();
  for (const [k, c] of state.cels) {
    const md = c.metadata as { segment?: string; description?: string; example?: string };
    if (seg && md.segment !== seg) continue;
    if (c.celType !== "LockedLambdaCel" && c.celType !== "EditableLambdaCel") continue;
    if (c.celType === "LockedLambdaCel" && (c as { _fn?: unknown })._fn === undefined) continue;
    const desc = String(md.description ?? "").split(/(?<=\.)\s/)[0] ?? "";
    const line = `  ${k}${desc ? ` — ${desc}` : ""}${md.example ? `\n      e.g. ${md.example}` : ""}`;
    const s = String(md.segment ?? "misc");
    (bySeg.get(s) ?? bySeg.set(s, []).get(s)!).push(line);
  }
  const out: string[] = [];
  for (const s of [...bySeg.keys()].sort()) out.push(`[${s}]`, ...bySeg.get(s)!.sort(), "");
  return out.join("\n").slice(0, 8000) || (seg ? `(no vocabulary in segment "${seg}")` : "(no vocabulary)");
};

// grok.applytools(state, toolCalls) — apply a reply's tool calls and return the
// {role:"tool"} follow-up messages. Each application appends a RECEIPT dict to
// the transcript ("wrote sheet9.B2 := =SUM(A1:A9)"). Write-back doctrine: a
// checkpoint snapshot is taken before the first write when grok.snap is on
// (default) and the checkpoint segment is loaded.
interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: unknown } }
const applyToolCallsFn: Fn = (async (state: State, callsArg?: unknown): Promise<Array<{ role: string; tool_call_id: string; content: string }>> => {
  const calls = (Array.isArray(callsArg) ? callsArg : []) as ToolCall[];
  const out: Array<{ role: string; tool_call_id: string; content: string }> = [];
  if (!calls.length) return out;
  const writes = calls.some((c) => c.function?.name === "write_cell");
  if (writes && state.cels.get("grok.snap")?.v !== false) {
    const snap = resolveFn(state, "checkpoint.snapshot") as Fn | undefined;
    if (snap) await snap(state, "grok-pre-apply");
  }
  for (const c of calls) {
    const name = String(c.function?.name ?? "");
    let args: Record<string, unknown> = {};
    const raw = c.function?.arguments;
    try { args = typeof raw === "string" ? JSON.parse(raw || "{}") : ((raw ?? {}) as Record<string, unknown>); } catch { /* malformed args → {} */ }
    let content = "", receipt = "";
    if (name === "read_cells") {
      content = readCellsTool(state, args.range);
      receipt = `read ${String(args.range ?? "")}`;
    } else if (name === "write_cell") {
      const r = await commitCell(state, args.key, args.content);
      content = r.ok ? `wrote ${String(args.key)} := ${String(args.content)} — value now ${JSON.stringify(r.value)?.slice(0, 300)}` : String(r.error);
      receipt = r.ok ? `wrote ${String(args.key)} := ${String(args.content)}` : `✗ ${String(r.error)}`;
    } else if (name === "evaluate_formula") {
      const src = String(args.source ?? "");
      const r = await commitCell(state, "grok.scratch", src.trim().startsWith("=") || src.trim().startsWith("(") ? src : `=${src}`);
      content = r.ok ? (JSON.stringify(r.value)?.slice(0, 2000) ?? "null") : String(r.error);
      receipt = r.ok ? `evaluated ${src} → ${content.slice(0, 80)}` : `✗ ${String(r.error)}`;
    } else if (name === "vocabulary") {
      content = vocabCatalog(state, args.segment);
      receipt = `vocabulary(${String(args.segment ?? "")})`;
    } else {
      content = `(unknown tool "${name}")`;
      receipt = `✗ unknown tool "${name}"`;
    }
    await pushTranscript(state, [{ role: "receipt", tool: name, text: receipt, ts: Date.now() }]);
    out.push({ role: "tool", tool_call_id: String(c.id ?? ""), content: String(content).slice(0, 8000) });
  }
  return out;
}) as Fn;

// ── transport + the tool loop ────────────────────────────────────────────────
// One round-trip: POST {messages, tools?, model?} and normalize the answer to
// { reply, toolCalls } — accepting our proxy's {reply, tool_calls} OR a raw xAI
// {choices:[{message:{content, tool_calls}}]}. `via:"invoke"` pins the supabase
// edge-function proxy (grok.ask); "auto" prefers the grok.url .env variant.
interface ChatTurn { ok: boolean; reply?: string; toolCalls?: ToolCall[]; error?: string; detail?: unknown }
const sessName = (project: string): string => `supabase.${project}`;
const sessionAccess = (state: State, project: string): string | undefined => {
  if (!state.cels.get("session.handle")) return undefined;
  try {
    return ((resolveFn(state, "session.handle") as Fn)(state, sessName(project)) as { resolve(): string | undefined }).resolve();
  } catch { return undefined; }
};
const normalizeTurn = (data: unknown): ChatTurn => {
  const d = data as { reply?: unknown; tool_calls?: unknown; error?: unknown; choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }> };
  const msg = d?.choices?.[0]?.message;
  const reply = typeof d?.reply === "string" ? d.reply : (typeof msg?.content === "string" ? msg.content : undefined);
  const rawCalls = Array.isArray(d?.tool_calls) ? d.tool_calls : (Array.isArray(msg?.tool_calls) ? msg.tool_calls : undefined);
  if (reply === undefined && !rawCalls?.length) {
    return { ok: false, error: typeof d?.error === "string" ? d.error : "grok: no reply in response", detail: data };
  }
  return { ok: true, reply: reply ?? "", ...(rawCalls?.length ? { toolCalls: rawCalls as ToolCall[] } : {}) };
};
const postDirect = async (state: State, project: string, body: Record<string, unknown>): Promise<ChatTurn> => {
  const url = String(state.cels.get("grok.url")?.v ?? "").trim();
  if (!url) return { ok: false, error: "grok: set the grok.url cel (the chat-completion endpoint, from your .env)" };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const anonKey = sbConfig(state, project)?.anonKey ?? "";   // dict-first (sb.<p>), two-cel fallback
  if (anonKey) headers.apikey = anonKey;
  const token = sessionAccess(state, project);
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await globalThis.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await res.text();
    let data: unknown; try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) return { ok: false, error: `grok: HTTP ${res.status}`, detail: data };
    return normalizeTurn(data);
  } catch (e) {
    return { ok: false, error: `grok: ${String((e as { message?: unknown })?.message ?? e)}` };
  }
};
const postInvoke = async (state: State, project: string, body: Record<string, unknown>): Promise<ChatTurn> => {
  const r = await (R(state, "supabase.invoke", state, project, "grok", body) as Promise<unknown>);
  const err = (r as { error?: unknown } | undefined)?.error;
  if (typeof err === "string") return { ok: false, error: err, detail: (r as { detail?: unknown }).detail };
  return normalizeTurn(r);
};

const MAX_TOOL_ROUNDS = 4;
// chatLoop — send, apply tool calls through the commit path (receipted), feed the
// results back, repeat (capped). The CLIENT applies tools; the proxy stays a dumb
// forwarder (grok-chat-bots.md security model).
const chatLoop = async (state: State, project: string, body: Record<string, unknown>, via: "invoke" | "auto"): Promise<ChatTurn> => {
  const post = via === "invoke" ? postInvoke : (String(state.cels.get("grok.url")?.v ?? "").trim() ? postDirect : postInvoke);
  const messages = [...(body.messages as Array<Record<string, unknown>>)];
  for (let round = 0; ; round++) {
    const r = await post(state, project, { ...body, messages });
    if (!r.ok) return r;
    if (!r.toolCalls?.length || round >= MAX_TOOL_ROUNDS) return r;
    const toolMsgs = await (applyToolCallsFn(state, r.toolCalls) as Promise<Array<Record<string, unknown>>>);
    messages.push({ role: "assistant", content: r.reply ?? "", tool_calls: r.toolCalls }, ...toolMsgs);
    await repaint(state); // receipts land live between rounds (no-op headless)
  }
};

// grok.ask(state, seg, question, botHandle?) — assemble [system, context+question],
// invoke the proxy WITH the tool surface, run the tool loop, return
// { ok, reply, bot } or { ok:false, error }.
const askFn: Fn = (async (state: State, segArg?: unknown, questionArg?: unknown, botArg?: unknown): Promise<unknown> => {
  const seg = String(segArg ?? ""), question = String(questionArg ?? "").trim();
  if (!seg) return { ok: false, error: "grok.ask: seg required" };
  if (!question) return { ok: false, error: "grok.ask: ask a question (type it in the formula bar)" };
  const bots = botsOf(state);
  const handle = String(botArg ?? state.cels.get("grok.bot")?.v ?? "smith");
  const bot = bots[handle] ?? bots.smith ?? {};
  const project = String(state.cels.get("grok.project")?.v ?? "default");

  const sys = primer(seg) + (bot.persona ? `\n\nPersona: ${bot.persona}` : "");
  const context = contextFn(state, seg) as string;
  const messages = [
    { role: "system", content: sys },
    { role: "user", content: (context ? `Current sheet (sources):\n${context}\n\n` : "") + `Request: ${question}` },
  ];
  const body: Record<string, unknown> = { messages, tools: TOOL_DEFS };
  if (bot.model) body.model = bot.model;

  const r = await chatLoop(state, project, body, "invoke");
  if (r.ok && typeof r.reply === "string") return { ok: true, reply: r.reply, bot: handle };
  return { ok: false, error: r.error ?? "grok: no reply", ...(r.detail !== undefined ? { detail: r.detail } : {}) };
}) as Fn;

// ── direct-URL chat completion (the .env-driven fetch lambda) ────────────────
// grok.ask goes through supabase.invoke (URL built from sb.<project>.url + the
// function name). grok.fetch instead POSTs to a FULL URL held in the grok.url cel
// — seeded from a gitignored .env — so the endpoint is pure config, not code. It
// still authorises with the signed-in user's Supabase JWT (resolved at the effect
// site, never a cel), so the endpoint (an edge function) keeps the provider key
// server-side. Accepts our { reply } shape OR a raw xAI { choices:[{message}] }.
interface ChatResult { ok: boolean; reply?: string; bot?: string; error?: string; detail?: unknown }
const fetchFn: Fn = (async (state: State, questionArg?: unknown, botArg?: unknown): Promise<ChatResult> => {
  const question = String(questionArg ?? "").trim();
  if (!question) return { ok: false, error: "grok.fetch: ask a question" };
  const project = String(state.cels.get("grok.project")?.v ?? "default");
  const bots = botsOf(state);
  const handle = String(botArg ?? state.cels.get("grok.bot")?.v ?? "smith");
  const bot = bots[handle] ?? bots.smith ?? {};
  const sys = (bot.persona ? `${bot.persona}\n\n` : "") + "You are a helpful assistant. Answer concisely.";
  const body: Record<string, unknown> = { messages: [{ role: "system", content: sys }, { role: "user", content: question }] };
  if (bot.model) body.model = bot.model;
  const r = await postDirect(state, project, body);
  if (r.ok && typeof r.reply === "string") return { ok: true, reply: r.reply, bot: handle };
  return { ok: false, error: (r.error ?? "grok.fetch: no reply in response").replace(/^grok:/, "grok.fetch:"), ...(r.detail !== undefined ? { detail: r.detail } : {}) };
}) as Fn;

// ── login + chat card handlers (drive a dom-formula card) ────────────────────
// The card is one grok.ui formula (authored as the card's view cel); its inputs
// dispatch to grok.field (keystroke → cel), its buttons to grok.signin /
// grok.send / grok.pickbot / grok.signout (state-aware). The view formula
// REFERENCES the buffer cels (grok.status / grok.question / the transcript) so
// it re-renders reactively after each handler repaints. Formulas never touch
// state — only these handlers do (the state-arg-wall pattern, like sbdemo).
const repaint = async (state: State): Promise<void> => {
  const refresh = resolveFn(state, "view.refresh") as Fn | undefined; // host hook; absent headless
  if (refresh) await refresh(state);
  await (resolveFn(state, "runCycle") as Fn)(state);
  const drain = resolveFn(state, "drain") as Fn | undefined;
  // re-land any =view slots our writes re-fired (the ecs/sheets precedent:
  // handlers drain origin.effects themselves when the host provides it).
  if (drain && state.cels.get("origin.effects")) await drain(state, "origin.effects");
  if (drain) await drain(state, "dom.paint");
};

const fieldFn: Fn = (async (state: State, cellKey?: unknown, event?: unknown): Promise<void> => {
  const v = (event as { target?: { value?: unknown } } | undefined)?.target?.value ?? "";
  await (resolveFn(state, "setValue") as Fn)(state, String(cellKey ?? ""), v);
}) as Fn;

const signinFn: Fn = (async (state: State, projectArg?: unknown): Promise<string> => {
  const p = String(projectArg ?? state.cels.get("grok.project")?.v ?? "default");
  // BRIDGE: supabase-auth still reads the two-cel form; when the config is the
  // sb.<p> DICT cel, materialize the fallback cels from it before signing in
  // (dict wins — a dict edit re-syncs here). Drop once supabase-auth adopts sbConfig.
  const cfg = sbConfig(state, p);
  if (cfg && state.cels.get(`sb.${p}`)) await (resolveFn(state, "supabase.config") as Fn)(state, p, cfg.url, cfg.anonKey);
  const email = state.cels.get("grok.email")?.v;
  const password = state.cels.get("grok.password")?.v;
  const msg = await (resolveFn(state, "supabase.auth") as Fn)(state, "signin", p, { email, password });
  const a = state.cels.get(`sb.${p}.auth`)?.v as { status?: string; email?: string; error?: string } | undefined;
  const text = a?.status === "signed-in" ? `✓ signed in as ${a.email}` : `✗ ${a?.error ?? msg}`;
  await (resolveFn(state, "setValue") as Fn)(state, "grok.status", text);
  // a chatrooms doc is open (its =view("rooms", …) pane cel exists) → fetch the
  // room list right after auth so the rooms view populates without a click.
  if (a?.status === "signed-in" && state.cels.get("rooms.view")) {
    try { await (loadroomsFn(state, p) as Promise<unknown>); } catch { /* best-effort — ↻ Refresh retries */ }
  }
  await repaint(state);
  return String(msg);
}) as Fn;

const signoutFn: Fn = (async (state: State, projectArg?: unknown): Promise<string> => {
  const p = String(projectArg ?? state.cels.get("grok.project")?.v ?? "default");
  const auth = resolveFn(state, "supabase.auth") as Fn | undefined;
  const msg = auth ? await auth(state, "signout", p) : "";
  await (resolveFn(state, "setValue") as Fn)(state, "grok.status", "signed-out");
  await repaint(state);
  return String(msg ?? "");
}) as Fn;

const pickbotFn: Fn = (async (state: State, handle?: unknown): Promise<void> => {
  const h = String(handle ?? "");
  if (h && botsOf(state)[h]) await (resolveFn(state, "setValue") as Fn)(state, "grok.bot", h);
  await repaint(state);
}) as Fn;

// grok.send(state, project?) — the composer's Send: append the user message to
// the transcript, run the tool loop against the WORKBOOK context, append the
// assistant's reply (receipts landed during the loop). "@handle …" routes to
// that bot for this message (appkit's mention-routing, collapsed to a prefix).
const sendFn: Fn = (async (state: State, projectArg?: unknown): Promise<string> => {
  const project = String(projectArg ?? state.cels.get("grok.project")?.v ?? "default");
  let question = String(state.cels.get("grok.question")?.v ?? "").trim();
  if (!question) return "";
  let handle = String(state.cels.get("grok.bot")?.v ?? "smith");
  const at = /^@\*?([\w-]+)\s+(.*)$/s.exec(question);
  if (at && botsOf(state)[at[1]!]) { handle = at[1]!; question = at[2]!.trim(); }
  const bot = botsOf(state)[handle] ?? {};

  await pushTranscript(state, [{ role: "user", text: question, ts: Date.now() }]);
  await (resolveFn(state, "setValue") as Fn)(state, "grok.question", "");
  await repaint(state);

  // system = chat primer + persona + the WHOLE workbook (sheets + views).
  const ctx = String(workbookContextFn(state));
  const sys = chatPrimer(bot.persona) + (ctx ? `\n\nCurrent workbook:\n${ctx}` : "");
  // history: the transcript's user/assistant turns (receipts are chat chrome).
  const history = transcriptOf(state)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-30)
    .map((m) => ({ role: m.role, content: String(m.text ?? "") }));
  const body: Record<string, unknown> = { messages: [{ role: "system", content: sys }, ...history], tools: TOOL_DEFS };
  if (bot.model) body.model = bot.model;

  const r = await chatLoop(state, project, body, "auto");
  await pushTranscript(state, r.ok
    ? [{ role: "assistant", bot: handle, text: String(r.reply ?? ""), ts: Date.now() }]
    : [{ role: "assistant", bot: handle, text: `error: ${r.error ?? "no reply"}`, ts: Date.now(), error: true }]);
  await repaint(state);
  return "";
}) as Fn;

// grok.key(state, project, event) — the composer textarea's keydown: Enter sends,
// Shift+Enter newlines (appkit's composer contract).
const keyFn: Fn = (async (state: State, projectArg?: unknown, event?: unknown): Promise<void> => {
  const e = event as { key?: string; shiftKey?: boolean; preventDefault?: () => void } | undefined;
  if (e?.key !== "Enter" || e.shiftKey) return;
  e.preventDefault?.();
  await (sendFn(state, projectArg) as Promise<string>);
}) as Fn;

// ── the appkit ROOM chat (chatrooms doc) — sibling verbs beside grok.send ────
// Rooms and messages live in APPKIT'S DB (conversation / conversation_member /
// chat, RLS member-gated; the lounge is open to every authenticated user). All
// reads/writes go through supabase.data with the user JWT — RLS applies; no
// service key ever touches the client. grok.transcript/grok.send stay the
// standalone grok-chat surface; the room state is its own cel family.
interface AuthCel { status?: string; email?: string; userId?: string }
const authOf = (state: State, project: string): AuthCel =>
  (state.cels.get(`sb.${project}.auth`)?.v ?? {}) as AuthCel;
const isErrStr = (r: unknown): r is string => typeof r === "string"; // supabase.data errors are "(supabase.…)" strings

// peers: profile id → display name (appkit profile.name), for labeling others'
// bubbles and DM titles. Loaded with the rooms; failure leaves the old map.
const loadPeers = async (state: State, project: string): Promise<Record<string, string>> => {
  const r = await (R(state, "supabase.data", state, "select", project, { table: "profile", query: "select=id,name" }) as Promise<unknown>);
  if (!Array.isArray(r)) return (state.cels.get("grok.peers")?.v ?? {}) as Record<string, string>;
  const map: Record<string, string> = {};
  for (const row of r as Array<{ id?: unknown; name?: unknown }>) if (row?.id) map[String(row.id)] = String(row.name ?? "peer");
  await (resolveFn(state, "setValue") as Fn)(state, "grok.peers", map);
  return map;
};

// grok.loadrooms(state, project?) — the list_conversations RPC → grok.rooms
// ([{id, kind, title, last_body, last_at, unread}], lounge-first, RLS-scoped to
// the signed-in user). Also refreshes grok.peers. Errors surface on grok.status.
const loadroomsFn: Fn = (async (state: State, projectArg?: unknown): Promise<unknown> => {
  const p = String(projectArg ?? state.cels.get("grok.project")?.v ?? "default");
  const r = await (R(state, "supabase.data", state, "rpc", p, { fn: "list_conversations", args: { p_profile: null } }) as Promise<unknown>);
  if (!Array.isArray(r)) {
    await (resolveFn(state, "setValue") as Fn)(state, "grok.status", `✗ rooms: ${isErrStr(r) ? r : "not signed in?"}`);
    await repaint(state);
    return [];
  }
  const peers = await loadPeers(state, p);
  const me = String(authOf(state, p).userId ?? "");
  const rooms = (r as Array<Record<string, unknown>>).map((row) => {
    // a DM has no title — derive it from the OTHER member's profile name.
    let title = String(row.title ?? "");
    if (!title && row.kind === "dm" && Array.isArray(row.member_ids)) {
      const other = (row.member_ids as unknown[]).map(String).find((id) => id !== me);
      title = other ? (peers[other] ?? "Direct message") : "Direct message";
    }
    return { id: String(row.id ?? ""), kind: String(row.kind ?? "group"), title,
      last_body: String(row.last_body ?? ""), last_at: String(row.last_at ?? ""), unread: Number(row.unread ?? 0) };
  });
  await (resolveFn(state, "setValue") as Fn)(state, "grok.rooms", rooms);
  await repaint(state);
  return rooms;
}) as Fn;

// grok.loadmsgs(state, project?) — the selected room's messages → grok.roomlog,
// mapped into chatpane's dict shape: MY rows render as `user`, everyone else as
// their profile name (human:true → 👤 meta line). Structured formats (task/
// report) show as a tagged snippet. Poll-on-send/switch (realtime note below).
const loadmsgsFn: Fn = (async (state: State, projectArg?: unknown): Promise<unknown> => {
  const p = String(projectArg ?? state.cels.get("grok.project")?.v ?? "default");
  const room = String(state.cels.get("grok.room")?.v ?? "");
  if (!room) return [];
  const q = `select=id,conversation_id,author_id,body,format,created_at&conversation_id=eq.${room}&order=created_at.asc&limit=200`;
  const r = await (R(state, "supabase.data", state, "select", p, { table: "chat", query: q }) as Promise<unknown>);
  if (!Array.isArray(r)) {
    await (resolveFn(state, "setValue") as Fn)(state, "grok.status", `✗ messages: ${isErrStr(r) ? r : "load failed"}`);
    await repaint(state);
    return [];
  }
  const me = String(authOf(state, p).userId ?? "");
  const peers = (state.cels.get("grok.peers")?.v ?? {}) as Record<string, string>;
  const log: Msg[] = (r as Array<Record<string, unknown>>).map((row) => {
    const fmt = String(row.format ?? "plain");
    const text = (fmt === "task" || fmt === "report" ? `[${fmt}] ` : "") + String(row.body ?? "").slice(0, 2000);
    const ts = Date.parse(String(row.created_at ?? "")) || undefined;
    const mine = String(row.author_id ?? "") === me && me !== "";
    return mine
      ? { role: "user", text, ...(ts ? { ts } : {}), id: row.id }
      : { role: "assistant", human: true, bot: peers[String(row.author_id ?? "")] ?? "peer", text, ...(ts ? { ts } : {}), id: row.id };
  });
  await (resolveFn(state, "setValue") as Fn)(state, "grok.roomlog", log);
  return log;
}) as Fn;

// grok.pickroom(state, roomId) — "select one and go into chat": grok.room :=
// id, grok.roomtitle := its title, load the messages, then FOCUS the roomchat
// view tab (find the workbook whose view stack hosts roomchat.view and select
// that tab — window.viewTab, the same dispatch a tab click sends).
const pickroomFn: Fn = (async (state: State, roomArg?: unknown): Promise<void> => {
  const id = String(roomArg ?? "");
  if (!id) return;
  const rooms = (state.cels.get("grok.rooms")?.v ?? []) as RoomRow[];
  const room = rooms.find((r2) => String(r2.id) === id);
  await (resolveFn(state, "setValueBatch") as Fn)(state, [
    ["grok.room", id],
    ["grok.roomtitle", room?.title || "Room chat"],
    ["grok.roomlog", []],
  ]);
  await (loadmsgsFn(state) as Promise<unknown>);
  for (const [k, c] of state.cels) {
    if (!k.endsWith(".state")) continue;
    const st = c.v as { views?: Tab[] } | undefined;
    // the =view drain's tab ref shape: win.<wb>.view.roomchat (openViewPane)
    const idx = Array.isArray(st?.views) ? st.views.findIndex((t) => /\.view(?:\.dom)?\.roomchat$/.test(String(t.ref ?? ""))) : -1;
    if (idx < 0) continue;
    const viewTab = resolveFn(state, "window.viewTab") as Fn | undefined;
    if (viewTab) await viewTab(state, { ref: k, index: idx });
    const raise = resolveFn(state, "window.raise") as Fn | undefined;
    if (raise) await raise(state, k);
    break;
  }
  await repaint(state);
}) as Fn;

// grok.roomsend(state, project?) — send grok.roomq into the selected room: an
// RLS-gated INSERT into appkit's chat table AS YOURSELF (author_id must equal
// auth.uid()), then — when the message @*mentions a bot (appkit's sigil) —
// fire-and-forget the bot-responder edge function with the new chat_id (that IS
// how appkit summons bots), then reload the log (poll-on-send; realtime note:
// supabase.realtime bumps sb.<p>.chat.rev, but roomlog is handler-written, so
// live arrival needs a rev→loadmsgs hook — future wiring, not done here).
const roomsendFn: Fn = (async (state: State, projectArg?: unknown): Promise<string> => {
  const p = String(projectArg ?? state.cels.get("grok.project")?.v ?? "default");
  const body = String(state.cels.get("grok.roomq")?.v ?? "").trim();
  const room = String(state.cels.get("grok.room")?.v ?? "");
  if (!body) return "";
  if (!room) { await (resolveFn(state, "setValue") as Fn)(state, "grok.status", "✗ pick a room first (rooms view)"); await repaint(state); return ""; }
  const me = String(authOf(state, p).userId ?? "");
  if (!me) { await (resolveFn(state, "setValue") as Fn)(state, "grok.status", "✗ sign in first (login view)"); await repaint(state); return ""; }
  const r = await (R(state, "supabase.data", state, "insert", p, { table: "chat", rows: [{ conversation_id: room, author_id: me, body }] }) as Promise<unknown>);
  if (!Array.isArray(r)) {
    await (resolveFn(state, "setValue") as Fn)(state, "grok.status", `✗ send: ${isErrStr(r) ? r : "insert failed"}`);
    await repaint(state);
    return "";
  }
  await (resolveFn(state, "setValue") as Fn)(state, "grok.roomq", "");
  // mention-only bot summon (appkit's contract: '@*handle' + bot-responder {chat_id})
  const chatId = (r[0] as { id?: unknown } | undefined)?.id;
  if (/@\*[\w-]+/.test(body) && chatId !== undefined) {
    try { await (R(state, "supabase.invoke", state, p, "bot-responder", { chat_id: chatId }) as Promise<unknown>); } catch { /* fire-and-forget */ }
  }
  await (loadmsgsFn(state, p) as Promise<unknown>);
  await repaint(state);
  return "";
}) as Fn;

// grok.roomkey(state, project, event) — the room composer's Enter-to-send twin.
const roomkeyFn: Fn = (async (state: State, projectArg?: unknown, event?: unknown): Promise<void> => {
  const e = event as { key?: string; shiftKey?: boolean; preventDefault?: () => void } | undefined;
  if (e?.key !== "Enter" || e.shiftKey) return;
  e.preventDefault?.();
  await (roomsendFn(state, projectArg) as Promise<string>);
}) as Fn;

// ── grok.ui — PURE render of the login + chat card (appkit-styled) ───────────
// grok.ui(project, email, password, status, question, thread, authed?, bots?, bot?)
// Called from a view formula with the reactive buffer cels as args so it
// re-renders on each change. `thread` is the grok.transcript list (grok.reply
// mirrors it for the already-shipped card formula; a plain string still renders
// as one assistant bubble). `authed` (optional) is signedIn(sb.<p>.auth); absent,
// the "✓ signed in" status prefix gates. Look and feel replicate ~/projects/
// appkit: near-black header band + slate palette (#334155/#1e293b) + Telegram-
// style bubbles + a rounded-full composer. Inputs dispatch grok.field; buttons
// grok.signin / grok.send / grok.pickbot / grok.signout (formulas render,
// handlers act).
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const BRAND = "#334155", BRAND_DARK = "#1e293b", HEADER_BG = "#1c1c1e";
const INPUT_S = "width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:4px;padding:.5rem .75rem;font-size:.875rem;outline:none;font-family:inherit";
const LABEL_S = "display:block;font-size:.75rem;font-weight:600;color:#475569;margin-bottom:.25rem";

const hhmm = (ts: unknown): string => {
  const n = Number(ts);
  if (!n) return "";
  const d = new Date(n);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const loginCard = (project: string, email: unknown, password: unknown, status: unknown): unknown => {
  const st = String(status ?? "");
  const isErr = st.startsWith("✗");
  const showSt = st !== "" && st !== "signed-out";
  return dom("div.gk-login",
    attr("style", `width:100%;max-width:24rem;margin:1rem auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 10px 15px -3px rgba(0,0,0,.1);overflow:hidden;font-family:${FONT}`),
    dom("div", attr("style", `background:${HEADER_BG};color:#fff;padding:1.25rem 1.5rem`),
      dom("div", attr("style", "font-weight:600;font-size:1.05rem;letter-spacing:-.01em"), "plastron"),
      dom("div", attr("style", "color:rgba(255,255,255,.8);font-size:.875rem;margin-top:.15rem"), `Sign in with your ${project} account`)),
    dom("div", attr("style", "padding:1.5rem;display:flex;flex-direction:column;gap:.75rem"),
      dom("div",
        dom("label", attr("style", LABEL_S), "Email"),
        dom("input", attr("type", "email"), attr("autocomplete", "email"), attr("placeholder", "you@example.com"), attr("value", String(email ?? "")), attr("style", INPUT_S), on("input", "grok.field", "grok.email"))),
      dom("div",
        dom("label", attr("style", LABEL_S), "Password"),
        dom("input", attr("type", "password"), attr("autocomplete", "current-password"), attr("value", String(password ?? "")), attr("style", INPUT_S), on("input", "grok.field", "grok.password"))),
      dom("button", attr("style", `width:100%;background:${BRAND};color:#fff;border:none;border-radius:4px;padding:.5rem .75rem;font-size:.875rem;font-weight:500;cursor:pointer;font-family:inherit`), on("click", "grok.signin", project), "Sign in"),
      showSt ? dom("div.gk-status", attr("style", `font-size:.875rem;color:${isErr ? "#dc2626" : "#047857"}`), st) : "",
      dom("div", attr("style", "font-size:11px;color:#94a3b8;text-align:center"), "Chat with grok about this workbook once signed in.")));
};

const bubble = (m: Msg, bots: Record<string, Bot>): unknown => {
  if (m.role === "user") {
    return dom("div", attr("style", "display:flex;justify-content:flex-end;padding:.15rem 0"),
      dom("div.gk-msg-user", attr("style", `max-width:85%;background:${BRAND};color:#fff;border-radius:16px;padding:.375rem .75rem;font-size:.875rem;white-space:pre-wrap;word-break:break-word;box-shadow:0 1px 2px rgba(0,0,0,.05)`), String(m.text ?? "")));
  }
  if (m.role === "assistant") {
    const who = bots[m.bot ?? ""]?.name ?? m.bot ?? "grok";
    const t = hhmm(m.ts);
    // `human` marks another PERSON's message (a room peer) — 👤, not 🤖.
    return dom("div", attr("style", "display:flex;flex-direction:column;align-items:flex-start;padding:.15rem 0"),
      dom("div", attr("style", "font-size:10px;color:#94a3b8;padding:0 .25rem"), `${m.human ? "👤" : "🤖"} ${who}${t ? ` · ${t}` : ""}`),
      dom("div.gk-msg-bot", attr("style", `max-width:85%;background:#fff;color:${m.error ? "#dc2626" : BRAND_DARK};border:1px solid #e2e8f0;border-radius:16px;padding:.375rem .75rem;font-size:.875rem;white-space:pre-wrap;word-break:break-word;box-shadow:0 1px 2px rgba(0,0,0,.05)`), String(m.text ?? "")));
  }
  if (m.role === "receipt") {
    return dom("div", attr("style", "display:flex;justify-content:center;padding:.1rem 0"),
      dom("div.gk-receipt", attr("style", "font-size:11px;color:#475569;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:.15rem .5rem;max-width:92%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"), `✎ ${String(m.text ?? "")}`));
  }
  return "";
};

// the composer/header WIRING a chatCard instance uses — the standalone grok
// chat and the appkit ROOM chat share the renderer but dispatch different verbs
// and buffer cels (sibling verbs, not overloads).
interface ChatWires { title?: string; draftCel?: string; send?: string; key?: string; placeholder?: string; chips?: boolean }
const chatCard = (project: string, question: unknown, msgs: Msg[], bots: Record<string, Bot>, active: string, status: unknown, wires: ChatWires = {}): unknown => {
  const w = {
    title: wires.title || "Grok chat",
    draftCel: wires.draftCel || "grok.question",
    send: wires.send || "grok.send",
    key: wires.key || "grok.key",
    placeholder: wires.placeholder || "Type a message… (@bot to route)",
    chips: wires.chips !== false,
  };
  const chips = w.chips ? Object.entries(bots).map(([h, b]) =>
    dom("button.gk-bot-chip", attr("title", b.persona ?? h),
      attr("style", h === active
        ? `background:${BRAND};color:#fff;border:1px solid ${BRAND};border-radius:9999px;padding:.1rem .55rem;font-size:11px;cursor:pointer;font-family:inherit`
        : `background:#fff;color:#475569;border:1px solid #e2e8f0;border-radius:9999px;padding:.1rem .55rem;font-size:11px;cursor:pointer;font-family:inherit`),
      on("click", "grok.pickbot", h), `@${h}`)) : [];
  return dom("div.gk-chat",
    attr("style", `display:flex;flex-direction:column;width:100%;height:100%;min-height:320px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;font-family:${FONT}`),
    // header (appkit thread header: title / subtitle / actions)
    dom("div", attr("style", "flex:0 0 auto;display:flex;align-items:center;gap:.5rem;padding:.5rem .75rem;border-bottom:1px solid #e2e8f0;background:#fff"),
      dom("div", attr("style", "flex:1 1 auto;min-width:0"),
        dom("div", attr("style", `font-size:.875rem;font-weight:700;color:${BRAND_DARK}`), w.title),
        dom("div", attr("style", "font-size:11px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"), String(status ?? "").replace(/^✓\s*/, ""))),
      dom("div", attr("style", "display:flex;gap:.25rem;flex-wrap:wrap;justify-content:flex-end;max-width:60%"), chips),
      dom("button", attr("style", "background:transparent;border:none;color:#dc2626;font-size:11px;cursor:pointer;font-family:inherit;padding:.2rem"), on("click", "grok.signout", project), "Sign out")),
    // stream (slate-50, bubbles)
    dom("div.gk-stream", attr("style", "flex:1 1 auto;overflow-y:auto;padding:.5rem;background:#f8fafc;display:flex;flex-direction:column;gap:.1rem"),
      msgs.length
        ? msgs.map((m) => bubble(m, bots))
        : dom("div", attr("style", "font-size:.875rem;color:#94a3b8;text-align:center;margin-top:2rem"), "No messages yet — say hi 👋")),
    // composer (rounded-full textarea + Send pill; Enter sends, Shift+Enter newlines)
    dom("div", attr("style", "flex:0 0 auto;display:flex;align-items:flex-end;gap:.5rem;padding:.5rem;background:#fff;border-top:1px solid #f1f5f9"),
      dom("textarea", attr("rows", "1"), attr("placeholder", w.placeholder), attr("value", String(question ?? "")),
        attr("style", "flex:1 1 auto;border:1px solid #cbd5e1;border-radius:9999px;padding:.6rem 1rem;font-size:.875rem;outline:none;resize:none;font-family:inherit;min-width:0"),
        on("input", "grok.field", w.draftCel), on("keydown", w.key, project)),
      dom("button", attr("style", `flex:0 0 auto;background:${BRAND};color:#fff;border:none;border-radius:9999px;padding:.6rem 1rem;font-size:.875rem;font-weight:500;cursor:pointer;font-family:inherit`), on("click", w.send, project), "Send")));
};

// chatpane(transcript, draft, opts?) — THE pure renderer (the sheetbar/fgview
// pattern: instance cels as args, so a GRID CELL can author the whole chat as
// one visible, editable formula wrapped in =view):
//   =view("chat", chatpane(grok.transcript, grok.question, {project:"default",
//     authed:signedIn(sb.default.auth), bots:grok.bots, bot:grok.bot,
//     email:grok.email, password:grok.password, status:grok.status}))
// Referencing the cels in the formula IS the reactivity: each send/receipt/
// keystroke re-fires the authoring cell and the =view slot re-renders. opts:
// authed=false gates to the login card (signedIn(sb.<p>.auth)); absent authed
// falls back to the '✓' status prefix; absent BOTH renders the chat (a doc may
// opt out of gating).
interface PaneOpts {
  project?: unknown; authed?: unknown; bots?: unknown; bot?: unknown; status?: unknown; email?: unknown; password?: unknown;
  // instance wiring (the room chat passes its sibling verbs/cels):
  title?: unknown; draftCel?: unknown; send?: unknown; key?: unknown; placeholder?: unknown; chips?: unknown;
  // loginpane extras:
  session?: unknown;
  // roomspane extras:
  room?: unknown;
}
const paneOpts = (optsArg: unknown): PaneOpts =>
  (optsArg && typeof optsArg === "object" && !Array.isArray(optsArg)) ? optsArg as PaneOpts : {};
const paneAuthed = (o: PaneOpts): boolean =>
  typeof o.authed === "boolean" ? o.authed
    : (o.status !== undefined && o.status !== null ? String(o.status).startsWith("✓") : true);
const chatpaneFn: Fn = ((transcript?: unknown, draft?: unknown, optsArg?: unknown): unknown => {
  const o = paneOpts(optsArg);
  const p = String(o.project ?? "default");
  if (!paneAuthed(o)) return loginCard(p, o.email, o.password, o.status);
  const msgs: Msg[] = Array.isArray(transcript) ? transcript as Msg[]
    : (typeof transcript === "string" && transcript !== "" ? [{ role: "assistant", text: transcript }] : []);
  const bots = (o.bots && typeof o.bots === "object" && !Array.isArray(o.bots)) ? o.bots as Record<string, Bot> : {};
  const active = String(o.bot ?? "smith");
  const wires: ChatWires = {};
  if (o.title != null && o.title !== "") wires.title = String(o.title);
  if (o.draftCel) wires.draftCel = String(o.draftCel);
  if (o.send) wires.send = String(o.send);
  if (o.key) wires.key = String(o.key);
  if (o.placeholder) wires.placeholder = String(o.placeholder);
  if (o.chips === false) wires.chips = false;
  return chatCard(p, draft, msgs, bots, active, o.status ?? "", wires);
}) as Fn;

// loginpane(opts) — the login card as ITS OWN =view surface (Ian's chatrooms
// doc: one view to sign in, one to pick a room, one to chat). Signed out it IS
// chatpane's appkit login card; signed in it becomes the SESSION card — who you
// are + Sign out — so the view stays meaningful after auth. opts: {project,
// authed, email, password, status, session:sb.<p>.auth}.
const loginpaneFn: Fn = ((optsArg?: unknown): unknown => {
  const o = paneOpts(optsArg);
  const p = String(o.project ?? "default");
  if (!paneAuthed(o)) return loginCard(p, o.email, o.password, o.status);
  const sess = (o.session && typeof o.session === "object") ? o.session as { email?: string; userId?: string } : {};
  return dom("div.gk-session",
    attr("style", `width:100%;max-width:24rem;margin:1rem auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 10px 15px -3px rgba(0,0,0,.1);overflow:hidden;font-family:${FONT}`),
    dom("div", attr("style", `background:${HEADER_BG};color:#fff;padding:1.25rem 1.5rem`),
      dom("div", attr("style", "font-weight:600;font-size:1.05rem;letter-spacing:-.01em"), "plastron"),
      dom("div", attr("style", "color:rgba(255,255,255,.8);font-size:.875rem;margin-top:.15rem"), "Session")),
    dom("div", attr("style", "padding:1.5rem;display:flex;flex-direction:column;gap:.75rem"),
      dom("div", attr("style", "display:flex;align-items:center;gap:.6rem"),
        dom("div", attr("style", `flex:0 0 auto;width:2.25rem;height:2.25rem;border-radius:9999px;background:${BRAND};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600`), String(sess.email ?? "?").slice(0, 1).toUpperCase()),
        dom("div", attr("style", "min-width:0"),
          dom("div", attr("style", `font-size:.875rem;font-weight:600;color:${BRAND_DARK};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`), `Signed in as ${sess.email ?? "…"}`),
          dom("div", attr("style", "font-size:11px;color:#94a3b8"), "token held in the session store — never a cel"))),
      dom("button", attr("style", "width:100%;background:#fff;color:#dc2626;border:1px solid #fecaca;border-radius:4px;padding:.5rem .75rem;font-size:.875rem;font-weight:500;cursor:pointer;font-family:inherit"), on("click", "grok.signout", p), "Sign out"),
      dom("div", attr("style", "font-size:11px;color:#94a3b8;text-align:center"), "Pick a room in the rooms view to start chatting.")));
}) as Fn;

// roomspane(rooms, opts) — the CHATROOMS view over appkit's conversations
// (grok.loadrooms → the list_conversations RPC): one clickable row per room —
// kind icon (🏛 lounge / 👥 group / 👤 dm), title, last-message snippet, unread
// badge; clicking dispatches grok.pickroom (select + load + focus the roomchat
// view). Signed out it renders the gate hint. opts: {project, authed, room,
// status}.
interface RoomRow { id?: unknown; kind?: string; title?: string; last_body?: string; last_at?: string; unread?: number }
const ROOM_ICON: Record<string, string> = { lounge: "🏛", group: "👥", dm: "👤" };
const roomspaneFn: Fn = ((roomsArg?: unknown, optsArg?: unknown): unknown => {
  const o = paneOpts(optsArg);
  const p = String(o.project ?? "default");
  const shell = (...kids: unknown[]): unknown => dom("div.gk-rooms",
    attr("style", `display:flex;flex-direction:column;width:100%;height:100%;min-height:240px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;font-family:${FONT}`),
    dom("div", attr("style", "flex:0 0 auto;display:flex;align-items:center;gap:.5rem;padding:.5rem .75rem;border-bottom:1px solid #e2e8f0"),
      dom("div", attr("style", `flex:1 1 auto;font-size:.875rem;font-weight:700;color:${BRAND_DARK}`), "Chats"),
      dom("button.gk-rooms-refresh", attr("title", "reload the room list"), attr("style", "background:transparent;border:1px solid #e2e8f0;border-radius:9999px;color:#475569;font-size:11px;cursor:pointer;font-family:inherit;padding:.15rem .6rem"), on("click", "grok.loadrooms", p), "↻ Refresh")),
    ...kids);
  if (!paneAuthed(o)) {
    return shell(dom("div", attr("style", "flex:1 1 auto;display:flex;align-items:center;justify-content:center;font-size:.875rem;color:#94a3b8;padding:1rem;text-align:center"),
      "Sign in (login view) to see your rooms."));
  }
  const rooms = (Array.isArray(roomsArg) ? roomsArg : []) as RoomRow[];
  const selected = String(o.room ?? "");
  const row = (r: RoomRow): unknown => {
    const id = String(r.id ?? "");
    const active = id !== "" && id === selected;
    const title = r.title || (r.kind === "dm" ? "Direct message" : r.kind === "lounge" ? "Lounge" : "(untitled)");
    const unread = Number(r.unread ?? 0);
    return dom("button.gk-room-row" + (active ? ".active" : ""), attr("data-room", id),
      attr("style", `display:flex;align-items:center;gap:.5rem;width:100%;text-align:left;border:none;cursor:pointer;padding:.45rem .75rem;font-family:inherit;background:${active ? "#eef2f7" : "transparent"};border-left:3px solid ${active ? BRAND : "transparent"}`),
      on("click", "grok.pickroom", id),
      dom("span", attr("style", "flex:0 0 auto;font-size:1rem"), ROOM_ICON[String(r.kind ?? "")] ?? "💬"),
      dom("span", attr("style", "flex:1 1 auto;min-width:0;display:flex;flex-direction:column"),
        dom("span", attr("style", `font-size:.875rem;font-weight:600;color:${BRAND_DARK};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`), title),
        dom("span", attr("style", "font-size:11px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"), String(r.last_body ?? "").slice(0, 80) || "(no messages yet)")),
      unread > 0 ? dom("span", attr("style", `flex:0 0 auto;background:${BRAND};color:#fff;border-radius:9999px;font-size:10px;font-weight:600;padding:.1rem .45rem`), String(unread)) : "");
  };
  return shell(dom("div.gk-room-list", attr("style", "flex:1 1 auto;overflow-y:auto;background:#f8fafc;display:flex;flex-direction:column"),
    rooms.length ? rooms.map(row)
      : dom("div", attr("style", "font-size:.875rem;color:#94a3b8;text-align:center;margin-top:2rem"), "No rooms yet — ↻ Refresh after signing in.")));
}) as Fn;

// grok.ui — the =chatcard card formula's entry (positional compat wrapper over
// chatpane; the shipped cardBook formula passes grok.reply — the transcript
// mirror — as `thread`).
const uiFn: Fn = ((project?: unknown, email?: unknown, password?: unknown, status?: unknown, question?: unknown, thread?: unknown, authedArg?: unknown, botsArg?: unknown, botArg?: unknown): unknown =>
  chatpaneFn(thread, question, { project, email, password, status: status ?? "", authed: authedArg, bots: botsArg, bot: botArg })) as Fn;

export const name = "grok" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["grok.context", contextFn],
  ["grok.workbook-context", workbookContextFn],
  ["grok.ask", askFn],
  ["grok.fetch", fetchFn],
  ["grok.applytools", applyToolCallsFn],
  ["grok.field", fieldFn],
  ["grok.signin", signinFn],
  ["grok.signout", signoutFn],
  ["grok.send", sendFn],
  ["grok.key", keyFn],
  ["grok.pickbot", pickbotFn],
  ["grok.addbot", addbotHandlerFn],
  ["addbot", addbotFn],
  ["chatpane", chatpaneFn],
  ["loginpane", loginpaneFn],
  ["roomspane", roomspaneFn],
  ["grok.loadrooms", loadroomsFn],
  ["grok.loadmsgs", loadmsgsFn],
  ["grok.pickroom", pickroomFn],
  ["grok.roomsend", roomsendFn],
  ["grok.roomkey", roomkeyFn],
  ["grok.ui", uiFn],
]));
