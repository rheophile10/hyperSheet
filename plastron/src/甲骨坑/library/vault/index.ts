import type { 甲骨, Cel, Fn, State, EventBinding } from "../../../types/index.js";
import {
  bindNativeFns, ensureSegments, resolveFn, secretHandle,
} from "../../../kernel/index.js";
import { dom, style, attr, on } from "../dom/utils/vocab.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// vault — api keys as SEALED cels, gated at runtime, encrypted at rest
// by the two GENERAL mechanisms (no bespoke vault crypto anymore).
//
// The bespoke module-scope key Map + PBKDF2/AES-GCM file is GONE.
// The vault's two jobs are now covered by the substrate's own mechanisms:
//
//   • RUNTIME protection (CONSENT): apiKey(name) is a DANGEROUS verb. A formula
//     that calls it is #BLACKLISTed by the central runCycle consent gate in a
//     LOCKED (URL/shared) session (per-segment grants supported); in an unlocked
//     (own) session it returns the key. No self-check — the tag is the policy.
//
//   • AT-REST protection (SEAL, Layer 2): on unlock the vault calls
//     seal.lock(password) — derives the seal data key (PBKDF2 once, in the seal
//     library) and installs the kernel's seal hooks. Each `secrets.*` cel carries
//     metadata.sealed, so it DEHYDRATES as { __sealed: … } ciphertext and HYDRATES
//     back only under the same password. The vault owns no crypto of its own.
//
// "Unlock" therefore means: seal.lock(password) (so secrets decrypt on load /
// encrypt on save) + mark the vault runtime-unlocked so the panel/readers
// surface the stored key NAMES. Names aren't secret; the SECRET values never
// leave the gated `secrets` cels.
//
// secretsNote is a plain ValueCel the handlers write status into — put
// `=secretsNote` in a cell for a reactive status readout.
//
// This segment also carries the dom()-FORMULA presentation verbs (secrets,
// domClients): a showcase that interactive UI can be a formula. They COMPOSE
// the vault's own reader verbs (locked/apiKeys) as args, wiring the SAME
// dispatch handlers (vault.unlock / .lock / .setNamed / .del) — no new
// handlers, no new module state. Pure render over the vault's surface.
// ============================================================================

const SECRETS_SEGMENT = "secrets" as const;
const GEN_KEY = "secretsGen" as const;
// Secret cels are written with metadata.sealed: true so dehydrate encrypts them
// at rest (Layer 2 seal). Read access is gated centrally: the consent gate
// #BLACKLISTs any locked-session formula that calls the DANGEROUS apiKey verb.
const secretKey = (name: string): string => `${SECRETS_SEGMENT}.${name}`;

// ── module-scope runtime state (host-held; never dehydrated; the seal lib
//    holds the actual data key — this module holds only NON-secret bookkeeping:
//    which key NAMES exist + whether the vault is runtime-unlocked + the live
//    state so the native apiKey verb can read+gate the secrets cels) ──────────
let names: Set<string> | null = null;   // null = locked; else the stored key NAMES (not secret)
let stateRef: State | null = null;       // last state seen by a handler — apiKey reads secrets through it
let gen = 0;                             // secretsGen version — bumped on every key-set change
let identityPub: string | null = null;  // the unlocked identity's PUBLIC key (base64); null = locked / not yet minted. NEVER the private key.

// Capture the live state from any handler so the native apiKey verb (which the
// formula evaluator calls with ONLY its formula args — no state) can reach the
// secrets cels + the per-state accessor. Single-state in practice, exactly the
// seal/net/host module-singleton pattern.
const remember = (state: State): State => { stateRef = state; return state; };

// ── seal driver (Layer 2 at-rest) ──────────────────────────────────────────
// Unlock = install the seal hooks for this password (secrets encrypt on
// dehydrate, decrypt on hydrate). Lock = clear them. The seal library owns the
// PBKDF2 + AES; the vault just drives it. Returns true if the seal hooks
// installed, false if the host has no WebCrypto (session-only — keys still work
// in memory for this tab, but won't seal at rest).
const sealLock = async (state: State, password: string): Promise<boolean> => {
  try {
    await ensureSegments(state, ["seal"]);
    await (resolveFn(state, "seal.lock") as Fn)(state, password);
    return true;
  } catch {
    return false;
  }
};
const sealClear = async (state: State): Promise<void> => {
  try {
    await ensureSegments(state, ["seal"]);
    await (resolveFn(state, "seal.lock") as Fn)(state); // no arg → clear hooks
  } catch { /* no seal here — nothing to clear */ }
};

