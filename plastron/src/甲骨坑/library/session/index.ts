import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn, secretHandle } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// session — the service-agnostic token store. Holds live auth tokens for any
// service (supabase-auth is the first tenant; github/stripe/… are future ones)
// and mints SecretHandles over them. This is the home the removed `vault` left
// open, rebuilt to the tier-boundary doctrine: the SECRET never becomes a cel
// value and never enters an archive.
//
// THE SPLIT (mirrors net/peer/seal module-state + the SecretHandle invariant):
//   - the access/refresh tokens live in a MODULE-SCOPE Map, never a cel value.
//     A fresh module (page reload) starts empty; cross-reload persistence is
//     the wallet-wrapped REFRESH-token sidecar below (never a plaintext token,
//     never the access token) — no wallet, or a locked one, stays session-only.
//   - session.handle mints a SecretHandle whose resolver closes over that Map;
//     it dehydrates to NAME-ONLY (kernel/dehydrate sanitizes it). Effect sites
//     (the supabase data verb) resolve() it at fetch time for the bearer.
//   - the only thing the GRAPH sees is a non-secret session.<name>.status cel,
//     so formulas react to sign-in/out without ever touching the token.
//
// Refresh (rotating the access token before exp) is a provider concern: the
// provider re-puts fresh tokens; the handle's resolver then returns the new
// value with NO cel churn (the cel value — the status — is stable). So a token
// rotation fires no cascade.
// ============================================================================

interface Tokens {
  access: string;
  refresh?: string;
  /** epoch seconds (or ms) at which `access` expires, if known. */
  exp?: number;
  /** non-secret descriptor the provider attaches (e.g. { email, userId }). */
  meta?: Record<string, unknown>;
}

// Module-scope live tokens — NEVER a cel value, NEVER dehydrated. Exactly the
// wallet/net/seal module-state pattern.
const store = new Map<string, Tokens>();

const statusKey = (name: string): string => `session.${name}.status`;

// ── the persistence sidecar (session-token-persistence.md) ──────────────────
// The REFRESH token only, ECDH-wrapped to the user's own wallet key
// (keystore.wrap) and written to OPFS — so unlocking the wallet IS logging in
// to plastron: session.restore unwraps the sidecars back into the Map and the
// providers re-mint access tokens via their refresh op. The access token never
// touches disk; no wallet (or a locked one) → no sidecar → today's
// session-only behavior. keystore.wrap survives passcode changes and unwrap
// consults retired-key history, so reshuffles don't orphan sessions.
const SIDE_DIR = "/plastron/session";
const sidePath = (name: string): string => `${SIDE_DIR}/${name}.tok`;
const utf8b64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64utf8 = (b64: string): string => {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};
interface Sidecar { v: 1; name: string; env: string; pub: string }

const persistSidecar = async (state: State, name: string, t: Tokens): Promise<boolean> => {
  if (!t.refresh) return false;
  const wrap = resolveFn(state, "keystore.wrap") as Fn | undefined;
  const mkdir = resolveFn(state, "fs.mkdir") as Fn | undefined;
  const write = resolveFn(state, "fs.writeText") as Fn | undefined;
  if (!wrap || !mkdir || !write) return false;                       // keystore / file-store not loaded
  try {
    const r = await wrap(state, utf8b64(JSON.stringify({ refresh: t.refresh, meta: t.meta ?? null }))) as { ok?: boolean; env?: string; pub?: string };
    if (!r?.ok || !r.env || !r.pub) return false;                    // wallet locked/absent → session-only
    await Promise.resolve(mkdir("/plastron")).catch(() => { /* exists */ });
    await Promise.resolve(mkdir(SIDE_DIR)).catch(() => { /* exists */ });
    await write(sidePath(name), JSON.stringify({ v: 1, name, env: r.env, pub: r.pub } as Sidecar));
    return true;
  } catch { return false; }                                          // file:// / no OPFS → session-only
};

const dropSidecar = async (state: State, name: string): Promise<void> => {
  const del = resolveFn(state, "fs.delete") as Fn | undefined;
  if (del) await Promise.resolve(del(sidePath(name))).catch(() => { /* absent */ });
};

