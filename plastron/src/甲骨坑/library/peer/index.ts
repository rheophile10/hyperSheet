import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// peer — WebRTC peer transport, two browsers share a live sheet (p2p-peer-
// transport.md). A LIBRARY governance segment, sibling of `net`: a remote peer
// is treated as exactly as untrusted as a CDN script or a pasted formula. The
// SECURITY CORE is peer.apply — the four-rule gate on every inbound message:
//   1. setValue-ONLY (no structure: no setCel/formula/celType/lambda).
//   2. namespace ALLOWLIST (peerallow; default-deny).
//   3. 函 / executable-value QUARANTINE (JSON strips fns; we reject JSON-SHAPED
//      executables — {genesis}/{defn}/vnodes/{__mount}/cel specs/secrets).
//   4. no SecretHandle exfil.
// The transport is PLUGGABLE (peer.connect) so the security core tests against a
// fake channel and the real RTCDataChannel drops in (stage 2). The kernel stays
// out — WebRTC is a host capability, governed here, exactly like the net gate.
// ============================================================================

interface Transport { send: (msg: string) => void }
let transport: Transport | null = null;       // null until a peer connects
let applying = false;                         // true while applying an INBOUND write — suppresses the echo re-broadcast (A→B→A loop guard)

// Module-scope governance state (mirrors net's allowlist/log pattern).
let allowlist: string[] = ["shared."];        // shared namespaces; default-deny outside
interface LogRow { dir: "in" | "out"; k: string; d: string }
const log: LogRow[] = [];
const note = (dir: "in" | "out", k: string, d: string): void => { log.push({ dir, k, d }); if (log.length > 500) log.shift(); };

// size caps — a malicious peer can't memory-DoS via a giant key/value or frame.
const MAX_KEY = 256, MAX_VAL = 64 * 1024, MAX_MSG = 256 * 1024;
const jsize = (v: unknown): number => { try { return JSON.stringify(v ?? null).length; } catch { return Infinity; } };

// rate limit — a per-State token bucket (200 burst, 100/s). Per-State (WeakMap)
// so it's isolated: one connection per page in practice, and test states don't
// share a bucket. Defends against a flood of small in-cap messages.
const RATE = 100, BURST = 200;
const buckets = new WeakMap<State, { tokens: number; last: number }>();
const rateOk = (state: State, now: number): boolean => {
  let b = buckets.get(state); if (!b) { b = { tokens: BURST, last: now }; buckets.set(state, b); }
  b.tokens = Math.min(BURST, b.tokens + (now - b.last) / 1000 * RATE); b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1; return true;
};

const inAllow = (k: string): boolean => allowlist.some((p) => k.startsWith(p));
const looksSecret = (v: unknown): boolean => !!v && typeof v === "object" && ((v as { __secretHandle?: unknown }).__secretHandle !== undefined || (v as { secretHandle?: unknown }).secretHandle !== undefined);
const isSecretKey = (state: State, k: string): boolean => looksSecret(state.cels.get(k)?.v);

// QUARANTINE — a remote VALUE the graph would interpret as executable or
// structure. JSON strips real functions, so the risk is JSON-SHAPED executables;
// reject them (and deep-scan, so they can't hide nested in a data object).
const isQuarantined = (v: unknown): boolean => {
  if (v == null || typeof v !== "object") return false;          // primitives are data
  if (Array.isArray(v)) return v.some(isQuarantined);
  const o = v as Record<string, unknown>;
  if (o.genesis === true || o.defn === true) return true;        // structure request
  if (o.__secretHandle !== undefined || o.secretHandle !== undefined) return true; // secret shape
  if (o.__mount !== undefined) return true;                      // placement (may carry a live vnode)
  if (o.type === "el" || o.type === "text") return true;         // a raw vnode (carries events)
  if (o.celType !== undefined || o._fn !== undefined || o.kind === "lambda") return true; // cel/lambda spec
  return Object.values(o).some(isQuarantined);                   // nested executable
};