// ── identity driver (the unlock mints/loads ONE identity keypair) ───────────
// On unlock, ensure crypto is loaded and ask it for THE identity keypair:
// crypto.identity mints a NON-EXTRACTABLE Ed25519 key the first time (empty
// keystore) and loads the same one thereafter (IndexedDB persists across
// reloads → a stable public key). We keep ONLY the public half in module scope
// (identityPub); the private key stays in the keystore, never a cel value. The
// identity() verb surfaces identityPub; locking clears it. Best-effort: a host
// without WebCrypto leaves identityPub null (the verb shows its placeholder).
const ensureIdentity = async (state: State): Promise<void> => {
  try {
    await ensureSegments(state, ["crypto"]);
    const handle = await (resolveFn(state, "crypto.identity") as Fn)() as { publicKey?: unknown };
    identityPub = typeof handle?.publicKey === "string" ? handle.publicKey : null;
  } catch {
    identityPub = null;
  }
};

// ── secrets segment + cels ──────────────────────────────────────────────────
// (the 访 sealed-policy was removed; secret cels now carry metadata.sealed so
// Layer 2 seals them at rest, and apiKey gates reads via consent.)
const ensureSecretsPolicy = (_state: State): void => {};

// bumpGen — advance the secretsGen version cel. apiKey() reads secrets
// INTERNALLY (a native verb, no formula-dep edge), so a key change wouldn't
// otherwise re-fire client cels. A client formula references secretsGen via
// (apiKey "name" secretsGen); bumping it here forces those cels to re-fire
// through the graph. Top-level ValueCel (outside the sealed `secrets` segment)
// so any formula may reference it for reactivity without breaching the seal.
const bumpGen = async (state: State): Promise<void> => {
  gen += 1;
  await (resolveFn(state, "setValue") as Fn)(state, GEN_KEY, gen);
};

// Store a secret: secrets.<name> = secret. Runs at TOP LEVEL (handlers aren't
// wrapped in withAccessor → empty accessor → privileged), so the user can
// always store a key even though set: "private". Creates the cel on first use
// (setCel — setValue can't create), writes the value via setValue thereafter.
const storeSecret = async (state: State, name: string, secret: string): Promise<void> => {
  ensureSecretsPolicy(state);
  const key = secretKey(name);
  if (state.cels.get(key)) {
    await (resolveFn(state, "setValue") as Fn)(state, key, secret);
  } else {
    await (resolveFn(state, "setCel") as Fn)(state, key, {
      celType: "ValueCel", v: secret,
      metadata: { key, segment: SECRETS_SEGMENT, name, sealed: true }, // sealed at rest (Layer 2)
    });
  }
  (names ??= new Set()).add(name);
  await bumpGen(state);
};

const dropSecret = async (state: State, name: string): Promise<boolean> => {
  const key = secretKey(name);
  const existed = !!state.cels.get(key);
  // setValue can't delete a cel; blank it so no plaintext remains, then drop
  // the name from the live set so the readers stop listing it. (A locked
  // vault re-deriving names from cels would see the blank.)
  if (existed) await (resolveFn(state, "setValue") as Fn)(state, key, "");
  names?.delete(name);
  if (existed) await bumpGen(state);
  return existed;
};

// Read a stored secret value straight off the cel (no gating here — callers
// gate). Returns "" when absent/locked.
const rawSecret = (state: State, name: string): string =>
  String(state.cels.get(secretKey(name))?.v ?? "");

// Re-derive the runtime name set from whatever secrets cels already live in
// state (e.g. hydrated from a sealed archive then unlocked). Non-empty values
// only — a blanked (deleted) cel doesn't resurrect.
const namesFromState = (state: State): Set<string> => {
  const out = new Set<string>();
  const prefix = `${SECRETS_SEGMENT}.`;
  for (const [k, cel] of state.cels) {
    if (k.startsWith(prefix) && String(cel.v ?? "") !== "") out.add(k.slice(prefix.length));
  }
  return out;
};

