import type { Key, State, ValueCel } from "../../types/index.js";

// ============================================================================
// Consent — the replacement for 信 capability-trust + 访 segment-access. ONE
// idea: a small set of functions are DANGEROUS (they do I/O or run code); each
// one is allowed or denied via a single `consent` cel. ENFORCEMENT is a runtime
// self-check the dangerous fn makes when it actually runs (`requireConsent`) —
// assembly-proof, unlike a source scan. The static dep-scan (elsewhere) is only
// the VISIBILITY surface that tells the UI what to ask about.
//
// This module is additive: it defines the standing blacklist + the consent
// predicates. Wiring the dangerous fns to call `requireConsent`, and the
// dep-scan/#BLACKLISTED marking, land when enforcement is switched on (and 信/访
// removed). See docs/1-design/1-under-consideration/consent-security-model.md.
// ============================================================================

export type DangerCategory = "net" | "fs" | "storage" | "db" | "code" | "secrets" | "control";
export interface DangerSpec { category: DangerCategory; reason: string; wiki?: string }

/** THE STANDING BLACKLIST — every function that does I/O or runs code, keyed by
 *  its cel key. Adding a new dangerous fn? Add it here (a blacklist is only as
 *  safe as it is complete — `consent-completeness` test guards the known set). */
export const DANGEROUS: Readonly<Record<Key, DangerSpec>> = {
  // ── net (outbound — exfiltration / embedding) ──────────────────────────────
  fetch:           { category: "net", reason: "outbound HTTP request", wiki: "fetch" },
  netallow:        { category: "net", reason: "widens the network host allowlist", wiki: "netallow" },
  chat:            { category: "net", reason: "LLM chat over HTTP", wiki: "chat" },
  grok:            { category: "net", reason: "LLM (xAI) over HTTP", wiki: "grok" },
  claude:          { category: "net", reason: "LLM (Anthropic) over HTTP", wiki: "claude" },
  cdn:             { category: "net", reason: "loads code/data from a CDN", wiki: "cdn" },
  "peer.connect":  { category: "net", reason: "opens a peer connection", wiki: "peer" },
  "peer.broadcast":{ category: "net", reason: "sends to all peers", wiki: "peer" },
  "peer.apply":    { category: "net", reason: "applies REMOTE writes into the graph", wiki: "peer" },
  peersend:        { category: "net", reason: "sends to a peer", wiki: "peer" },
  peerOffer:       { category: "net", reason: "WebRTC offer", wiki: "peer" },
  peerAnswer:      { category: "net", reason: "WebRTC answer", wiki: "peer" },
  peerAccept:      { category: "net", reason: "accepts a peer", wiki: "peer" },
  peerjoin:        { category: "net", reason: "joins a peer room", wiki: "peer" },
  peerallow:       { category: "net", reason: "widens the peer allowlist", wiki: "peer" },
  // ── fs (OPFS mutations — destroy / stage data) ─────────────────────────────
  "fs.write":      { category: "fs", reason: "writes a file", wiki: "fs.write" },
  "fs.writeText":  { category: "fs", reason: "writes a text file", wiki: "fs.writeText" },
  "fs.delete":     { category: "fs", reason: "deletes a file", wiki: "fs.delete" },
  "fs.mkdir":      { category: "fs", reason: "creates a directory", wiki: "fs.mkdir" },
  "fs.rmdir":      { category: "fs", reason: "removes a directory", wiki: "fs.rmdir" },
  "fs.rename":     { category: "fs", reason: "renames a path", wiki: "fs.rename" },
  "fs.command":    { category: "fs", reason: "filesystem command channel", wiki: "fs.command" },
  write:           { category: "fs", reason: "writes a file", wiki: "write" },
  touch:           { category: "fs", reason: "creates a file", wiki: "touch" },
  mkdir:           { category: "fs", reason: "creates a directory", wiki: "mkdir" },
  rm:              { category: "fs", reason: "deletes a path", wiki: "rm" },
  mv:              { category: "fs", reason: "moves a path", wiki: "mv" },
  upload:          { category: "fs", reason: "reads a local file into OPFS", wiki: "upload" },
  download:        { category: "fs", reason: "writes a file to the user's disk", wiki: "download" },
  downloadSeg:     { category: "fs", reason: "downloads a segment archive", wiki: "downloadSeg" },
  // ── storage (localStorage / IndexedDB persistence) ─────────────────────────
  save:            { category: "storage", reason: "persists the sheet to local storage", wiki: "save" },
  open:            { category: "storage", reason: "loads a sheet from local storage", wiki: "open" },
  saveSeg:         { category: "storage", reason: "persists a segment archive", wiki: "saveSeg" },
  openSeg:         { category: "storage", reason: "loads a segment archive", wiki: "openSeg" },
  delSeg:          { category: "storage", reason: "deletes a stored segment", wiki: "delSeg" },
  savepage:        { category: "storage", reason: "downloads the whole page", wiki: "savepage" },
  checkpoint:            { category: "storage", reason: "persisted snapshots", wiki: "checkpoint" },
  "checkpoint.snapshot": { category: "storage", reason: "writes a snapshot", wiki: "checkpoint" },
  "checkpoint.restore":  { category: "storage", reason: "restores a snapshot", wiki: "checkpoint" },
  "checkpoint.delta":    { category: "storage", reason: "writes a snapshot delta", wiki: "checkpoint" },
  // ── db (arbitrary SQL) ─────────────────────────────────────────────────────
  "sqlite.command":{ category: "db", reason: "arbitrary SQL", wiki: "sqlite" },
  db:              { category: "db", reason: "opens a SQLite database", wiki: "db" },
  sql:             { category: "db", reason: "runs arbitrary SQL", wiki: "sql" },
  tables:          { category: "db", reason: "reads the DB schema", wiki: "tables" },
  // ── code (arbitrary execution — the irreducible high-trust capability) ──────
  js:              { category: "code", reason: "runs arbitrary JavaScript", wiki: "js" },
  py:              { category: "code", reason: "runs arbitrary Python", wiki: "py" },
  wat:             { category: "code", reason: "runs arbitrary WebAssembly", wiki: "wat" },
  quickjs:         { category: "code", reason: "runs arbitrary JS in QuickJS", wiki: "quickjs" },
  def:             { category: "code", reason: "defines + runs a function from source", wiki: "def" },
  "defn.drain":    { category: "code", reason: "compiles user-defined functions", wiki: "def" },
  // ── secrets (reads / manages stored secrets) ───────────────────────────────
  apiKey:          { category: "secrets", reason: "reads a stored API key", wiki: "apiKey" },
  apiKeys:         { category: "secrets", reason: "lists stored API keys", wiki: "apiKey" },
  wallet:          { category: "secrets", reason: "the secrets wallet", wiki: "wallet" },
  walletKeys:      { category: "secrets", reason: "lists wallet keys", wiki: "wallet" },
  setKey:          { category: "secrets", reason: "stores a secret", wiki: "wallet" },
  editKey:         { category: "secrets", reason: "edits a secret", wiki: "wallet" },
  identity:        { category: "secrets", reason: "the wallet identity", wiki: "wallet" },
  unlockWallet:    { category: "secrets", reason: "unlocks the secrets wallet", wiki: "wallet" },
  "wallet.set":    { category: "secrets", reason: "stores a secret", wiki: "wallet" },
  "wallet.export": { category: "secrets", reason: "exports secrets", wiki: "wallet" },
  "wallet.import": { category: "secrets", reason: "imports secrets", wiki: "wallet" },
  "seal.lock":     { category: "secrets", reason: "seals a segment at rest", wiki: "seal" },
};

