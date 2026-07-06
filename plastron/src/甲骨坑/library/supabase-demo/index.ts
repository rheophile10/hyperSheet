import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import { dom, attr, on } from "../dom/utils/vocab.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// supabase-demo — worked Supabase examples on sheetApp/origin.
//
//  • the PANEL demo (sbdemo.install + sbdemo.signin/add/watch): a reactive dom
//    panel showing auth status + live todo rev-count.
//  • the LOGIN + KANBAN demo (sbdemo.kanban + sbdemo.ui/field/login): an
//    INTERACTIVE login form (real <input>s + a button authored as a formula)
//    that, on submit, signs in and queries the user's kanban table, rendering
//    their tasks as a board. Formulas never touch state — the inputs/button
//    dispatch to state-aware handlers; the view only READS reactive cels.
// ============================================================================

const meta = (key: string, segment = "supabase-demo") => ({ key, segment });

// ── the PANEL demo (unchanged) ──────────────────────────────────────────────
const installFn: Fn = (async (state: State, project: unknown, url: unknown, anon: unknown): Promise<string> => {
  const p = String(project ?? "demo");
  const batch: Record<string, unknown> = {};
  if (url) batch[`sb.${p}.url`] = { celType: "ValueCel", v: String(url), metadata: meta(`sb.${p}.url`) };
  if (anon) batch[`sb.${p}.anonkey`] = { celType: "ValueCel", v: String(anon), metadata: meta(`sb.${p}.anonkey`) };
  batch[`sbdemo.${p}.status`] = { celType: "ValueCel", v: "auth: signed-out", metadata: meta(`sbdemo.${p}.status`) };
  batch[`sbdemo.${p}.live`] = { celType: "ValueCel", v: "live: off", metadata: meta(`sbdemo.${p}.live`) };
  batch[`sb.${p}.todos.rev`] = { celType: "ValueCel", v: 0, metadata: meta(`sb.${p}.todos.rev`, "supabase") };
  batch[`sbdemo.${p}.panel`] = {
    celType: "FormulaCel",
    f: `=dom('div.sb-demo', dom('div.sb-auth', sbdemo.${p}.status), dom('div.sb-rev', CONCAT('todos rev: ', sb.${p}.todos.rev)), dom('div.sb-live', sbdemo.${p}.live))`,
    metadata: { key: `sbdemo.${p}.panel`, segment: "supabase-demo", parser: "infix" },
  };
  await (resolveFn(state, "setCelBatch") as Fn)(state, batch);
  return `sbdemo: installed demo "${p}" — reactive panel at sbdemo.${p}.panel`;
}) as Fn;

const signinFn: Fn = (async (state: State, project: unknown, payload: unknown): Promise<string> => {
  const p = String(project ?? "demo");
  const msg = await (resolveFn(state, "supabase.auth") as Fn)(state, "signin", p, payload);
  const a = state.cels.get(`sb.${p}.auth`)?.v as { status?: string; email?: string } | undefined;
  const text = a?.status === "signed-in" ? `auth: signed in (${a.email})` : `auth: ${a?.status ?? "error"}`;
  await (resolveFn(state, "setValue") as Fn)(state, `sbdemo.${p}.status`, text);
  return String(msg);
}) as Fn;

const addFn: Fn = (async (state: State, project: unknown, title: unknown): Promise<unknown> => {
  const p = String(project ?? "demo");
  return await (resolveFn(state, "supabase.data") as Fn)(state, "insert", p, { table: "todos", rows: { title: String(title ?? "todo") } });
}) as Fn;

const watchFn: Fn = (async (state: State, project: unknown): Promise<string> => {
  const p = String(project ?? "demo");
  const r = await (resolveFn(state, "supabase.realtime") as Fn)(state, "subscribe", p, { table: "todos" });
  await (resolveFn(state, "setValue") as Fn)(state, `sbdemo.${p}.live`, `live: ${/subscribed/.test(String(r)) ? "on" : "off"}`);
  return String(r);
}) as Fn;

// ── the LOGIN + KANBAN demo ─────────────────────────────────────────────────

// sbdemo.ui(project, email, password, status, tasks) — PURE render: the login
// form + the kanban board. Called from a formula with the reactive cels as args
// so it re-renders on every change. <input>s dispatch to sbdemo.field (capture
// keystrokes → cel); the button dispatches to sbdemo.login.
const KANBAN_COLS: Array<[string, string]> = [["To do", "todo"], ["Doing", "doing"], ["Done", "done"]];

const uiFn: Fn = ((project: unknown, email: unknown, password: unknown, status: unknown, tasks: unknown): unknown => {
  const p = String(project ?? "demo");
  const rows = (Array.isArray(tasks) ? tasks : []) as Array<{ title?: unknown; status?: unknown }>;
  const login = dom("div.sb-login",
    dom("div.sb-title", "plastron · sign in"),
    dom("input.sb-email", attr("type", "email"), attr("placeholder", "you@example.com"), attr("value", String(email ?? "")),
      on("input", "sbdemo.field", `sbdemo.${p}.email`)),
    dom("input.sb-pass", attr("type", "password"), attr("placeholder", "password"), attr("value", String(password ?? "")),
      on("input", "sbdemo.field", `sbdemo.${p}.password`)),
    dom("button.sb-go", on("click", "sbdemo.login", p), "Log in"),
    dom("div.sb-status", String(status ?? "")),
  );
  const board = rows.length
    ? dom("div.sb-board",
        ...KANBAN_COLS.map(([label, st]) => dom(`div.sb-col.sb-col-${st}`,
          dom("div.sb-col-h", `${label} (${rows.filter((r) => String(r.status) === st).length})`),
          ...rows.filter((r) => String(r.status) === st).map((r) => dom("div.sb-card", String(r.title ?? ""))),
        )),
      )
    : dom("div.sb-board.sb-empty", "← sign in to load your kanban");
  return dom("div.sb-demo-app", login, board);
}) as Fn;