// peer.apply — THE SECURITY CORE. The transport's onmessage dispatches here.
// Returns the decision (for the log + tests).
const applyFn: Fn = (async (state: State, msg: unknown): Promise<string> => {
  const m = msg as { t?: unknown; k?: unknown; v?: unknown };
  let d: string;
  if (m?.t !== "set" || typeof m.k !== "string") d = "dropped:tier";          // (1) setValue-only
  else if (!inAllow(m.k)) d = "dropped:namespace";                            // (2) allowlist
  else if (isSecretKey(state, m.k)) d = "dropped:secret";                     // (4) no exfil into a secret cel
  else if (m.k.length > MAX_KEY || jsize(m.v) > MAX_VAL) d = "dropped:size";  // (5) size cap (DoS)
  else if (!rateOk(state, Date.now())) d = "dropped:rate";                   // (6) rate limit (flood)
  else if (isQuarantined(m.v)) d = "quarantined";                            // (3) 函 quarantine
  else {
    // Data plane only: write an EXISTING ValueCel, or create a fresh ValueCel
    // for a new shared key. We build the metadata ourselves — the peer provides
    // only (key, value), never a celType/formula/lambda/metadata. A remote can
    // hold a non-value cel hostage? No: if the local cel isn't a ValueCel we
    // refuse (structure stays local).
    const existing = state.cels.get(m.k);
    if (existing && existing.celType !== "ValueCel") d = "dropped:tier";
    else {
      applying = true;   // suppress the echo: this write must NOT re-broadcast
      try {
        if (existing) await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, m.k, m.v));
        else await Promise.resolve((resolveFn(state, "setCel") as Fn)(state, m.k, { celType: "ValueCel", v: m.v, metadata: { key: m.k, segment: "peer" } }));
      } finally { applying = false; }
      d = "applied";
    }
  }
  note("in", typeof m?.k === "string" ? m.k : "", d);
  return d;
}) as Fn;

// peer.broadcast — outbound: filter changed keys to the shared namespace, ship
// each cel's VALUE (never structure, never an executable shape, never a secret).
const broadcastFn: Fn = ((state: State, changed: unknown): number => {
  if (!transport || applying) return 0;       // no peer, or mid-inbound-apply (echo guard)
  const keys = Array.isArray(changed) ? changed.map(String) : [];
  let n = 0;
  for (const k of keys) {
    if (!inAllow(k) || isSecretKey(state, k)) continue;
    const v = state.cels.get(k)?.v;
    if (isQuarantined(v)) continue;                 // never ship executable shapes
    transport.send(JSON.stringify({ t: "set", k, v }));
    note("out", k, "sent"); n++;
  }
  return n;
}) as Fn;

// peer.connect — install a transport (a fake {send} in tests; an RTCDataChannel
// wrapper in stage 2). Returns a label.
const connectFn: Fn = ((_state: State, t: unknown): string => {
  transport = (t && typeof (t as Transport).send === "function") ? (t as Transport) : null;
  return transport ? "peer: connected" : "peer: disconnected";
}) as Fn;

// peersend — explicit share (demo): setValue locally + broadcast. Stage 3 makes
// this automatic by riding the post-cascade seam.
const sendFn: Fn = (async (state: State, key: unknown, value: unknown): Promise<unknown> => {
  const k = String(key);
  const existing = state.cels.get(k);
  if (existing) await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, k, value));
  else { const seg = k.includes(".") ? k.slice(0, k.indexOf(".")) : "peer"; await Promise.resolve((resolveFn(state, "setCel") as Fn)(state, k, { celType: "ValueCel", v: value, metadata: { key: k, segment: seg } })); }
  broadcastFn(state, [k]);
  return value;
}) as Fn;

// peerallow — the shared-namespace allowlist, surfaced + edited (mirrors netallow).
const allowFn: Fn = ((...prefixes: unknown[]): string => {
  const ps = prefixes.map((p) => String(p ?? "")).filter(Boolean);
  if (ps.length === 1 && ps[0] === "*") allowlist = [];          // "*" → deny all (explicit)
  else if (ps.length) allowlist = ps;
  return "peer.allow (shared namespaces):\n" + (allowlist.length ? allowlist.map((p) => `  ✓ ${p}`).join("\n") : "  (none — all remote writes dropped)");
}) as Fn;

const logFn: Fn = ((): string => {
  if (!log.length) return "(peer: no traffic yet)";
  return log.map((e) => `${e.dir === "in" ? "←" : "→"} ${e.k} [${e.d}]`).join("\n");
}) as Fn;

// ── WebRTC transport + manual signaling (stage 2) ────────────────────────────
// Browser-only. In Bun (no RTCPeerConnection) the verbs no-op so the suite is
// unaffected; a two-page Playwright e2e brokers the offer/answer + asserts a
// setValue propagates A→B through the security gate. ICE: host candidates only
// (localhost), gathered non-trickle into the SDP, so no STUN/TURN needed.
interface RtcChan { send(m: string): void; onopen: (() => void) | null; onmessage: ((e: { data: string }) => void) | null }
interface RtcConn {
  createDataChannel(label: string): RtcChan;
  createOffer(): Promise<unknown>; createAnswer(): Promise<unknown>;
  setLocalDescription(d: unknown): Promise<void>; setRemoteDescription(d: unknown): Promise<void>;
  localDescription: unknown; iceGatheringState: string;
  addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void;
  ondatachannel: ((e: { channel: RtcChan }) => void) | null;
}
let pc: RtcConn | null = null;
const rtc = (): (new (cfg: unknown) => RtcConn) | undefined => (globalThis as { RTCPeerConnection?: new (cfg: unknown) => RtcConn }).RTCPeerConnection;

