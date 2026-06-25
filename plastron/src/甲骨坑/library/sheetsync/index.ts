import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// sheetsync — the CRDT change pipeline (encrypted-collaborative-sheetapp).
//
// Phase 3 (loopback): every SOURCE edit becomes an authored, signed op appended
// to the segment's grow-only `crdt` diff-stack; the stack FOLDS back to the
// source cels.
//
// Phase 4 (connected): the SAME op is encrypted with a per-segment symmetric
// DATA KEY and put on a peer's WebRTC data channel; a remote replica decrypts,
// verifies the signature, gates on <seg>.writers, appends, and folds. Because
// the op-log is a state-based set-CRDT (crdt.append dedupes + sorts; crdt.resolve
// folds the SORTED set), any two replicas holding the same SET of layers converge
// — arrival order is irrelevant.
//
// SECRETS: the per-segment data key lives MODULE-SCOPE (DATAKEYS), never a cel,
// never archived. It is shared writer→writer by ECDH-wrapping it to the peer's
// ecdh pub (keystore.wrapTo) over the channel; the peer unwraps (unwrapFrom).
//
// INVARIANTS:
//   • SOURCES ONLY — the op-log carries a ValueCel's value / a FormulaCel's TEXT;
//     derived FormulaCel values are a local runCycle PROJECTION, never synced.
//   • GATE — an op applies only if its signature is valid AND the author is in
//     <seg>.writers (writableBy). A non-writer's op is dropped, locally or remote.
//   • One writer to the graph at a time — ops apply at the setCel → runCycle
//     boundary, never mid-cascade.
// ============================================================================

const R = (state: State, k: string, ...a: unknown[]): unknown => (resolveFn(state, k) as Fn)(...a);
const has = (state: State, k: string): boolean => { try { return typeof resolveFn(state, k) === "function"; } catch { return false; } };

// ── module-scope SECRETS + peer presence (never cels) ───────────────────────
const DATAKEYS = new Map<string, string>();                    // seg → base64 AES-256 data key (SECRET)
const PEERS = new Map<string, { ecdh: string }>();             // peer signPub → their ecdh pub (presence)

// ── the segment SOURCE string (the CRDT's folded value) ─────────────────────
// one "key\t{f|v}\t<source>" line per source cel, sorted by key. source = formula
// TEXT for a FormulaCel, JSON(value) for a ValueCel. Excludes the control cels
// (<seg>.crdt / .writers / .hash / .datakey) — those aren't user data.
const CONTROL = (seg: string) => new Set([`${seg}.crdt`, `${seg}.writers`, `${seg}.hash`, `${seg}.datakey`]);
const segString = (state: State, seg: string): string => {
  const prefix = `${seg}.`, control = CONTROL(seg), rows: string[] = [];
  for (const [k, cel] of state.cels) {
    if (!k.startsWith(prefix) || control.has(k)) continue;
    const src = cel.celType === "FormulaCel" ? "f\t" + String((cel as { f?: string }).f ?? "") : "v\t" + JSON.stringify(cel.v ?? null);
    rows.push(`${k}\t${src}`);
  }
  return rows.sort().join("\n");
};
// parse the folded string back into a cel batch (setCel specs).
const applyString = async (state: State, seg: string, text: string): Promise<void> => {
  const setCel = resolveFn(state, "setCel") as Fn;
  const want = new Map<string, { celType: string; v?: unknown; f?: string }>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [key, kind, ...rest] = line.split("\t");
    if (!key) continue;
    const body = rest.join("\t");
    want.set(key, kind === "f" ? { celType: "FormulaCel", f: body } : { celType: "ValueCel", v: JSON.parse(body) });
  }
  for (const [key, spec] of want) {
    const md = { key, segment: seg, name: key.slice(seg.length + 1), parser: spec.celType === "FormulaCel" ? "infix" : undefined };
    await setCel(state, key, spec.celType === "FormulaCel" ? { celType: "FormulaCel", f: spec.f, metadata: md } : { celType: "ValueCel", v: spec.v, metadata: md });
  }
};