// session.restore(state) — after keystore.unlock: unwrap every sidecar back
// into the Map (refresh token only — no status write, no access claim) and
// return the restored names; the CALLER fans out to each provider's refresh op
// (session stays service-agnostic). A name already live in the Map is skipped.
const restoreFn: Fn = (async (state: State): Promise<string[]> => {
  const ls = resolveFn(state, "fs.list") as Fn | undefined;
  const read = resolveFn(state, "fs.readText") as Fn | undefined;
  const unwrap = resolveFn(state, "keystore.unwrap") as Fn | undefined;
  if (!ls || !read || !unwrap) return [];
  let entries: string[] = [];
  try { entries = await ls(SIDE_DIR) as string[]; } catch { return []; }   // fs.list → plain names
  const restored: string[] = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const file = String(e ?? "");
    if (!file.endsWith(".tok")) continue;
    try {
      const sc = JSON.parse(String(await read(`${SIDE_DIR}/${file}`))) as Sidecar;
      if (!sc?.name || !sc.env || !sc.pub || store.has(sc.name)) continue;
      const r = await unwrap(state, sc.env, sc.pub) as { ok?: boolean; dataKey?: string };
      if (!r?.ok || !r.dataKey) continue;                            // wrong wallet / tampered — leave the file, stay signed out
      const { refresh, meta } = JSON.parse(b64utf8(r.dataKey)) as { refresh?: string; meta?: Tokens["meta"] | null };
      if (!refresh) continue;
      store.set(sc.name, { access: "", refresh, ...(meta ? { meta } : {}) });
      restored.push(sc.name);
    } catch { /* unreadable sidecar — skip */ }
  }
  return restored;
}) as Fn;

// session.persist(state) — re-wrap every LIVE session under the (now-unlocked)
// wallet: covers sign-ins that happened while the wallet was locked/absent.
const persistFn: Fn = (async (state: State): Promise<string[]> => {
  const done: string[] = [];
  for (const [nm, t] of store) if (await persistSidecar(state, nm, t)) done.push(nm);
  return done;
}) as Fn;

// non-secret summary the graph reacts to.
const statusOf = (t: Tokens | undefined): Record<string, unknown> =>
  t ? { status: "active", exp: t.exp ?? null, hasRefresh: !!t.refresh, ...(t.meta ? { meta: t.meta } : {}) }
    : { status: "none" };

// create-or-update the reactive status cel (ensure/bump split, like sqlite.rev).
const writeStatus = async (state: State, name: string, t: Tokens | undefined): Promise<void> => {
  const k = statusKey(name);
  const status = statusOf(t);
  if (state.cels.get(k)) {
    await (resolveFn(state, "setValue") as Fn)(state, k, status);
  } else {
    await (resolveFn(state, "setCel") as Fn)(state, k, {
      celType: "ValueCel", v: status,
      metadata: {
        key: k, segment: "session", name: `${name}.status`,
        description: `Reactive session status for "${name}" — { status: active|none, exp }. Non-secret: formulas reference this to react to sign-in/out. The token itself lives behind a SecretHandle (session.handle), never in a cel.`,
      },
    });
  }
};

const coerce = (tokens: unknown): Tokens => {
  const t = (typeof tokens === "string" ? JSON.parse(tokens) : tokens) as Partial<Tokens>;
  if (!t || typeof t.access !== "string" || !t.access) throw new Error("session.put: tokens.access (string) is required");
  return { access: t.access, refresh: t.refresh, exp: t.exp, meta: t.meta };
};

// session.put(state, name, tokens) — store tokens + write the status cel, and
// (best-effort) persist the wallet-wrapped refresh sidecar.
const putFn: Fn = (async (state: State, name: unknown, tokens: unknown): Promise<string> => {
  const nm = String(name ?? "default");
  const t = coerce(tokens);
  store.set(nm, t);
  await writeStatus(state, nm, t);
  await persistSidecar(state, nm, t);
  return `session: ${nm} active`;
}) as Fn;

// session.handle(state, name, kind?) — SecretHandle over the access (default) or
// refresh token. The resolver reads the LIVE store, so a later put (refresh) is
// reflected without re-minting. The refresh handle is what an auth provider
// resolves to rotate the access token.
const handleFn: Fn = ((_state: State, name: unknown, kind?: unknown) => {
  const nm = String(name ?? "default");
  const k = String(kind ?? "access") === "refresh" ? "refresh" : "access";
  const hname = k === "refresh" ? `session.${nm}.refresh` : `session.${nm}`;
  return secretHandle(hname, () => store.get(nm)?.[k]);
}) as Fn;

// session.peek(state, name) — non-secret status snapshot (mirrors the cel).
const peekFn: Fn = ((_state: State, name: unknown) => {
  const nm = String(name ?? "default");
  return statusOf(store.get(nm));
}) as Fn;

// session.forget(state, name) — sign-out: drop tokens, flip the status cel,
// delete the persisted sidecar (a sign-out is a sign-out everywhere).
const forgetFn: Fn = (async (state: State, name: unknown): Promise<string> => {
  const nm = String(name ?? "default");
  store.delete(nm);
  await writeStatus(state, nm, undefined);
  await dropSidecar(state, nm);
  return `session: ${nm} cleared`;
}) as Fn;

export const name = "session" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["session.put", putFn],
  ["session.handle", handleFn],
  ["session.peek", peekFn],
  ["session.forget", forgetFn],
  ["session.restore", restoreFn],
  ["session.persist", persistFn],
]));