const fsCall = async (state: State, k: string, ...a: unknown[]): Promise<unknown> => {
  await ensureSegments(state, ["file-store"]);
  return (resolveFn(state, k) as Fn)(...a);
};

const note = async (state: State, msg: string): Promise<void> => {
  // a neutrally-named status trigger a panel reacts to without referencing a
  // vault-named cel: =secrets(locked(secretsNote), apiKeys()).
  await (resolveFn(state, "setValue") as Fn)(state, "secretsNote", msg);
  // setValue re-fires secretsNote-dependent cels via the cascade — including any
  // =vaultKeys(secretsNote) genesis cel, whose request updates but isn't
  // materialized until genesis.commit drains. Drain it so per-key cels
  // regenerate, then paint. No-op when no genesis cel depends on the vault.
  await (resolveFn(state, "drain") as Fn)(state, "genesis.commit");
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
};

// ── vnodes, built literally (no imports — the painter takes the shape) ──────
type V = { type: "el" | "text"; tag?: string; text?: string; attrs?: Record<string, unknown>; events?: Record<string, unknown>; children?: V[] };
const t = (s: string): V => ({ type: "text", text: s });
const e = (tag: string, attrs: Record<string, unknown>, children: V[], events?: Record<string, unknown>): V =>
  ({ type: "el", tag, attrs, children, ...(events ? { events } : {}) });
const PW_STYLE = "font-family:ui-monospace,monospace;font-size:.85rem;padding:.15rem .4rem;border:1px solid #8884;border-radius:.3rem;background:#8881;min-width:14rem";
const CAP_STYLE = "font-size:.75rem;color:GrayText;font-family:system-ui;margin-left:.4rem";
// A password box bound to a dispatch handler. Submits on BOTH Enter
// (keydown) and blur (change) — a lone <input> only fires `change` on blur,
// so without the keydown binding "enter = …" in the caption would be a lie.
// The handler gates on shouldSubmit() so non-Enter keystrokes are ignored.
const pwInput = (dispatch: string, payload: unknown, placeholder: string, caption: string): V => {
  const binding = payload === undefined ? { dispatch } : { dispatch, payload };
  return e("span", {}, [
    e("input", { type: "password", placeholder, style: PW_STYLE }, [],
      { change: binding, keydown: binding }),
    e("span", { style: CAP_STYLE }, [t(caption)]),
  ]);
};

// Only act on a real submission: a blur-fired change, or an Enter keydown.
const shouldSubmit = (event: unknown): boolean => {
  const ev = event as { type?: string; key?: string } | undefined;
  return ev?.type === "change" || (ev?.type === "keydown" && ev?.key === "Enter");
};

// ── formula fns (pure values: strings, handles, vnodes) ─────────────────────

/** apiKey(name) — returns the STORED SECRET STRING (compatible with claudeFn,
 *  which accepts a literal key), or a #NOKEY/#DENIED string when there's no key /
 *  the vault is locked. THE GATE is central: "apiKey" is a DANGEROUS verb, and a
 *  formula that calls it ((makeclient … (apiKey "anthropic" secretsGen))) is
 *  #BLACKLISTed by the runCycle consent gate in a locked (URL-boot) session
 *  before apiKey ever runs; in an unlocked (own) session every verb is allowed.
 *  The optional 2nd arg is a REACTIVITY TRIGGER: apiKey reads secrets
 *  internally (no formula-dep edge), so a caller passes secretsGen — a cel the
 *  vault bumps on every key change — to wire the dep and re-fire on add/del. */
const keyFn: Fn = (name: unknown, _gen?: unknown) => {
  const n = String(name ?? "");
  const state = stateRef;
  if (!state) return `#DENIED(apiKey "${n}": no vault state — =unlockVault() first)`;
  // a LOCKED vault exposes no keys — refuse even though the secret cel may
  // still hold a value in memory (lock only forgets the runtime unlock; it
  // doesn't blank the cel). So locking re-arms client cels to error via the
  // secretsGen bump, and an apiKey call before unlock gets a clear refusal.
  if (!names) return `#NOKEY(apiKey "${n}": vault locked — =unlockVault() first)`;
  // No self-check: `apiKey` is DANGEROUS and only ever invoked from a formula
  // (e.g. (makeclient "claude" (apiKey "anthropic" secretsGen))), so the central
  // runCycle gate #BLACKLISTs that formula in a locked session before apiKey runs.
  const v = rawSecret(state, n);
  if (!v) return `#NOKEY(apiKey "${n}": no such key — =unlockVault(), then =setKey("${n}"))`;
  return v;
};