const stackOf = (state: State, seg: string): unknown[] => { const v = state.cels.get(`${seg}.crdt`)?.v; return Array.isArray(v) ? v : []; };
const ensureHashSeg = async (state: State): Promise<void> => { const es = resolveFn(state, "ensureSegments") as Fn | undefined; if (es) await es(state, ["sheetkeys"]); };
const coerce = (s: string): unknown => { if (s === "") return ""; const n = Number(s); return Number.isFinite(n) && s.trim() !== "" ? n : s; };
const tryTx = (state: State, frame: unknown): boolean => has(state, "peer.tx") ? (R(state, "peer.tx", state, frame) as boolean) : false;

// ── applyOp — the RECEIVE half, shared by commit (loopback) + recv (remote) ──
// verify the signature, gate the author (writableBy), append to the grow-only
// stack, fold → source cels, runCycle, stamp the source hash. Idempotent: a
// duplicate op (same id) is a no-op via crdt.append's dedupe.
const applyOp = async (state: State, seg: string, op: Record<string, unknown>, sig: string, pub: string): Promise<{ ok: boolean; layers?: number; hash?: string; error?: string }> => {
  const writers = state.cels.get(`${seg}.writers`)?.v;
  const opStr = JSON.stringify(op);
  const sigOk = await (R(state, "crypto.verify", pub, opStr, sig) as Promise<boolean>);
  if (!sigOk) return { ok: false, error: "bad signature" };
  if (!(R(state, "writableBy", pub, writers) as boolean)) return { ok: false, error: "signer not a writer" };

  const stack = stackOf(state, seg);
  const nextStack = R(state, "crdt.append", stack, op) as unknown[];
  await (resolveFn(state, "setCel") as Fn)(state, `${seg}.crdt`, { celType: "ValueCel", v: nextStack, metadata: { key: `${seg}.crdt`, segment: seg, name: "crdt" } });
  const folded = R(state, "crdt.resolve", nextStack) as string;
  await applyString(state, seg, folded);
  await (resolveFn(state, "runCycle") as Fn)(state);

  await ensureHashSeg(state);
  const hash = await (R(state, "sheetkeys.hash", state, seg, [`${seg}.crdt`, `${seg}.writers`, `${seg}.hash`, `${seg}.datakey`]) as Promise<string>);
  await (resolveFn(state, "setCel") as Fn)(state, `${seg}.hash`, { celType: "ValueCel", v: hash, metadata: { key: `${seg}.hash`, segment: seg, name: "hash" } });
  return { ok: true, layers: nextStack.length, hash };
};