export const isDangerous = (key: Key): boolean => Object.prototype.hasOwnProperty.call(DANGEROUS, key);

/** A consent record per dangerous fn. `segments` absent → applies to ALL callers;
 *  present → only those segments are consented (per-segment consent). */
export interface ConsentGrant { allow: boolean; segments?: Key[]; reason?: string; category?: DangerCategory }
export const CONSENT_KEY = "consent" as const;
const LOCK_KEY = "__locked" as const;

const consentState = (state: State): Record<Key, ConsentGrant> => {
  const v = state.cels.get(CONSENT_KEY)?.v;
  return v && typeof v === "object" ? (v as Record<Key, ConsentGrant>) : {};
};

/** Is this session LOCKED? A locked session (set by bootFromHash for a URL/shared
 *  formula) gates every dangerous fn until the user Allows it. An UNLOCKED session
 *  (the user's own page) is full-trust — dangerous fns run freely, no consent
 *  needed. Mirrors the old 信 default (FULL unless quarantined). */
export const isConsentLocked = (state: State): boolean => (consentState(state) as Record<string, unknown>)[LOCK_KEY] === true;

/** Lock the session — every dangerous fn now needs explicit consent. */
export const lockConsent = (state: State): void => {
  const cel: ValueCel = { celType: "ValueCel", metadata: { key: CONSENT_KEY, segment: "kernel" }, v: { ...consentState(state), [LOCK_KEY]: true }, locked: false };
  state.cels.set(CONSENT_KEY, cel);
};

