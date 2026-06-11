import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns, getCurrentCel } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// net — the network governance gate (network-governance.md, accepted). The
// kernel owns the STATELESS `fetch` door (kernel/fetch.ts); this LIBRARY
// segment owns the STATEFUL governance: a single wrapped network path, the
// traffic log, and the host allowlist — all surfaced as cell values.
//
// Universal in-page gate: on load we wrap globalThis.fetch so EVERY network
// call (this segment's =fetch, the kernel door, and native verbs like claude/
// grok that call fetch directly) is policy-checked + logged. This is a SOFT
// gate — determined host-context code can still grab the original — so it is
// AUDIT + ergonomics; the HARD enforcement is CSP connect-src (browser) and
// the wasm sandbox (formulas have no fetch at all). See the design's layers.
// ============================================================================

interface LogEntry { seq: number; url: string; method: string; status: number; ok: boolean; via: "fetch" | "blocked" | "error"; by?: string; }

// Module-scope governance state (runtime only — never a cel value, never
// dehydrated). Surfaced into the graph through the verbs below.
const log: LogEntry[] = [];
let allowlist: string[] | null = null; // null = allow all (dev default)
let seq = 0;

const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return url.slice(0, 60); } };
const allowed = (url: string): boolean => !allowlist || allowlist.some((h) => url.startsWith(h) || hostOf(url) === h || hostOf(url).endsWith("." + h));

// ── the gate: wrap globalThis.fetch once, idempotently ──────────────────────
interface Gatedish { __netGated?: boolean }
const installGate = (): void => {
  const g = globalThis as { fetch?: typeof fetch };
  const original = g.fetch?.bind(g);
  if (!original || (g.fetch as unknown as Gatedish).__netGated) return;
  const gated = (async (input: unknown, init?: unknown): Promise<Response> => {
    const url = String(typeof input === "string" ? input : (input as { url?: unknown })?.url ?? input);
    const method = String((init as { method?: unknown })?.method ?? "GET").toUpperCase();
    const by = getCurrentCel();  // provenance: which cel caused this request
    if (!allowed(url)) {
      log.push({ seq: seq++, url, method, status: 0, ok: false, via: "blocked", by });
      throw new Error(`net: blocked ${method} ${hostOf(url)} — not in net.allowlist (=netallow to permit)`);
    }
    try {
      const res = await original(input as Parameters<typeof fetch>[0], init as RequestInit | undefined);
      log.push({ seq: seq++, url, method, status: res.status, ok: res.ok, via: "fetch", by });
      return res;
    } catch (e) {
      log.push({ seq: seq++, url, method, status: -1, ok: false, via: "error", by });
      throw e;
    }
  }) as unknown as typeof fetch & Gatedish;
  gated.__netGated = true;
  g.fetch = gated;
};
installGate();

// ── verbs (surface the gate's state as cell values) ─────────────────────────

// =fetch(url [, method] [, body]) — the formula-callable network verb. Async;
// the kernel awaits it. Returns the response body text. Goes through the gate.
const fetchFn: Fn = (async (url: unknown, method?: unknown, body?: unknown): Promise<string> => {
  const u = String(url ?? "");
  if (!u) return "(fetch: pass a url)";
  const init: RequestInit = {};
  if (method != null && String(method)) init.method = String(method);
  if (body != null) init.body = String(body);
  const res = await (globalThis as { fetch: typeof fetch }).fetch(u, init);
  return await res.text();
}) as Fn;

// =netlog() — the wiretap, surfaced. Snapshot of all traffic through the gate.
// (v1 is a snapshot — re-evaluate to refresh; a reactive net.log buffer cel is
// the Layer-5/6 follow-up.)
const netlogFn: Fn = ((): string => {
  if (!log.length) return "(net: no traffic yet)";
  return log.map((e) => `#${e.seq} ${e.method} ${e.via === "blocked" ? "BLOCKED " : ""}${hostOf(e.url)}${e.via === "fetch" ? ` → ${e.status}` : e.via === "error" ? " → ERR" : ""}${e.by ? ` (${e.by})` : ""}`).join("\n");
}) as Fn;

// =netallow([host, …]) — the whitelist, surfaced + edited. No args → show the
// current policy. With args → DECLARE the allowlist as exactly those hosts
// (idempotent on re-eval). `=netallow()` with the list empty stays allow-all.
const netallowFn: Fn = ((...hosts: unknown[]): string => {
  const hs = hosts.map((h) => String(h ?? "")).filter(Boolean);
  if (hs.length === 1 && hs[0] === "*") allowlist = null;       // reset to allow-all
  else if (hs.length) allowlist = hs;
  if (allowlist === null) return "net.allowlist: (all hosts allowed — dev default)";
  return "net.allowlist:\n" + (allowlist.length ? allowlist.map((h) => `  ✓ ${h}`).join("\n") : "  (empty — all blocked)");
}) as Fn;

export const name = "net" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["fetch",    fetchFn],
  ["netlog",   netlogFn],
  ["netallow", netallowFn],
]));
