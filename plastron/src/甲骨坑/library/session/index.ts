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
//     A fresh module (page reload) starts empty → tokens are session-only by
//     default (the secure default; cross-reload persistence is a later stage
//     that delegates bytes to seal/crypto, NOT a re-stored plaintext token).
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

// session.put(state, name, tokens) — store tokens + write the status cel.
const putFn: Fn = (async (state: State, name: unknown, tokens: unknown): Promise<string> => {
  const nm = String(name ?? "default");
  const t = coerce(tokens);
  store.set(nm, t);
  await writeStatus(state, nm, t);
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

// session.forget(state, name) — sign-out: drop tokens, flip the status cel.
const forgetFn: Fn = (async (state: State, name: unknown): Promise<string> => {
  const nm = String(name ?? "default");
  store.delete(nm);
  await writeStatus(state, nm, undefined);
  return `session: ${nm} cleared`;
}) as Fn;

export const name = "session" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["session.put", putFn],
  ["session.handle", handleFn],
  ["session.peek", peekFn],
  ["session.forget", forgetFn],
]));