// vaultKeys(trigger) — GENESIS: materialize one ROW per stored key into a
// `keys` worksheet: column A = a live handle (renders 🔑 name, referenceable),
// column B = a delete button (✕ → vault.del). Pass secretsNote so it
// regenerates when keys change / the vault locks. Per-key cels. Locked /
// empty → no cels (the genesis sweep removes prior key rows). The handle's
// resolver reads the gated secrets cel through the captured state.
const DEL_STYLE = "font-family:ui-monospace,monospace;font-size:.75rem;padding:.1rem .4rem;border:1px solid #d4453e55;border-radius:.3rem;background:#d4453e1a;color:#d4453e;cursor:pointer";
const vaultKeysFn: Fn = (_trigger?: unknown): { genesis: true; layer: string; cels: Record<string, unknown> } => {
  const cels: Record<string, unknown> = {};
  if (names) {
    [...names].sort().forEach((name, i) => {
      const row = i + 1;
      cels[`keys.A${row}`] = { celType: "ValueCel", v: secretHandle(name, () => (stateRef ? rawSecret(stateRef, name) : undefined)), metadata: { name: `A${row}` } };
      cels[`keys.B${row}`] = { celType: "ValueCel", metadata: { name: `B${row}` },
        v: e("button", { type: "button", title: `delete "${name}"`, style: DEL_STYLE }, [t("✕")], { click: { dispatch: "vault.del", payload: name } }) };
    });
  }
  return { genesis: true, layer: "keys", cels };
};

// locked(trigger?) — the lock state as a BOOLEAN value (true = locked). Pass a
// reactive cel (=locked(secretsNote)) so it tracks lock/unlock.
const lockedFn: Fn = (_trigger?: unknown): boolean => !names;

// identity(trigger?) — the current identity's PUBLIC key as a shareable base64
// string when unlocked, or a "🔒 unlock to see your identity" placeholder when
// locked. The PRIVATE key never surfaces — identityPub holds only the public
// half (minted/loaded by ensureIdentity on unlock; cleared on lock). Pass the
// unlock trigger (=identity(secretsGen)) so it re-renders on unlock/lock through
// inputMap — secretsGen is the dep, no hand-rolled repaint.
const identityFn: Fn = (_trigger?: unknown): string =>
  (!names || !identityPub) ? "🔒 unlock to see your identity" : identityPub;

// editKey(lockCell, name) — per-key edit + delete in ONE cell. Pass the lock
// cell (=locked(secretsNote)) as the FIRST arg so this cell depends on it and
// re-evaluates on lock/unlock. Locked → can't edit; unlocked → a secret box to
// set/update the key + a ✕ to delete it.
const editKeyFn: Fn = (_lock: unknown, name: unknown): unknown => {
  const n = String(name ?? "").trim();
  if (!n) return "(editKey: name a key — =editKey(A1, \"anthropic\"))";
  if (!names) return e("span", { style: STAT_STYLE }, [t(`🔒 ${n} — unlock to edit`)]);
  const has = names.has(n);
  const kids: V[] = [
    e("span", { style: STAT_STYLE }, [t(`🔑 ${n}${has ? "" : " · new"}`)]),
    e("input", { type: "password", placeholder: has ? "update secret… (Enter)" : "secret… (Enter)", style: PW_STYLE }, [],
      { change: { dispatch: "vault.set", payload: n }, keydown: { dispatch: "vault.set", payload: n } }),
  ];
  if (has) kids.push(e("button", { type: "button", title: `delete "${n}"`, style: DEL_STYLE }, [t("✕")],
    { click: { dispatch: "vault.del", payload: n } }));
  return e("div", { style: PANEL_STYLE }, kids);
};

const keysFn: Fn = () => {
  if (!names) return "(vault locked — =unlockVault())";
  if (names.size === 0) return "(vault empty — =setKey(\"anthropic\"))";
  return [...names].sort().join("\n");
};