// ── sheetsync.commit(state, seg, key, source) — apply a SOURCE edit ──────────
// mints the op, signs it, applies locally (verify→gate→append→fold), and — if a
// data key exists for this segment (i.e. it's being synced) — encrypts the op
// and puts it on the peer channel. Returns { ok, hash, layers, frame? }; `frame`
// is the encrypted op-frame (present when synced) so a test can hand it to a
// replica's sheetsync.recv without a live transport.
const commitFn: Fn = (async (state: State, segArg?: unknown, keyArg?: unknown, sourceArg?: unknown): Promise<unknown> => {
  const seg = String(segArg ?? ""), key = String(keyArg ?? ""), source = String(sourceArg ?? "");
  if (!seg || !key) return { ok: false, error: "sheetsync.commit: seg + key required" };
  if (state.cels.get("keystore.status")?.v !== "unlocked") return { ok: false, error: "commit: unlock your identity first" };
  const me = String(state.cels.get("keystore.identity")?.v ?? "");
  const writers = state.cels.get(`${seg}.writers`)?.v;
  if (!(R(state, "writableBy", me, writers) as boolean)) return { ok: false, error: "commit: you are not a writer of this sheet" };

  // 1) the op: diff the segment SOURCE string before→after this edit.
  const before = segString(state, seg);
  const isFormula = source.trim().startsWith("=");
  const md = { key, segment: seg, name: key.slice(seg.length + 1), parser: isFormula ? "infix" : undefined } as Record<string, unknown>;
  await (resolveFn(state, "setCel") as Fn)(state, key, isFormula ? { celType: "FormulaCel", f: source, metadata: md } : { celType: "ValueCel", v: coerce(source), metadata: md });
  const after = segString(state, seg);

  const ts = stackOf(state, seg).length + 1;                   // monotonic per-seg (loopback is sequential)
  const op = R(state, "crdt.layer", before, after, me, ts) as Record<string, unknown>;
  const opStr = JSON.stringify(op);

  // 2) SIGN. 3) apply locally (the receive half, loopback).
  const signed = await (R(state, "keystore.sign", state, opStr) as Promise<{ ok: boolean; sig?: string; pub?: string }>);
  if (!signed.ok) return { ok: false, error: "commit: signing failed" };
  const res = await applyOp(state, seg, op, String(signed.sig), String(signed.pub));
  if (!res.ok) return res;

  // 4) BROADCAST — if this segment is being synced (a data key is held), encrypt
  // the signed op with it and put it on the channel.
  let frame: unknown = null;
  const dk = DATAKEYS.get(seg);
  if (dk) {
    const enc = await (R(state, "crypto.encrypt", dk, JSON.stringify({ op, sig: signed.sig, pub: signed.pub })) as Promise<string>);
    frame = { t: "op", seg, enc };
    tryTx(state, frame);
  }
  return { ok: true, hash: res.hash, layers: res.layers, frame };
}) as Fn;

// ── sheetsync.connect(state) — register inbound routes + announce presence ───
// Wire the op/key/hello frame types to sheetsync.recv on the peer transport, and
// emit a hello carrying my identity + ecdh pub so a peer can wrap a data key to me.
const connectFn: Fn = (async (state: State): Promise<unknown> => {
  if (has(state, "peer.route")) for (const t of ["op", "key", "hello"]) R(state, "peer.route", state, t, "sheetsync.recv");
  const frame = { t: "hello", pub: String(state.cels.get("keystore.identity")?.v ?? ""), ecdh: String(state.cels.get("keystore.ecdhpub")?.v ?? "") };
  tryTx(state, frame);
  return { ok: true, frame };
}) as Fn;

// ── sheetsync.share(state, seg, peerEcdhPub?) — grant a peer access ──────────
// Mint the segment data key if absent, ECDH-wrap it to the peer's ecdh pub, and
// send a "key" frame carrying { wrapped key, writers list, current op-log } so the
// peer can decrypt future ops, gate authors, and fold the current sheet. The
// data key + op-log travel ENCRYPTED; the writers list is public identities.
const shareFn: Fn = (async (state: State, segArg?: unknown, peerEcdhArg?: unknown): Promise<unknown> => {
  const seg = String(segArg ?? "");
  if (!seg) return { ok: false, error: "sheetsync.share: seg required" };
  if (state.cels.get("keystore.status")?.v !== "unlocked") return { ok: false, error: "share: unlock your identity first" };
  const peerEcdh = String(peerEcdhArg ?? (PEERS.size ? [...PEERS.values()][PEERS.size - 1].ecdh : ""));
  if (!peerEcdh) return { ok: false, error: "share: no peer ecdh pub (await a hello first, or pass one)" };

  let dk = DATAKEYS.get(seg);
  if (!dk) { dk = R(state, "crypto.datakey") as string; DATAKEYS.set(seg, dk); }
  const wrapped = await (R(state, "keystore.wrapTo", state, dk, peerEcdh) as Promise<{ ok: boolean; env?: string; fromPub?: string; error?: string }>);
  if (!wrapped.ok) return { ok: false, error: "share: " + (wrapped.error ?? "wrap failed") };
  const writers = state.cels.get(`${seg}.writers`)?.v ?? null;
  const stackEnc = await (R(state, "crypto.encrypt", dk, JSON.stringify(stackOf(state, seg))) as Promise<string>);
  const frame = { t: "key", seg, env: wrapped.env, fromPub: wrapped.fromPub, writers, stack: stackEnc };
  tryTx(state, frame);
  return { ok: true, frame };
}) as Fn;

