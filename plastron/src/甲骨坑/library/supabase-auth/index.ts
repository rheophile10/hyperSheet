import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// supabase-auth — a thin GoTrue provider on top of the service-agnostic session
// store. It knows how to OBTAIN and ROTATE a Supabase token (the GoTrue REST
// endpoints) and hands the tokens to session.put; it keeps NO token state of its
// own. The graph only ever sees the non-secret sb.<project>.auth status cel.
//
// Config is data (the "config is cels" rule): the project URL + anon/publishable
// key are PUBLIC and live in plain cels sb.<project>.url / sb.<project>.anonkey
// (seeded by a genesis verb or the user). They are NOT secrets — the only secret
// is the per-user JWT, which lives in the session store behind a SecretHandle.
//
// IO goes through globalThis.fetch, which the net gate (if the host loaded it)
// wraps with the allowlist + provenance log. The host should net.allowlist the
// project URL. No service_role key is ever used here — it has no in-page home.
// ============================================================================

interface GoTrueTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  user?: { id?: string; email?: string };
}

const sessName = (project: string): string => `supabase.${project}`;
const authKey = (project: string): string => `sb.${project}.auth`;

// read the public config cels for a project (throws → caught → graceful string).
const readConfig = (state: State, project: string): { url: string; anonKey: string } => {
  const url = state.cels.get(`sb.${project}.url`)?.v;
  const anonKey = state.cels.get(`sb.${project}.anonkey`)?.v;
  if (typeof url !== "string" || !url) throw new Error(`missing sb.${project}.url cel (set the project URL)`);
  if (typeof anonKey !== "string" || !anonKey) throw new Error(`missing sb.${project}.anonkey cel (set the publishable key)`);
  return { url: url.replace(/\/+$/, ""), anonKey };
};

// create-or-update the reactive non-secret auth status cel.
const writeAuth = async (state: State, project: string, status: Record<string, unknown>): Promise<void> => {
  const k = authKey(project);
  if (state.cels.get(k)) {
    await (resolveFn(state, "setValue") as Fn)(state, k, status);
  } else {
    await (resolveFn(state, "setCel") as Fn)(state, k, {
      celType: "ValueCel", v: status,
      metadata: {
        key: k, segment: "supabase-auth", name: `${project}.auth`,
        description: `Reactive Supabase auth status for "${project}" — { status: signed-in|signed-out|otp-sent|error, email, userId }. Non-secret: the JWT lives in the session store behind a SecretHandle. Formulas reference this to react to sign-in/out.`,
      },
    });
  }
};

interface PostResult { ok: boolean; status: number; json: Record<string, unknown> }
const post = async (url: string, anonKey: string, body: unknown, bearer?: string): Promise<PostResult> => {
  const headers: Record<string, string> = { apikey: anonKey, "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await globalThis.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* empty/no-body */ }
  return { ok: res.ok, status: res.status, json };
};

const errOf = (r: PostResult): string =>
  String(r.json.msg ?? r.json.error_description ?? r.json.error ?? r.json.code ?? `HTTP ${r.status}`);

// push fresh tokens into the session store + flip the status cel to signed-in.
const applyTokens = async (state: State, project: string, t: GoTrueTokens): Promise<void> => {
  const user = t.user ?? {};
  const exp = t.expires_at ?? (t.expires_in ? Math.floor(Date.now() / 1000) + t.expires_in : undefined);
  await (resolveFn(state, "session.put") as Fn)(state, sessName(project), {
    access: t.access_token, refresh: t.refresh_token, exp, meta: { email: user.email, userId: user.id },
  });
  await writeAuth(state, project, { status: "signed-in", email: user.email, userId: user.id });
};

const parsePayload = (payload: unknown): Record<string, unknown> =>
  (typeof payload === "string" ? JSON.parse(payload) : (payload ?? {})) as Record<string, unknown>;

const supabaseAuth: Fn = (async (state: State, op: unknown, project: unknown, payload: unknown): Promise<string> => {
  const proj = String(project ?? "default");
  const o = String(op ?? "");
  try {
    const { url, anonKey } = readConfig(state, proj);

    if (o === "signin") {
      const p = parsePayload(payload);
      const r = await post(`${url}/auth/v1/token?grant_type=password`, anonKey, { email: p.email, password: p.password });
      if (!r.ok) { const m = errOf(r); await writeAuth(state, proj, { status: "error", error: m }); return `supabase.auth: sign-in failed — ${m}`; }
      await applyTokens(state, proj, r.json as GoTrueTokens);
      return `supabase.auth: ${proj} signed in as ${(r.json as GoTrueTokens).user?.email}`;
    }

    if (o === "otp" || o === "magiclink") {
      const p = parsePayload(payload);
      const r = await post(`${url}/auth/v1/otp`, anonKey, { email: p.email, create_user: p.create_user ?? true });
      if (!r.ok) return `supabase.auth: otp failed — ${errOf(r)}`;
      await writeAuth(state, proj, { status: "otp-sent", email: p.email });
      return `supabase.auth: magic link / OTP sent to ${p.email}`;
    }

    if (o === "refresh") {
      const refresh = ((resolveFn(state, "session.handle") as Fn)(state, sessName(proj), "refresh") as { resolve(): string | undefined }).resolve();
      if (!refresh) return `supabase.auth: ${proj} has no refresh token (sign in first)`;
      const r = await post(`${url}/auth/v1/token?grant_type=refresh_token`, anonKey, { refresh_token: refresh });
      if (!r.ok) { const m = errOf(r); await writeAuth(state, proj, { status: "error", error: m }); return `supabase.auth: refresh failed — ${m}`; }
      await applyTokens(state, proj, r.json as GoTrueTokens);
      return `supabase.auth: ${proj} refreshed`;
    }

    if (o === "signout") {
      const access = ((resolveFn(state, "session.handle") as Fn)(state, sessName(proj)) as { resolve(): string | undefined }).resolve();
      if (access) { try { await post(`${url}/auth/v1/logout`, anonKey, {}, access); } catch { /* best-effort revoke */ } }
      await (resolveFn(state, "session.forget") as Fn)(state, sessName(proj));
      await writeAuth(state, proj, { status: "signed-out" });
      return `supabase.auth: ${proj} signed out`;
    }

    return `(unknown supabase.auth op: ${o})`;
  } catch (e) {
    return `supabase.auth: ${(e as Error)?.message ?? String(e)}`;
  }
}) as Fn;

export const name = "supabase-auth" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["supabase.auth", supabaseAuth],
]));