const unlockVaultFn: Fn = () =>
  pwInput("vault.unlock", undefined, "choose a vault password…",
    "Enter = unlock (no default — your first password CREATES the vault); status: =secretsNote");

// setKey(name [, trigger]) — pass secretsNote as `trigger` so this cel re-fires
// when the vault locks/unlocks.
const setKeyFn: Fn = (name: unknown, _trigger?: unknown) => {
  const n = String(name ?? "").trim();
  if (!n) return "(setKey: name it, e.g. =setKey(\"anthropic\", secretsNote))";
  if (!names) return "(vault locked — =unlockVault(), then =setKey(\"anthropic\", secretsNote))";
  return pwInput("vault.set", n, `secret for "${n}"…`,
    `Enter = store; then use it as apiKey("${n}")`);
};

// A lock BUTTON (locks on click, not on render).
const BTN_STYLE = "font-family:ui-monospace,monospace;font-size:.8rem;padding:.15rem .55rem;border:1px solid #8884;border-radius:.3rem;background:#8881;cursor:pointer";
const lockVaultFn: Fn = (): V =>
  e("button", { type: "button", style: BTN_STYLE }, [t("🔒 lock")], { click: { dispatch: "vault.lock" } });

const PANEL_STYLE = "display:flex;align-items:center;gap:.5rem;flex-wrap:wrap";
const STAT_STYLE = "font-family:ui-monospace,monospace;font-size:.82rem;color:CanvasText";

// ── handlers — called (state, payload, event) by the dispatch binding ───────
type InputEvent = { target?: { value?: string; files?: ArrayLike<{ text(): Promise<string> }> } };

const unlockHandler: Fn = async (stateArg: unknown, _payload: unknown, event: unknown) => {
  const state = remember(stateArg as State);
  if (!shouldSubmit(event)) return state; // ignore every non-Enter keystroke
  const target = (event as InputEvent)?.target;
  const pw = String(target?.value ?? "");
  if (!pw) return state;
  if (target) target.value = "";
  ensureSecretsPolicy(state);
  // Install the seal hooks for this password (Layer 2). Sealed secrets in a
  // hydrated archive now decrypt; future dehydrates encrypt. No bespoke
  // crypto, no vault.json — the at-rest story is entirely seal-driven.
  const sealed = await sealLock(state, pw);
  // Runtime-unlock: surface whatever secrets already exist (decrypted on
  // hydrate) plus any added this session.
  names = namesFromState(state);
  // Mint (first time) or load (subsequently) THE identity keypair — the
  // north-star's "enter a password, get a public + private key". The private
  // key stays NON-EXTRACTABLE in the keystore; only the public half (identityPub)
  // surfaces, via the identity() verb. Best-effort: a host without WebCrypto
  // leaves identityPub null and identity() shows its placeholder.
  await ensureIdentity(state);
  // re-arm any client cel that referenced secretsGen while the vault was
  // locked: unlocking surfaced the (decrypted) keys + the identity, so bump to
  // re-fire them (identity(secretsGen) repaints with the public key).
  await bumpGen(state);
  const n = names.size;
  await note(state, sealed
    ? (n > 0
        ? `(vault unlocked — ${n} key${n === 1 ? "" : "s"}; =apiKeys())`
        : "(new vault — =setKey(\"anthropic\") next; secrets seal at rest on save)")
    : "(session vault — no WebCrypto here, secrets live for this tab only; =setKey(\"anthropic\"))");
  return state;
};

const setHandler: Fn = async (stateArg: unknown, payload: unknown, event: unknown) => {
  const state = remember(stateArg as State);
  if (!shouldSubmit(event)) return state; // ignore every non-Enter keystroke
  const target = (event as InputEvent)?.target;
  const secret = String(target?.value ?? "");
  if (!secret) return state;
  if (target) target.value = "";
  if (!names) { await note(state, "(vault locked — =unlockVault() first)"); return state; }
  const n = String(payload ?? "");
  await storeSecret(state, n, secret);
  await note(state, `(stored "${n}" — ${names.size} key${names.size === 1 ? "" : "s"}; use apiKey("${n}"))`);
  return state;
};

