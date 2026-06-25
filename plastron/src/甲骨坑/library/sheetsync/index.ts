import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// sheetsync — the CRDT change pipeline (encrypted-collaborative-sheetapp Phase 3).
// Every SOURCE edit becomes an authored, signed op appended to the segment's
// grow-only `crdt` diff-stack; the stack FOLDS back to the source cels. Local
// (loopback) for now — Phase 4 puts the same op on a WebRTC channel.
//
// INVARIANTS (design doc):
//   • SOURCES ONLY — the op-log carries a ValueCel's value / a FormulaCel's
//     TEXT, serialized to one canonical string; derived FormulaCel values are a
//     local runCycle PROJECTION, never synced (so replicas converge regardless
//     of recompute order).
//   • One writer to the graph at a time — ops apply at the setValueBatch →
//     runCycle boundary, never mid-cascade.
//   • GATE — an op is appended only if its author signature is valid AND the
//     author is in <seg>.writers (writableBy). A non-writer's edit is dropped.
// ============================================================================

const R = (state: State, k: string, ...a: unknown[]): unknown => (resolveFn(state, k) as Fn)(...a);

// ── the segment SOURCE string (the CRDT's value) ────────────────────────────
// one "key\tsource" line per source cel, sorted by key. source = formula TEXT
// for a FormulaCel, JSON(value) for a ValueCel. Excludes the chrome/control cels
// (<seg>.crdt / .writers / .hash) — those aren't user data.
const CONTROL = (seg: string) => new Set([`${seg}.crdt`, `${seg}.writers`, `${seg}.hash`]);
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

// sheetsync.commit(state, seg, key, source) — apply a SOURCE edit through the
// pipeline. Returns { ok, hash, layers } or { ok:false, error }. Loopback: the
// local apply IS the receive (sign → verify → gate → append → fold → setValue).
const commitFn: Fn = (async (state: State, segArg?: unknown, keyArg?: unknown, sourceArg?: unknown): Promise<unknown> => {
  const seg = String(segArg ?? ""), key = String(keyArg ?? ""), source = String(sourceArg ?? "");
  if (!seg || !key) return { ok: false, error: "sheetsync.commit: seg + key required" };
  if (state.cels.get("keystore.status")?.v !== "unlocked") return { ok: false, error: "commit: unlock your identity first" };
  const me = String(state.cels.get("keystore.identity")?.v ?? "");
  const writers = state.cels.get(`${seg}.writers`)?.v;
  if (!(R(state, "writableBy", me, writers) as boolean)) return { ok: false, error: "commit: you are not a writer of this sheet" };

  // 1) the op: diff the segment SOURCE string before→after this edit.
  const before = segString(state, seg);
  // stage the edit on a shadow of the live cels so `after` reflects it
  const isFormula = source.trim().startsWith("=");
  const md = { key, segment: seg, name: key.slice(seg.length + 1), parser: isFormula ? "infix" : undefined } as Record<string, unknown>;
  await (resolveFn(state, "setCel") as Fn)(state, key, isFormula ? { celType: "FormulaCel", f: source, metadata: md } : { celType: "ValueCel", v: coerce(source), metadata: md });
  const after = segString(state, seg);

  const stack = stackOf(state, seg);
  const ts = stack.length + 1;                                   // monotonic per-seg (loopback is sequential)
  const op = R(state, "crdt.layer", before, after, me, ts) as Record<string, unknown>;
  const opStr = JSON.stringify(op);

  // 2) SIGN (authenticity). 3) [encrypt + send over the channel — loopback here].
  const signed = await (R(state, "keystore.sign", state, opStr) as Promise<{ ok: boolean; sig?: string; pub?: string }>);
  if (!signed.ok) return { ok: false, error: "commit: signing failed" };

  // 4) RECEIVE: verify the signature. 5) GATE: author must be a writer.
  const sigOk = await (R(state, "crypto.verify", signed.pub, opStr, signed.sig) as Promise<boolean>);
  if (!sigOk) return { ok: false, error: "commit: bad signature" };
  if (!(R(state, "writableBy", signed.pub, writers) as boolean)) return { ok: false, error: "commit: signer not a writer" };

  // 6) APPEND to the grow-only stack. 7) FOLD → source cels (setCel) at the
  // quiescent boundary, then runCycle re-derives downstream.
  const nextStack = R(state, "crdt.append", stack, op) as unknown[];
  await (resolveFn(state, "setCel") as Fn)(state, `${seg}.crdt`, { celType: "ValueCel", v: nextStack, metadata: { key: `${seg}.crdt`, segment: seg, name: "crdt" } });
  const folded = R(state, "crdt.resolve", nextStack) as string;
  await applyString(state, seg, folded);
  await (resolveFn(state, "runCycle") as Fn)(state);

  // 8) stamp a fresh source hash (excludes the control cels).
  await ensureHashSeg(state);
  const hash = await (R(state, "sheetkeys.hash", state, seg, [`${seg}.crdt`, `${seg}.writers`, `${seg}.hash`]) as Promise<string>);
  await (resolveFn(state, "setCel") as Fn)(state, `${seg}.hash`, { celType: "ValueCel", v: hash, metadata: { key: `${seg}.hash`, segment: seg, name: "hash" } });
  return { ok: true, hash, layers: nextStack.length };
}) as Fn;

const ensureHashSeg = async (state: State): Promise<void> => { const es = resolveFn(state, "ensureSegments") as Fn | undefined; if (es) await es(state, ["sheetkeys"]); };
const coerce = (s: string): unknown => { if (s === "") return ""; const n = Number(s); return Number.isFinite(n) && s.trim() !== "" ? n : s; };

export const name = "sheetsync" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sheetsync.commit", commitFn],
]));