/** May a caller in `accessor` segment use `fnKey`? Non-dangerous fns always.
 *  In an UNLOCKED session, anything (own page). In a LOCKED session, a dangerous
 *  fn needs an `allow:true` grant whose `segments` (if present) includes the
 *  accessor. */
export const isConsented = (state: State, fnKey: Key, accessor: Key | undefined): boolean => {
  if (!isDangerous(fnKey)) return true;
  if (!isConsentLocked(state)) return true;     // own session → full trust
  const g = consentState(state)[fnKey];
  if (!g || !g.allow) return false;
  if (!g.segments) return true;                 // global grant
  return accessor === undefined || g.segments.includes(accessor); // host privileged
};

/** The enforcement primitive a dangerous fn calls at its entry. Returns true if
 *  permitted; false if it must refuse (the caller raises #BLOCKED). */
export const requireConsent = (state: State, fnKey: Key, accessor: Key | undefined): boolean =>
  isConsented(state, fnKey, accessor);

/** Grant / revoke consent for a dangerous fn (host/user only — never a
 *  formula-callable verb, else a payload consents itself). */
export const setConsent = (state: State, fnKey: Key, grant: ConsentGrant): void => {
  const prior = consentState(state);
  const next = { ...prior, [fnKey]: grant };
  const cel: ValueCel = { celType: "ValueCel", metadata: { key: CONSENT_KEY, segment: "kernel" }, v: next, locked: false };
  state.cels.set(CONSENT_KEY, cel);
};

// ── visibility: which dangerous fns does the live graph actually use? ─────────
// The dep graph already records function usage — a FormulaCel's inputMap lists
// the fn cels it calls. So this is a pure walk over existing edges, NOT a source
// scan. It feeds the consent UI (what to ask about) and, at enforcement time,
// which formulas to mark #BLACKLISTED. (Best-effort: it sees DIRECT references,
// not dynamically-assembled calls — those are caught by the runtime self-check.)

/** The #BLACKLISTED sentinel — the value a cel takes when it (or something
 *  upstream) calls an un-consented dangerous fn. A CelError so it propagates
 *  downstream through the existing error machinery and renders like #DENIED. */
export const BLACKLISTED = Object.freeze({ kind: "error" as const, at: [] as Key[], trap: "blacklisted", message: "#BLACKLISTED" });

const inputMapKeys = (cel: { metadata?: { inputMap?: Record<string, Key | Key[]> } }): Key[] => {
  const im = cel.metadata?.inputMap;
  if (!im) return [];
  const out: Key[] = [];
  for (const v of Object.values(im)) { if (Array.isArray(v)) out.push(...v); else out.push(v); }
  return out;
};

export interface DangerUse extends DangerSpec { fn: Key; consented: boolean; callCount: number; callers: Key[]; segments: Key[] }

/** Every dangerous fn REFERENCED by a formula in the live graph, with where it's
 *  used and whether it's consented. Sorted un-consented-first (the consent queue). */
export const dangerousUsage = (state: State): DangerUse[] => {
  const acc = new Map<Key, { callers: Set<Key>; segs: Set<Key> }>();
  for (const [k, cel] of state.cels) {
    if (cel.celType !== "FormulaCel") continue;
    const seg = String((cel.metadata as { segment?: unknown }).segment ?? "");
    for (const dep of inputMapKeys(cel as never)) {
      if (!isDangerous(dep)) continue;
      let e = acc.get(dep); if (!e) { e = { callers: new Set(), segs: new Set() }; acc.set(dep, e); }
      e.callers.add(k); if (seg) e.segs.add(seg);
    }
  }
  const out: DangerUse[] = [];
  for (const [fn, e] of acc) {
    const spec = DANGEROUS[fn]!;
    const segs = [...e.segs];
    const consented = segs.length ? segs.every((s) => isConsented(state, fn, s)) : isConsented(state, fn, undefined);
    out.push({ fn, ...spec, consented, callCount: e.callers.size, callers: [...e.callers], segments: segs });
  }
  return out.sort((a, b) => (a.consented === b.consented ? a.fn.localeCompare(b.fn) : a.consented ? 1 : -1));
};
