import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };
import { subscribe, unsubscribe, realtimeStatus } from "./utils/realtime.js";

// ============================================================================
// supabase — the PostgREST data plane (the cloud twin of the sqlite library).
// op-dispatch verb usable from formulas: select/insert/update/delete/rpc over
// REST. Auth is borrowed from the session store: when signed in (via
// supabase-auth) the user JWT is resolved at the EFFECT SITE for the bearer; the
// token never becomes a cel value. Config (url + publishable key) is read from
// the public sb.<project>.url / sb.<project>.anonkey cels.
//
// THE REACTIVITY BRIDGE (mirrors sqlite's rev counter): every write bumps
// sb.<project>.<table>.rev. A select formula that references that rev re-fires
// when it changes — and realtime (stage 3) bumps the SAME rev from a WebSocket
// push, so a server-side change refreshes a subscribed formula with no new
// machinery. See [[project_windowing_architecture]]-adjacent sqlite rev pattern.
// ============================================================================

const sessName = (project: string): string => `supabase.${project}`;

// sbConfig — THE project-config resolver, shared by every sb consumer (grok
// imports it; supabase-auth/-storage should adopt it too). DICT-FIRST: one
// `sb.<project>` ValueCel holding {url, anonkey} (a collections-doctrine dict —
// the whole public config is ONE cel, so a document ships it as one JSON
// entry); falls back to the older two-cel form sb.<project>.url /
// sb.<project>.anonkey (grokconfig / supabase.config still write it). Returns
// undefined when neither form is present (callers phrase their own error).
export const sbConfig = (state: State, project: string): { url: string; anonKey: string } | undefined => {
  const d = state.cels.get(`sb.${project}`)?.v as { url?: unknown; anonkey?: unknown; anonKey?: unknown; key?: unknown } | undefined;
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const url = d.url, anonKey = d.anonkey ?? d.anonKey ?? d.key;
    if (typeof url === "string" && url && typeof anonKey === "string" && anonKey) {
      return { url: url.replace(/\/+$/, ""), anonKey };
    }
  }
  const url = state.cels.get(`sb.${project}.url`)?.v;
  const anonKey = state.cels.get(`sb.${project}.anonkey`)?.v;
  if (typeof url !== "string" || !url || typeof anonKey !== "string" || !anonKey) return undefined;
  return { url: url.replace(/\/+$/, ""), anonKey };
};

const readConfig = (state: State, project: string): { url: string; anonKey: string } => {
  const cfg = sbConfig(state, project);
  if (!cfg) throw new Error(`missing supabase config — set the sb.${project} dict cel ({"url":"…","anonkey":"sb_publishable_…"}) or the sb.${project}.url / sb.${project}.anonkey cels`);
  return cfg;
};

// resolve the access token from the session store at the effect site (undefined
// when not signed in → the request goes out anon).
const sessionAccess = (state: State, project: string): string | undefined => {
  if (!state.cels.get("session.handle")) return undefined;
  try {
    return ((resolveFn(state, "session.handle") as Fn)(state, sessName(project)) as { resolve(): string | undefined }).resolve();
  } catch { return undefined; }
};