const wire = (state: State, ch: RtcChan): void => {
  ch.onopen = () => { transport = { send: (m: string) => ch.send(m) }; (globalThis as { __peerOpen?: boolean }).__peerOpen = true; };
  ch.onmessage = (e) => { if (typeof e.data !== "string" || e.data.length > MAX_MSG) { note("in", "?", "dropped:size"); return; } try { void applyFn(state, JSON.parse(e.data)); } catch { /* malformed frame */ } };
};
const iceDone = (conn: RtcConn): Promise<void> => new Promise<void>((res) => {
  if (conn.iceGatheringState === "complete") return res();
  const check = (): void => { if (conn.iceGatheringState === "complete") { conn.removeEventListener("icegatheringstatechange", check); res(); } };
  conn.addEventListener("icegatheringstatechange", check);
  setTimeout(res, 3000);                                  // fallback if gathering stalls
});

// peerOffer() — mint an SDP offer (copy it to the other browser).
const offerFn: Fn = (async (state: State): Promise<string> => {
  const R = rtc(); if (!R) return "(peer: no WebRTC here)";
  pc = new R({ iceServers: [] });
  wire(state, pc.createDataChannel("plastron"));
  await pc.setLocalDescription(await pc.createOffer());
  await iceDone(pc);
  return JSON.stringify(pc.localDescription);
}) as Fn;

// peerAnswer(offer) — accept an offer, return the answer (copy back).
const answerFn: Fn = (async (state: State, offer: unknown): Promise<string> => {
  const R = rtc(); if (!R) return "(peer: no WebRTC here)";
  pc = new R({ iceServers: [] });
  pc.ondatachannel = (e) => wire(state, e.channel);
  await pc.setRemoteDescription(JSON.parse(String(offer)));
  await pc.setLocalDescription(await pc.createAnswer());
  await iceDone(pc);
  return JSON.stringify(pc.localDescription);
}) as Fn;

// peerAccept(answer) — finalize on the offerer side; the channel opens.
const acceptFn: Fn = (async (_state: State, answer: unknown): Promise<string> => {
  if (!pc) return "(peer: no pending connection)";
  await pc.setRemoteDescription(JSON.parse(String(answer)));
  return "peer: accepted";
}) as Fn;

// peerJoin(room, relayUrl) — automatic signaling via a relay (no SDP copy/paste).
// Connect to the room; when a peer arrives the existing member OFFERS, the
// newcomer ANSWERS — all brokered over the WebSocket (offer/answer carry
// non-trickle SDP, so no ICE relay). 2-peer rooms (v1). Browser-only (WebRTC).
interface WSish { send(m: string): void; onopen: (() => void) | null; onmessage: ((e: { data: string }) => void) | null }
const joinFn: Fn = ((state: State, room: unknown, relayUrl: unknown): string => {
  const WS = (globalThis as { WebSocket?: new (u: string) => WSish }).WebSocket;
  if (!WS) return "(peer: no WebSocket here)";
  const r = String(room ?? "plastron");
  const ws = new WS(String(relayUrl ?? "ws://localhost:8787"));
  ws.onopen = () => ws.send(JSON.stringify({ t: "join", room: r }));
  ws.onmessage = (e) => {
    let m: { t?: string; sdp?: string };
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === "peer-joined") void (offerFn as (s: State) => Promise<string>)(state).then((sdp) => ws.send(JSON.stringify({ t: "offer", sdp })));
    else if (m.t === "offer") void (answerFn as (s: State, o: unknown) => Promise<string>)(state, m.sdp).then((sdp) => ws.send(JSON.stringify({ t: "answer", sdp })));
    else if (m.t === "answer") void (acceptFn as (s: State, a: unknown) => Promise<string>)(state, m.sdp);
  };
  return `peer: joining "${r}"`;
}) as Fn;

export const name = "peer" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["peer.apply", applyFn],
  ["peer.broadcast", broadcastFn],
  ["cascade.observe", broadcastFn],
  ["peer.connect", connectFn],
  ["peersend", sendFn],
  ["peerallow", allowFn],
  ["peerlog", logFn],
  ["peerOffer", offerFn],
  ["peerAnswer", answerFn],
  ["peerAccept", acceptFn],
  ["peerjoin", joinFn],
]));