const lockHandler: Fn = async (stateArg: unknown) => {
  const state = remember(stateArg as State);
  names = null;
  identityPub = null;     // hide the public key while locked (the private key was never here; it stays in the keystore)
  await sealClear(state); // clear the seal hooks — secrets re-seal/stay sealed at rest
  await bumpGen(state);   // re-fire client cels → they flip back to error (no key)
  await note(state, "(vault locked)");
  return state;
};

// delete a key — dispatched by a per-key ✕ button (payload = the name).
const delHandler: Fn = async (stateArg: unknown, name: unknown) => {
  const state = remember(stateArg as State);
  if (!names) return state;
  const n = String(name ?? "");
  if (await dropSecret(state, n)) {
    await note(state, `(deleted "${n}" — ${names.size} key${names.size === 1 ? "" : "s"} left)`);
  }
  return state;
};

// add-a-key from the panel: the NAME was typed into the vault.newName cel
// (names aren't secret — a cel is fine); the SECRET arrives on the event and
// never touches a cel value the graph can read across segments.
const setNamedHandler: Fn = async (stateArg: unknown, _payload: unknown, event: unknown) => {
  const state = remember(stateArg as State);
  if (!shouldSubmit(event)) return state;
  if (!names) { await note(state, "(vault locked — unlock first)"); return state; }
  const target = (event as InputEvent)?.target;
  const secret = String(target?.value ?? "");
  const name = String(state.cels.get("vault.newName")?.v ?? "").trim();
  if (!name) { await note(state, "(name the key in the left box, then enter the secret)"); return state; }
  if (!secret) return state;
  if (target) target.value = "";
  await storeSecret(state, name, secret);
  await (resolveFn(state, "setValue") as Fn)(state, "vault.newName", "");
  await note(state, `(stored "${name}" — ${names.size} key${names.size === 1 ? "" : "s"}; use apiKey("${name}"))`);
  return state;
};

// edit a key (panel ✎): populate the add-key NAME buffer so the next secret
// entered on the right OVERWRITES this key. Names aren't secret.
const startEditHandler: Fn = async (stateArg: unknown, payload: unknown): Promise<unknown> => {
  const state = remember(stateArg as State);
  const name = String(payload ?? "").trim();
  await (resolveFn(state, "setValue") as Fn)(state, "vault.newName", name);
  await note(state, `(editing "${name}" — enter the new secret on the right, Enter to save)`);
  return state;
};

// export/import — dehydrate-driven now. The ENCRYPTED form is the dehydrated
// archive (secrets seal via the seal hooks); the vault no longer maintains a
// separate vault.json. These remain as graceful affordances: export downloads
// the seal-aware archive of the secrets segment; import is a no-op hint to use
// the archive flow. (Kept so existing UI references don't break.)
type DomDownload = {
  document?: { createElement(t: string): { href: string; download: string; click(): void; remove(): void }; body: { appendChild(n: unknown): void } };
  URL?: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void };
  Blob?: new (parts: unknown[]) => unknown;
};

const exportHandler: Fn = async (stateArg: unknown) => {
  const state = remember(stateArg as State);
  const g = globalThis as DomDownload;
  if (!g.document || !g.URL || !g.Blob) return state;
  if (!names) { await note(state, "(unlock first — secrets seal into the archive on export)"); return state; }
  let raw: string;
  try {
    const archive = await (resolveFn(state, "dehydrate") as Fn)(state);
    raw = JSON.stringify(archive);
  } catch { await note(state, "(nothing to export)"); return state; }
  const url = g.URL.createObjectURL(new g.Blob([raw]));
  const a = g.document.createElement("a");
  a.href = url; a.download = "vault-archive.json";
  g.document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => g.URL!.revokeObjectURL(url), 1000);
  return state;
};

const importHandler: Fn = async (stateArg: unknown, _payload: unknown, event: unknown) => {
  const state = remember(stateArg as State);
  const file = (event as InputEvent)?.target?.files?.[0];
  if (!file) return state;
  void fsCall; // file-store available if a host wants to persist the picked file
  await note(state, "(import a sealed archive via the host's load flow, then =unlockVault())");
  return state;
};

const lockFnExported = lockHandler;