interface RestResult { ok: boolean; status: number; json: unknown }
const rest = async (
  state: State, project: string, method: string, path: string, body?: unknown, prefer?: string,
): Promise<RestResult> => {
  const { url, anonKey } = readConfig(state, project);
  const token = sessionAccess(state, project);
  const headers: Record<string, string> = { apikey: anonKey, "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (prefer) headers.Prefer = prefer;
  const res = await globalThis.fetch(`${url}/rest/v1/${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  if (text) { try { json = JSON.parse(text); } catch { json = text; } }
  return { ok: res.ok, status: res.status, json };
};

const errOf = (r: RestResult): string => {
  const j = r.json as { message?: string; msg?: string; hint?: string } | undefined;
  return String(j?.message ?? j?.msg ?? j?.hint ?? `HTTP ${r.status}`);
};

const revKey = (project: string, table: string): string => `sb.${project}.${table}.rev`;

// bump the table's revision counter (create-or-increment). Exported so realtime
// (stage 3) bumps the SAME cel from a WebSocket push.
export const bumpRev = async (state: State, project: string, table: string): Promise<void> => {
  const k = revKey(project, table);
  const next = Number(state.cels.get(k)?.v ?? 0) + 1;
  if (state.cels.get(k)) {
    await (resolveFn(state, "setValue") as Fn)(state, k, next);
  } else {
    await (resolveFn(state, "setCel") as Fn)(state, k, {
      celType: "ValueCel", v: next,
      metadata: {
        key: k, segment: "supabase", name: `${project}.${table}.rev`,
        description: `Revision counter for Supabase table "${table}" (project "${project}"). Bumped on local writes AND realtime pushes. Reference it in a select formula to re-fire on change.`,
      },
    });
  }
};

const parsePayload = (payload: unknown): Record<string, unknown> =>
  (typeof payload === "string" ? JSON.parse(payload) : (payload ?? {})) as Record<string, unknown>;

const supabaseData: Fn = (async (state: State, op: unknown, project: unknown, payload: unknown): Promise<unknown> => {
  const proj = String(project ?? "default");
  const o = String(op ?? "");
  try {
    const p = parsePayload(payload);
    const table = String(p.table ?? "");

    if (o === "select") {
      const q = String(p.query ?? "select=*");
      const r = await rest(state, proj, "GET", `${table}?${q}`);
      return r.ok ? r.json : `(supabase.select: ${errOf(r)})`;
    }
    if (o === "insert") {
      const r = await rest(state, proj, "POST", table, p.rows ?? p.row, "return=representation");
      if (!r.ok) return `(supabase.insert: ${errOf(r)})`;
      await bumpRev(state, proj, table);
      return r.json;
    }
    if (o === "update") {
      const r = await rest(state, proj, "PATCH", `${table}?${String(p.match ?? "")}`, p.values, "return=representation");
      if (!r.ok) return `(supabase.update: ${errOf(r)})`;
      await bumpRev(state, proj, table);
      return r.json;
    }
    if (o === "delete") {
      const r = await rest(state, proj, "DELETE", `${table}?${String(p.match ?? "")}`, undefined, "return=representation");
      if (!r.ok) return `(supabase.delete: ${errOf(r)})`;
      await bumpRev(state, proj, table);
      return r.json;
    }
    if (o === "rpc") {
      const r = await rest(state, proj, "POST", `rpc/${String(p.fn ?? "")}`, p.args ?? {});
      return r.ok ? r.json : `(supabase.rpc: ${errOf(r)})`;
    }
    return `(unknown supabase.data op: ${o})`;
  } catch (e) {
    return `(supabase.data: ${(e as Error)?.message ?? String(e)})`;
  }
}) as Fn;

// supabase.realtime(state, op, project, payload) — subscribe a table to live
// postgres_changes; each push bumps sb.<project>.<table>.rev (the same cel local
// writes bump), so subscribed select formulas refresh with no extra wiring.
const supabaseRealtime: Fn = (async (state: State, op: unknown, project: unknown, payload: unknown): Promise<unknown> => {
  const proj = String(project ?? "default");
  const o = String(op ?? "");
  try {
    const p = parsePayload(payload);
    const schema = String(p.schema ?? "public");
    const table = String(p.table ?? "");
    if (o === "subscribe") {
      const { url, anonKey } = readConfig(state, proj);
      const token = sessionAccess(state, proj);
      return await subscribe({
        url, apikey: anonKey, token, project: proj, schema, table,
        onChange: () => { void bumpRev(state, proj, table); },
      });
    }
    if (o === "unsubscribe") return unsubscribe(proj, schema, table);
    if (o === "status") return realtimeStatus(proj);
    return `(unknown supabase.realtime op: ${o})`;
  } catch (e) {
    return `(supabase.realtime: ${(e as Error)?.message ?? String(e)})`;
  }
}) as Fn;

// supabase.invoke(state, project, fn, body) — call a Supabase EDGE FUNCTION
// (/functions/v1/<fn>) with the same auth as REST: apikey + the user JWT resolved
// at the effect site (never a cel). The function holds any provider secret (e.g.
// the LLM key) SERVER-SIDE — it never reaches the browser. Returns the parsed JSON
// reply, or an { error } object on failure.
const invokeFn: Fn = (async (state: State, project: unknown, fn: unknown, body?: unknown): Promise<unknown> => {
  const proj = String(project ?? "default");
  const name_ = String(fn ?? "");
  if (!name_) return { error: "supabase.invoke: function name required" };
  try {
    const { url, anonKey } = readConfig(state, proj);
    const token = sessionAccess(state, proj);
    const headers: Record<string, string> = { apikey: anonKey, "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await globalThis.fetch(`${url}/functions/v1/${name_}`, {
      method: "POST", headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown; if (text) { try { json = JSON.parse(text); } catch { json = text; } }
    return res.ok ? json : { error: `supabase.invoke ${name_}: HTTP ${res.status}`, detail: json };
  } catch (e) {
    return { error: `supabase.invoke ${name_}: ${String((e as { message?: unknown })?.message ?? e)}` };
  }
}) as Fn;

// supabase.config(state, project, urlOrDict, anonkey?) — set the PUBLIC project
// config. Preferred: a DICT — supabase.config(state, 'default', {url, anonkey})
// writes the ONE sb.<project> cel sbConfig resolves first. Legacy: (url, anonkey)
// strings still write the two-cel form. These are public (the anon/publishable
// key is meant for the browser); the only secret — the user JWT — lives in the
// session store after supabase.auth signs in.
const configFn: Fn = (async (state: State, project: unknown, url: unknown, anonkey: unknown): Promise<string> => {
  const p = String(project ?? "default");
  const meta = (k: string) => ({ key: k, segment: "supabase", name: k.slice(3) });
  if (url && typeof url === "object" && !Array.isArray(url)) {
    const d = url as { url?: unknown; anonkey?: unknown; anonKey?: unknown; key?: unknown };
    const u = String(d.url ?? ""), k = String(d.anonkey ?? d.anonKey ?? d.key ?? "");
    await (resolveFn(state, "setCel") as Fn)(state, `sb.${p}`, { celType: "ValueCel", v: { url: u, anonkey: k }, metadata: { ...meta(`sb.${p}`), description: "the project's PUBLIC config as ONE dict {url, anonkey} — sbConfig resolves this cel first (the two-cel sb.<p>.url/.anonkey form is the fallback)." } });
    return `supabase.config: "${p}" → ${u || "(url unset)"} (dict cel sb.${p})`;
  }
  const batch: Record<string, unknown> = {};
  if (url != null && String(url)) batch[`sb.${p}.url`] = { celType: "ValueCel", v: String(url), metadata: meta(`sb.${p}.url`) };
  if (anonkey != null && String(anonkey)) batch[`sb.${p}.anonkey`] = { celType: "ValueCel", v: String(anonkey), metadata: meta(`sb.${p}.anonkey`) };
  if (Object.keys(batch).length) await (resolveFn(state, "setCelBatch") as Fn)(state, batch);
  return `supabase.config: "${p}" → ${String(url ?? "(url unset)")}`;
}) as Fn;

export const name = "supabase" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["supabase.data", supabaseData],
  ["supabase.realtime", supabaseRealtime],
  ["supabase.invoke", invokeFn],
  ["supabase.config", configFn],
]));