// sbdemo.field(state, cellKey, event) — write an input's value into a cel.
const fieldFn: Fn = (async (state: State, cellKey: unknown, event: unknown): Promise<void> => {
  const v = (event as { target?: { value?: unknown } } | undefined)?.target?.value ?? "";
  await (resolveFn(state, "setValue") as Fn)(state, String(cellKey), v);
}) as Fn;

// sbdemo.login(state, project, event) — sign in with the captured email/password,
// then query the user's kanban (RLS-scoped) and surface the rows for the board.
const loginFn: Fn = (async (state: State, project: unknown): Promise<string> => {
  const p = String(project ?? "demo");
  const email = state.cels.get(`sbdemo.${p}.email`)?.v;
  const password = state.cels.get(`sbdemo.${p}.password`)?.v;
  const msg = await (resolveFn(state, "supabase.auth") as Fn)(state, "signin", p, { email, password });
  const a = state.cels.get(`sb.${p}.auth`)?.v as { status?: string; email?: string; error?: string } | undefined;
  const setV = resolveFn(state, "setValue") as Fn;
  if (a?.status === "signed-in") {
    await setV(state, `sbdemo.${p}.status`, `signed in as ${a.email}`);
    const rows = await (resolveFn(state, "supabase.data") as Fn)(state, "select", p, { table: "kanban", query: "select=title,status,position&order=position.asc" });
    await setV(state, `sbdemo.${p}.tasks`, Array.isArray(rows) ? rows : []);
  } else {
    await setV(state, `sbdemo.${p}.status`, `sign-in failed: ${a?.error ?? msg}`);
  }
  // a dispatch handler that writes cels must re-composite + repaint the workbook
  // view so it reflects them (same sequence the install uses).
  await (resolveFn(state, "view.refresh") as Fn)(state);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return String(msg);
}) as Fn;

// sbdemo.kanban(state, project, url, anon) — open the interactive demo as a
// sheetApp WORKBOOK whose view panel renders the login form + kanban board.
const kanbanFn: Fn = (async (state: State, project: unknown, url: unknown, anon: unknown): Promise<string> => {
  const p = String(project ?? "demo");
  const setCelBatch = resolveFn(state, "setCelBatch") as Fn;
  // 1. content cels: config + the captured fields + the view FormulaCel (a vnode)
  const batch: Record<string, unknown> = {};
  if (url) batch[`sb.${p}.url`] = { celType: "ValueCel", v: String(url), metadata: meta(`sb.${p}.url`) };
  if (anon) batch[`sb.${p}.anonkey`] = { celType: "ValueCel", v: String(anon), metadata: meta(`sb.${p}.anonkey`) };
  batch[`sbdemo.${p}.email`] = { celType: "ValueCel", v: "", metadata: meta(`sbdemo.${p}.email`) };
  batch[`sbdemo.${p}.password`] = { celType: "ValueCel", v: "", metadata: meta(`sbdemo.${p}.password`) };
  batch[`sbdemo.${p}.status`] = { celType: "ValueCel", v: "signed-out", metadata: meta(`sbdemo.${p}.status`) };
  batch[`sbdemo.${p}.tasks`] = { celType: "ValueCel", v: [], metadata: meta(`sbdemo.${p}.tasks`) };
  batch[`sbdemo.${p}.view`] = {
    celType: "FormulaCel",
    f: `=sbdemo.ui('${p}', sbdemo.${p}.email, sbdemo.${p}.password, sbdemo.${p}.status, sbdemo.${p}.tasks)`,
    metadata: { key: `sbdemo.${p}.view`, segment: "supabase-demo", parser: "infix" },
  };
  await setCelBatch(state, batch);
  // 2. open a self-mounting workbook window with the login+kanban as a VIEW panel
  const g = (resolveFn(state, "wbopen") as Fn)(`sbdemo-${p}`, "Supabase · Login + Kanban",
    [], [{ ref: `sbdemo.${p}.view`, title: "Login + Kanban" }], { __geom: { x: 150, y: 80, w: 780, h: 540 } }) as { cels: Record<string, unknown> };
  await setCelBatch(state, g.cels);
  // 3. composite + paint (the sheetApp commit sequence)
  await (resolveFn(state, "view.refresh") as Fn)(state);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return `sbdemo: opened login+kanban workbook for "${p}"`;
}) as Fn;

export const name = "supabase-demo" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sbdemo.install", installFn],
  ["sbdemo.signin", signinFn],
  ["sbdemo.add", addFn],
  ["sbdemo.watch", watchFn],
  ["sbdemo.ui", uiFn],
  ["sbdemo.field", fieldFn],
  ["sbdemo.login", loginFn],
  ["sbdemo.kanban", kanbanFn],
]));