// ============================================================================
// dom()-FORMULA presentation verbs (secrets / domClients panels).
//
// A native verb fn receives only its formula args (no state, no record), so it
// cannot reach the vault's live lock state directly. Instead it COMPOSES the
// vault's existing reader verbs, taking their results as args:
//
//   =secrets(locked(secretsNote), apiKeys())
//
// `locked(secretsNote)` is the boolean lock state (true = locked), reactive on
// secretsNote; `apiKeys()` is the newline-joined key names (or a "(vault …)"
// hint string). Passing them as args makes the panel react through inputMap.
// ============================================================================

// The vocab's on() emits a {dispatch} binding; the name field needs a
// {set,extract} listener (write the typed name to the vault.newName buffer
// cel, no dispatch). dom() reads any child shaped { __on: { event, binding } }
// and folds binding into the element's events bag — so we author the set
// listener as that same vocab CHILD shape with a set-binding. This stays inside
// the dom() vocabulary (dom consumes it) without modifying the dom segment.
const setOn = (event: string, binding: EventBinding): { __on: { event: string; binding: EventBinding } } =>
  ({ __on: { event, binding } });

// Styles mirror the hand-built panel so the formula-authored panel looks
// identical.
const PANEL = "display:flex;align-items:center;gap:.5rem;flex-wrap:wrap";
const COL = "display:flex;flex-direction:column;gap:.35rem";
const STAT = "font-family:ui-monospace,monospace;font-size:.82rem;color:CanvasText";
const NAME = "font-family:ui-monospace,monospace;font-size:.85rem;padding:.15rem .4rem;border:1px solid #8884;border-radius:.3rem;background:#8881;min-width:8rem";
const PW = "font-family:ui-monospace,monospace;font-size:.85rem;padding:.15rem .4rem;border:1px solid #8884;border-radius:.3rem;background:#8881;min-width:14rem";
const CAP = "font-size:.75rem;color:GrayText;font-family:system-ui;margin-left:.4rem";
const BTN = "font-family:ui-monospace,monospace;font-size:.8rem;padding:.15rem .55rem;border:1px solid #8884;border-radius:.3rem;background:#8881;cursor:pointer";
const CHIP = "display:inline-flex;align-items:center;gap:.3rem;font-family:ui-monospace,monospace;font-size:.82rem;padding:.1rem .2rem .1rem .45rem;border:1px solid #8884;border-radius:.4rem;background:#8881";
const DEL = "font-family:ui-monospace,monospace;font-size:.75rem;padding:.1rem .4rem;border:1px solid #d4453e55;border-radius:.3rem;background:#d4453e1a;color:#d4453e;cursor:pointer";
const EDIT = "font-family:ui-monospace,monospace;font-size:.75rem;padding:.1rem .4rem;border:1px solid #8884;border-radius:.3rem;background:#8881;color:CanvasText;cursor:pointer";

