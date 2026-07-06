import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import { sbConfig } from "../supabase/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// supabase-storage — Supabase Storage (buckets): the cloud twin of the
// file-store/OPFS library. Same shape (upload/download/list/remove over a
// bucket) but against the Storage REST API, RLS-scoped by the session JWT
// resolved at the effect site. Config is the same public sb.<project>.url /
// sb.<project>.anonkey cels. No service_role — bucket administration that needs
// it lives outside the page.
// ============================================================================

const sessName = (project: string): string => `supabase.${project}`;

const readConfig = (state: State, project: string): { url: string; anonKey: string } => {
  const cfg = sbConfig(state, project);
  if (!cfg) throw new Error(`missing supabase config — set the sb.${project} dict cel ({"url":"…","anonkey":"…"}) or the sb.${project}.url / .anonkey cels`);
  return cfg;
};

const sessionAccess = (state: State, project: string): string | undefined => {
  if (!state.cels.get("session.handle")) return undefined;
  try {
    return ((resolveFn(state, "session.handle") as Fn)(state, sessName(project)) as { resolve(): string | undefined }).resolve();
  } catch { return undefined; }
};

const parsePayload = (payload: unknown): Record<string, unknown> =>
  (typeof payload === "string" ? JSON.parse(payload) : (payload ?? {})) as Record<string, unknown>;

const errOf = (status: number, json: unknown): string => {
  const j = json as { message?: string; error?: string } | undefined;
  return String(j?.message ?? j?.error ?? `HTTP ${status}`);
};

const supabaseStorage: Fn = (async (state: State, op: unknown, project: unknown, payload: unknown): Promise<unknown> => {
  const proj = String(project ?? "default");
  const o = String(op ?? "");
  try {
    const { url, anonKey } = readConfig(state, proj);
    const token = sessionAccess(state, proj);
    const base = `${url}/storage/v1`;
    const headers = (extra: Record<string, string> = {}): Record<string, string> => {
      const h: Record<string, string> = { apikey: anonKey, ...extra };
      if (token) h.Authorization = `Bearer ${token}`;
      return h;
    };
    const p = parsePayload(payload);
    const bucket = String(p.bucket ?? "");
    const objectPath = (path: string): string => `${base}/object/${bucket}/${encodeURI(path)}`;

    if (o === "upload") {
      const body = typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? "");
      const res = await globalThis.fetch(objectPath(String(p.path ?? "")), {
        method: "POST",
        headers: headers({ "Content-Type": String(p.contentType ?? "text/plain"), "x-upsert": p.upsert === false ? "false" : "true" }),
        body,
      });
      const j = await res.json().catch(() => ({}));
      return res.ok ? j : `(supabase.storage.upload: ${errOf(res.status, j)})`;
    }
    if (o === "download") {
      const res = await globalThis.fetch(objectPath(String(p.path ?? "")), { headers: headers() });
      if (!res.ok) return `(supabase.storage.download: HTTP ${res.status})`;
      return await res.text();
    }
    if (o === "list") {
      const res = await globalThis.fetch(`${base}/object/list/${bucket}`, {
        method: "POST", headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ prefix: String(p.prefix ?? ""), limit: Number(p.limit ?? 100), offset: Number(p.offset ?? 0) }),
      });
      const j = await res.json().catch(() => []);
      return res.ok ? j : `(supabase.storage.list: ${errOf(res.status, j)})`;
    }
    if (o === "remove") {
      const res = await globalThis.fetch(objectPath(String(p.path ?? "")), { method: "DELETE", headers: headers() });
      const j = await res.json().catch(() => ({}));
      return res.ok ? (j ?? "ok") : `(supabase.storage.remove: ${errOf(res.status, j)})`;
    }
    if (o === "createBucket") {
      const res = await globalThis.fetch(`${base}/bucket`, {
        method: "POST", headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ id: bucket, name: bucket, public: !!p.public }),
      });
      const j = await res.json().catch(() => ({}));
      return res.ok ? j : `(supabase.storage.createBucket: ${errOf(res.status, j)})`;
    }
    if (o === "listBuckets") {
      const res = await globalThis.fetch(`${base}/bucket`, { headers: headers() });
      const j = await res.json().catch(() => []);
      return res.ok ? j : `(supabase.storage.listBuckets: ${errOf(res.status, j)})`;
    }
    return `(unknown supabase.storage op: ${o})`;
  } catch (e) {
    return `(supabase.storage: ${(e as Error)?.message ?? String(e)})`;
  }
}) as Fn;

export const name = "supabase-storage" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["supabase.storage", supabaseStorage],
]));