// ── sheetsync.recv(state, frame) — the inbound dispatch (peer.route target) ──
// hello → record the peer's ecdh; key → unwrap the data key + adopt writers + fold
// the shared op-log; op → decrypt + applyOp. Returns a decision string.
const recvFn: Fn = (async (state: State, frameArg?: unknown): Promise<string> => {
  const m = frameArg as { t?: string; seg?: string; enc?: string; env?: string; fromPub?: string; writers?: unknown; stack?: string; pub?: string; ecdh?: string };
  if (!m || typeof m.t !== "string") return "dropped:malformed";

  if (m.t === "hello") {
    if (m.pub && m.ecdh) PEERS.set(String(m.pub), { ecdh: String(m.ecdh) });
    return "hello";
  }

  if (m.t === "key") {
    const seg = String(m.seg ?? "");
    if (!seg || !m.env || !m.fromPub) return "dropped:badkey";
    const un = await (R(state, "keystore.unwrapFrom", state, m.env, m.fromPub) as Promise<{ ok: boolean; dataKey?: string }>);
    if (!un.ok || !un.dataKey) return "dropped:unwrap";
    DATAKEYS.set(seg, un.dataKey);
    if (Array.isArray(m.writers)) await (resolveFn(state, "setCel") as Fn)(state, `${seg}.writers`, { celType: "ValueCel", v: m.writers, metadata: { key: `${seg}.writers`, segment: seg, name: "writers" } });
    if (m.stack) {
      try {
        const layers = JSON.parse(await (R(state, "crypto.decrypt", un.dataKey, m.stack) as Promise<string>));
        let cur = stackOf(state, seg);
        for (const L of (Array.isArray(layers) ? layers : [])) cur = R(state, "crdt.append", cur, L) as unknown[];
        await (resolveFn(state, "setCel") as Fn)(state, `${seg}.crdt`, { celType: "ValueCel", v: cur, metadata: { key: `${seg}.crdt`, segment: seg, name: "crdt" } });
        await applyString(state, seg, R(state, "crdt.resolve", cur) as string);
        await (resolveFn(state, "runCycle") as Fn)(state);
      } catch { return "dropped:stack"; }
    }
    return "key";
  }

  if (m.t === "op") {
    const seg = String(m.seg ?? "");
    const dk = DATAKEYS.get(seg);
    if (!dk) return "dropped:nokey";
    let env: { op?: Record<string, unknown>; sig?: string; pub?: string };
    try { env = JSON.parse(await (R(state, "crypto.decrypt", dk, String(m.enc)) as Promise<string>)); }
    catch { return "dropped:decrypt"; }
    if (!env.op || !env.sig || !env.pub) return "dropped:badop";
    const res = await applyOp(state, seg, env.op, String(env.sig), String(env.pub));
    return res.ok ? "applied" : "dropped:" + (res.error ?? "gate");
  }

  return "dropped:unknown";
}) as Fn;

// ── sheetsync.haskey(state, seg) — non-secret introspection (is seg synced?) ─
const haskeyFn: Fn = ((_state: State, segArg?: unknown): boolean => DATAKEYS.has(String(segArg ?? ""))) as Fn;

export const name = "sheetsync" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sheetsync.commit", commitFn],
  ["sheetsync.connect", connectFn],
  ["sheetsync.share", shareFn],
  ["sheetsync.recv", recvFn],
  ["sheetsync.haskey", haskeyFn],
]));