type StyleChild = ReturnType<typeof style>;
// expand a "prop:value;prop:value" string into style(prop, value, …).
const styleOf = (css: string): StyleChild => {
  const pairs: string[] = [];
  for (const decl of css.split(";")) {
    const i = decl.indexOf(":");
    if (i === -1) continue;
    pairs.push(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
  }
  return style(...pairs);
};

type Vnode = ReturnType<typeof dom>;

// A password box wired to a dispatch handler on BOTH change (blur) and keydown
// (Enter) — mirrors pwInput. The handlers gate on shouldSubmit, so non-Enter
// keystrokes are ignored. payload, when given, rides each binding.
const pwBox = (dispatch: string, payload: unknown, placeholder: string, caption: string): Vnode => {
  const change = payload === undefined ? on("change", dispatch) : on("change", dispatch, payload);
  const keydown = payload === undefined ? on("keydown", dispatch) : on("keydown", dispatch, payload);
  return dom("span",
    dom("input",
      attr("type", "password", "placeholder", placeholder),
      styleOf(PW),
      change, keydown,
    ),
    dom("span", styleOf(CAP), caption),
  );
};

// secrets(lock, names?) — the SECRETS panel as a dom() formula. It wires the
// vault handlers (vault.unlock / .lock / .setNamed / .del), with NO "vault"
// wording the user sees: the status reads "Secrets", the unlock caption talks
// about a "secrets password". Reactive: pass (locked secretsNote) and (apiKeys)
// so lock/unlock/set re-fire the cel through inputMap (those verbs ARE the deps).
const secretsFn: Fn = (lock?: unknown, names?: unknown): Vnode => {
  const locked = lock === undefined ? true : Boolean(lock);

  if (locked) {
    return dom("div", styleOf(PANEL),
      dom("span", styleOf(STAT), "🔒 locked"),
      pwBox("vault.unlock", undefined, "secrets password…",
        "Enter = unlock (first password creates your secrets)"),
    );
  }

  const raw = String(names ?? "");
  const keyNames = raw.startsWith("(") ? [] : raw.split("\n").map((s) => s.trim()).filter(Boolean);
  const n = keyNames.length;

  const chips = keyNames.map((name) =>
    dom("span", styleOf(CHIP),
      `🔑 ${name}`,
      dom("button",
        attr("type", "button", "title", `edit "${name}"`),
        styleOf(EDIT),
        on("click", "vault.startEdit", name),
        "✎",
      ),
      dom("button",
        attr("type", "button", "title", `delete "${name}"`),
        styleOf(DEL),
        on("click", "vault.del", name),
        "✕",
      ),
    ));

  const addRow = dom("div", styleOf(PANEL),
    dom("input",
      attr("type", "text", "placeholder", "new key name"),
      styleOf(NAME),
      setOn("input", { set: "vault.newName", extract: "value" }),
    ),
    dom("input",
      attr("type", "password", "placeholder", "secret… (Enter to add)"),
      styleOf(PW),
      on("change", "vault.setNamed"),
      on("keydown", "vault.setNamed"),
    ),
  );

  return dom("div", styleOf(COL),
    dom("div", styleOf(PANEL),
      dom("span", styleOf(STAT), `🔓 unlocked — ${n} key${n === 1 ? "" : "s"}`),
      dom("button", attr("type", "button"), styleOf(BTN), on("click", "vault.lock"), "🔒 lock"),
    ),
    ...(chips.length ? [dom("div", styleOf(PANEL), ...chips)] : []),
    addRow,
  );
};

// domClients(claude, grok) — a read-only CLIENTS panel. Pass the two client
// cells (clients.claude / clients.grok) so it re-fires when they (re)mint; each
// is a captured client HANDLE { __client } when ready, or a #DENIED/locked hint
// string while the secrets are locked. Shows a 🟢 ready / 🔒 locked indicator
// per provider. It reads CLIENT handles, never the key — the handle is the safe
// thing a downstream (the chat) needs.
const clientRow = (label: string, client: unknown): Vnode => {
  const ready = !!(client && typeof client === "object" && (client as { __client?: boolean }).__client === true);
  return dom("div", styleOf(PANEL),
    dom("span", styleOf(STAT), `${ready ? "🟢" : "🔒"} ${label}`),
    dom("span", styleOf(CAP), ready ? "ready" : "locked — unlock secrets to arm"),
  );
};
const domClientsFn: Fn = (claude?: unknown, grok?: unknown): Vnode =>
  dom("div", styleOf(COL),
    dom("span", styleOf(STAT), "clients"),
    clientRow("claude", claude),
    clientRow("grok", grok),
  );

export const name = "vault" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["locked",        lockedFn],
  ["identity",      identityFn],
  ["editKey",       editKeyFn],
  ["vaultKeys",     vaultKeysFn],
  ["apiKey",        keyFn],
  ["apiKeys",       keysFn],
  ["setKey",        setKeyFn],
  ["unlockVault",   unlockVaultFn],
  ["lockVault",     lockVaultFn],
  ["exportVault",   () => e("button", { type: "button", style: PW_STYLE }, [t("⬇ vault archive (sealed)")], { click: { dispatch: "vault.export" } })],
  ["importVault",   () => e("span", {}, [
    e("input", { type: "file", style: PW_STYLE }, [], { change: { dispatch: "vault.import" } }),
    e("span", { style: CAP_STYLE }, [t("load a sealed archive via the host, then =unlockVault()")]),
  ])],
  ["secrets",       secretsFn],
  ["domClients",    domClientsFn],
  ["vault.unlock", unlockHandler],
  ["vault.set",    setHandler],
  ["vault.setNamed", setNamedHandler],
  ["vault.startEdit", startEditHandler],
  ["vault.lock",   lockFnExported],
  ["vault.del",    delHandler],
  ["vault.export", exportHandler],
  ["vault.import", importHandler],
]));
