import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import {
  bindNativeFns, ensureSegments, resolveFn, secretHandle,
  setAccessPolicy, hasDeclaredPolicy, canGet, currentAccessor, accessPolicyOf,
} from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// unsafe-wallet — api keys as SEALED cels, gated at runtime, encrypted at rest
// by the two GENERAL mechanisms (no bespoke wallet crypto anymore).
//
// The bespoke module-scope key Map + PBKDF2/AES-GCM wallet file is GONE.
// The wallet's two jobs are now covered by the substrate's own mechanisms:
//
//   • LAYER 1 (runtime protection): keys live as cels in a SEALED `secrets`
//     segment — `secrets.<name>` = the secret string — with access policy
//     { get: ["clients"], getSealed: true, set: "private" }. A FORMULA reading
//     `secrets.*` from a non-whitelisted segment resolves to #DENIED (the
//     kernel's GET choke point). But apiKey(name) is a NATIVE verb, and a
//     native verb's direct state.cels.get BYPASSES that formula-dep gating —
//     so apiKey GATES ITSELF: it explicitly checks canGet(state,
//     currentAccessor(state), "secrets") and refuses (an error string) unless
//     the calling segment is whitelisted. Only a `clients`-segment formula
//     (or another listed reader) gets the real key.
//
//   • LAYER 2 (at-rest protection): on unlock the wallet calls
//     seal.lock(password). That derives the seal data key (PBKDF2 once, in the
//     seal library) and installs the kernel's seal hooks, so every `secrets.*`
//     cel (its segment is get-SEALED) DEHYDRATES as { __sealed: … } ciphertext
//     and HYDRATES back only under the same password. The wallet no longer
//     owns any crypto, salt, nonce, or wallet.json file.
//
// "Unlock" therefore means: seal.lock(password) (so secrets decrypt on load /
// encrypt on save) + mark the wallet runtime-unlocked so the panel/readers
// surface the stored key NAMES. Names aren't secret — the readers (apiKeys,
// the panel, the keys worksheet) enumerate them from a module-scope name set;
// the SECRET values never leave the gated `secrets` cels.
//
// UNSAFE because the name is honest: once unlocked, a whitelisted-segment
// formula (or same-page malice) can reach the key at the effect site. Layer 1
// stops cross-segment graph leakage; Layer 2 stops at-rest leakage; active
// same-page malice is the review gate's territory.
//
// walletNote is a plain ValueCel the handlers write status into — put
// `=walletNote` in a cell for a reactive status readout.
// ============================================================================

const SECRETS_SEGMENT = "secrets" as const;
// The reader allowlist — segments whose FORMULAS / whose apiKey() calls may
// read a stored secret. `clients` (clientsheet's makeclient cels) is the seed
// reader; getSealed makes the segment encrypt at rest; set: "private" keeps
// the data-plane writes top-level/privileged only.
const SECRETS_POLICY = { get: ["clients"], getSealed: true, set: "private" as const };
const secretKey = (name: string): string => `${SECRETS_SEGMENT}.${name}`;

// ── module-scope runtime state (host-held; never dehydrated; the seal lib
//    holds the actual data key — this module holds only NON-secret bookkeeping:
//    which key NAMES exist + whether the wallet is runtime-unlocked + the live
//    state so the native apiKey verb can read+gate the secrets cels) ──────────
let names: Set<string> | null = null;   // null = locked; else the stored key NAMES (not secret)
let ephemeral = false;                   // seal/storage unavailable → session-only note
let stateRef: State | null = null;       // last state seen by a handler — apiKey reads secrets through it

// Capture the live state from any handler so the native apiKey verb (which the
// formula evaluator calls with ONLY its formula args — no state) can reach the
// secrets cels + the per-state accessor. Single-state in practice, exactly the
// seal/net/host module-singleton pattern.
const remember = (state: State): State => { stateRef = state; return state; };

// ── seal driver (Layer 2 at-rest) ──────────────────────────────────────────
// Unlock = install the seal hooks for this password (secrets encrypt on
// dehydrate, decrypt on hydrate). Lock = clear them. The seal library owns the
// PBKDF2 + AES; the wallet just drives it. Returns true if the seal hooks
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

// ── secrets segment + cels ──────────────────────────────────────────────────
// Mint the sealed `secrets` segment policy once (idempotent). Declaring the
// policy is what makes Layer 1 gate reads and Layer 2 seal at rest.
const ensureSecretsPolicy = (state: State): void => {
  if (!hasDeclaredPolicy(state, SECRETS_SEGMENT)) {
    setAccessPolicy(state, SECRETS_SEGMENT, SECRETS_POLICY);
  }
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
      metadata: { key, segment: SECRETS_SEGMENT, name },
    });
  }
  (names ??= new Set()).add(name);
};

const dropSecret = async (state: State, name: string): Promise<boolean> => {
  const key = secretKey(name);
  const existed = !!state.cels.get(key);
  // setValue can't delete a cel; blank it so no plaintext remains, then drop
  // the name from the live set so the readers stop listing it. (A locked
  // wallet re-deriving names from cels would see the blank.)
  if (existed) await (resolveFn(state, "setValue") as Fn)(state, key, "");
  names?.delete(name);
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
  await (resolveFn(state, "setValue") as Fn)(state, "walletNote", msg);
  // setValue re-fires walletNote-dependent cels via the cascade — including any
  // =walletKeys(walletNote) genesis cel, whose request updates but isn't
  // materialized until genesis.commit drains. Drain it so per-key cels
  // regenerate, then paint. No-op when no genesis cel depends on the wallet.
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
 *  which accepts a literal key) when the CALLER is whitelisted, else a #DENIED
 *  error string. THE GATE: a native verb's direct state.cels.get bypasses
 *  Layer-1's formula-dep gating, so apiKey re-applies the SAME predicate the
 *  kernel uses for formula reads — canGet(state, currentAccessor(state),
 *  "secrets") — and refuses any non-whitelisted accessor. So only a formula in
 *  `clients` (or another listed segment) gets the real key; any other
 *  segment's apiKey call gets the refusal. Top-level calls (no accessor, e.g.
 *  the effect site of a whitelisted client's send) are privileged. */
const keyFn: Fn = (name: unknown) => {
  const n = String(name ?? "");
  const state = stateRef;
  if (!state) return `#DENIED(apiKey "${n}": no wallet state — =unlockWallet() first)`;
  const accessor = currentAccessor(state);
  if (!canGet(state, accessor, SECRETS_SEGMENT)) {
    return `#DENIED(apiKey "${n}": segment "${accessor ?? "?"}" is not in secrets.get)`;
  }
  const v = rawSecret(state, n);
  if (!v) return `#NOKEY(apiKey "${n}": no such key — =unlockWallet(), then =setKey("${n}"))`;
  return v;
};

// walletKeys(trigger) — GENESIS: materialize one ROW per stored key into a
// `keys` worksheet: column A = a live handle (renders 🔑 name, referenceable),
// column B = a delete button (✕ → wallet.del). Pass walletNote so it
// regenerates when keys change / the wallet locks. Per-key cels. Locked /
// empty → no cels (the genesis sweep removes prior key rows). The handle's
// resolver reads the gated secrets cel through the captured state.
const DEL_STYLE = "font-family:ui-monospace,monospace;font-size:.75rem;padding:.1rem .4rem;border:1px solid #d4453e55;border-radius:.3rem;background:#d4453e1a;color:#d4453e;cursor:pointer";
const walletKeysFn: Fn = (_trigger?: unknown): { genesis: true; layer: string; cels: Record<string, unknown> } => {
  const cels: Record<string, unknown> = {};
  if (names) {
    [...names].sort().forEach((name, i) => {
      const row = i + 1;
      cels[`keys.A${row}`] = { celType: "ValueCel", v: secretHandle(name, () => (stateRef ? rawSecret(stateRef, name) : undefined)), metadata: { name: `A${row}` } };
      cels[`keys.B${row}`] = { celType: "ValueCel", metadata: { name: `B${row}` },
        v: e("button", { type: "button", title: `delete "${name}"`, style: DEL_STYLE }, [t("✕")], { click: { dispatch: "wallet.del", payload: name } }) };
    });
  }
  return { genesis: true, layer: "keys", cels };
};

// locked(trigger?) — the lock state as a BOOLEAN value (true = locked). Pass a
// reactive cel (=locked(walletNote)) so it tracks lock/unlock.
const lockedFn: Fn = (_trigger?: unknown): boolean => !names;

// editKey(lockCell, name) — per-key edit + delete in ONE cell. Pass the lock
// cell (=wallet() or =locked(walletNote)) as the FIRST arg so this cell depends
// on it and re-evaluates on lock/unlock. Locked → can't edit; unlocked → a
// secret box to set/update the key + a ✕ to delete it.
const editKeyFn: Fn = (_lock: unknown, name: unknown): unknown => {
  const n = String(name ?? "").trim();
  if (!n) return "(editKey: name a key — =editKey(A1, \"anthropic\"))";
  if (!names) return e("span", { style: STAT_STYLE }, [t(`🔒 ${n} — unlock to edit`)]);
  const has = names.has(n);
  const kids: V[] = [
    e("span", { style: STAT_STYLE }, [t(`🔑 ${n}${has ? "" : " · new"}`)]),
    e("input", { type: "password", placeholder: has ? "update secret… (Enter)" : "secret… (Enter)", style: PW_STYLE }, [],
      { change: { dispatch: "wallet.set", payload: n }, keydown: { dispatch: "wallet.set", payload: n } }),
  ];
  if (has) kids.push(e("button", { type: "button", title: `delete "${n}"`, style: DEL_STYLE }, [t("✕")],
    { click: { dispatch: "wallet.del", payload: n } }));
  return e("div", { style: PANEL_STYLE }, kids);
};

const keysFn: Fn = () => {
  if (!names) return "(wallet locked — =unlockWallet())";
  if (names.size === 0) return "(wallet empty — =setKey(\"anthropic\"))";
  return [...names].sort().join("\n");
};

const unlockWalletFn: Fn = () =>
  pwInput("wallet.unlock", undefined, "choose a wallet password…",
    "Enter = unlock (no default — your first password CREATES the wallet); status: =walletNote");

// setKey(name [, trigger]) — pass walletNote as `trigger` so this cel re-fires
// when the wallet locks/unlocks.
const setKeyFn: Fn = (name: unknown, _trigger?: unknown) => {
  const n = String(name ?? "").trim();
  if (!n) return "(setKey: name it, e.g. =setKey(\"anthropic\", walletNote))";
  if (!names) return "(wallet locked — =unlockWallet(), then =setKey(\"anthropic\", walletNote))";
  return pwInput("wallet.set", n, `secret for "${n}"…`,
    `Enter = store; then use it as apiKey("${n}")`);
};

// A lock BUTTON (locks on click, not on render).
const BTN_STYLE = "font-family:ui-monospace,monospace;font-size:.8rem;padding:.15rem .55rem;border:1px solid #8884;border-radius:.3rem;background:#8881;cursor:pointer";
const lockWalletFn: Fn = (): V =>
  e("button", { type: "button", style: BTN_STYLE }, [t("🔒 lock")], { click: { dispatch: "wallet.lock" } });

// wallet(trigger) — a reactive, SELF-CONTAINED wallet UI. Pass a reactive cel
// (=wallet(walletNote)) so it re-renders on every lock/unlock/set.
const PANEL_STYLE = "display:flex;align-items:center;gap:.5rem;flex-wrap:wrap";
const COL_STYLE = "display:flex;flex-direction:column;gap:.35rem";
const STAT_STYLE = "font-family:ui-monospace,monospace;font-size:.82rem;color:CanvasText";
const NAME_STYLE = "font-family:ui-monospace,monospace;font-size:.85rem;padding:.15rem .4rem;border:1px solid #8884;border-radius:.3rem;background:#8881;min-width:8rem";
const walletFn: Fn = (_trigger?: unknown): V => {
  if (!names) {
    return e("div", { style: PANEL_STYLE }, [
      e("span", { style: STAT_STYLE }, [t("🔒 locked")]),
      pwInput("wallet.unlock", undefined, "wallet password…",
        "Enter = unlock (first password creates the wallet)"),
    ]);
  }
  const n = names.size;
  const list = [...names].sort();
  return e("div", { style: COL_STYLE }, [
    e("div", { style: PANEL_STYLE }, [
      e("span", { style: STAT_STYLE }, [t(`🔓 unlocked — ${n} key${n === 1 ? "" : "s"}${ephemeral ? " · session-only" : ""}`)]),
      e("button", { type: "button", style: BTN_STYLE }, [t("🔒 lock")], { click: { dispatch: "wallet.lock" } }),
    ]),
    ...(list.length ? [e("div", { style: PANEL_STYLE }, list.map((name) =>
      e("span", { style: CHIP_STYLE }, [
        t(`🔑 ${name}`),
        e("button", { type: "button", title: `delete "${name}"`, style: DEL_STYLE }, [t("✕")],
          { click: { dispatch: "wallet.del", payload: name } }),
      ]))) ] : []),
    e("div", { style: PANEL_STYLE }, [
      e("input", { type: "text", placeholder: "new key name", style: NAME_STYLE }, [],
        { input: { set: "wallet.newName", extract: "value" } }),
      e("input", { type: "password", placeholder: "secret… (Enter to add)", style: PW_STYLE }, [],
        { change: { dispatch: "wallet.setNamed" }, keydown: { dispatch: "wallet.setNamed" } }),
    ]),
  ]);
};
const CHIP_STYLE = "display:inline-flex;align-items:center;gap:.3rem;font-family:ui-monospace,monospace;font-size:.82rem;padding:.1rem .2rem .1rem .45rem;border:1px solid #8884;border-radius:.4rem;background:#8881";

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
  // crypto, no wallet.json — the at-rest story is entirely seal-driven.
  const sealed = await sealLock(state, pw);
  ephemeral = !sealed;
  // Runtime-unlock: surface whatever secrets already exist (decrypted on
  // hydrate) plus any added this session.
  names = namesFromState(state);
  const n = names.size;
  await note(state, sealed
    ? (n > 0
        ? `(wallet unlocked — ${n} key${n === 1 ? "" : "s"}; =apiKeys())`
        : "(new wallet — =setKey(\"anthropic\") next; secrets seal at rest on save)")
    : "(session wallet — no WebCrypto here, secrets live for this tab only; =setKey(\"anthropic\"))");
  return state;
};

const setHandler: Fn = async (stateArg: unknown, payload: unknown, event: unknown) => {
  const state = remember(stateArg as State);
  if (!shouldSubmit(event)) return state; // ignore every non-Enter keystroke
  const target = (event as InputEvent)?.target;
  const secret = String(target?.value ?? "");
  if (!secret) return state;
  if (target) target.value = "";
  if (!names) { await note(state, "(wallet locked — =unlockWallet() first)"); return state; }
  const n = String(payload ?? "");
  await storeSecret(state, n, secret);
  await note(state, `(stored "${n}" — ${names.size} key${names.size === 1 ? "" : "s"}; use apiKey("${n}"))`);
  return state;
};

const lockHandler: Fn = async (stateArg: unknown) => {
  const state = remember(stateArg as State);
  names = null;
  await sealClear(state); // clear the seal hooks — secrets re-seal/stay sealed at rest
  await note(state, "(wallet locked)");
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

// add-a-key from the panel: the NAME was typed into the wallet.newName cel
// (names aren't secret — a cel is fine); the SECRET arrives on the event and
// never touches a cel value the graph can read across segments.
const setNamedHandler: Fn = async (stateArg: unknown, _payload: unknown, event: unknown) => {
  const state = remember(stateArg as State);
  if (!shouldSubmit(event)) return state;
  if (!names) { await note(state, "(wallet locked — unlock first)"); return state; }
  const target = (event as InputEvent)?.target;
  const secret = String(target?.value ?? "");
  const name = String(state.cels.get("wallet.newName")?.v ?? "").trim();
  if (!name) { await note(state, "(name the key in the left box, then enter the secret)"); return state; }
  if (!secret) return state;
  if (target) target.value = "";
  await storeSecret(state, name, secret);
  await (resolveFn(state, "setValue") as Fn)(state, "wallet.newName", "");
  await note(state, `(stored "${name}" — ${names.size} key${names.size === 1 ? "" : "s"}; use apiKey("${name}"))`);
  return state;
};

// edit a key (panel ✎): populate the add-key NAME buffer so the next secret
// entered on the right OVERWRITES this key. Names aren't secret.
const startEditHandler: Fn = async (stateArg: unknown, payload: unknown): Promise<unknown> => {
  const state = remember(stateArg as State);
  const name = String(payload ?? "").trim();
  await (resolveFn(state, "setValue") as Fn)(state, "wallet.newName", name);
  await note(state, `(editing "${name}" — enter the new secret on the right, Enter to save)`);
  return state;
};

// export/import — dehydrate-driven now. The ENCRYPTED form is the dehydrated
// archive (secrets seal via the seal hooks); the wallet no longer maintains a
// separate wallet.json. These remain as graceful affordances: export downloads
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
  a.href = url; a.download = "wallet-archive.json";
  g.document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => g.URL!.revokeObjectURL(url), 1000);
  return state;
};

const importHandler: Fn = async (stateArg: unknown, _payload: unknown, event: unknown) => {
  const state = remember(stateArg as State);
  const file = (event as InputEvent)?.target?.files?.[0];
  if (!file) return state;
  void fsCall; // file-store available if a host wants to persist the picked file
  await note(state, "(import a sealed archive via the host's load flow, then =unlockWallet())");
  return state;
};

const lockFnExported = lockHandler;

export const name = "unsafe-wallet" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["wallet",        walletFn],
  ["locked",        lockedFn],
  ["editKey",       editKeyFn],
  ["walletKeys",    walletKeysFn],
  ["apiKey",        keyFn],
  ["apiKeys",       keysFn],
  ["setKey",        setKeyFn],
  ["unlockWallet",  unlockWalletFn],
  ["lockWallet",    lockWalletFn],
  ["exportWallet",  () => e("button", { type: "button", style: PW_STYLE }, [t("⬇ wallet archive (sealed)")], { click: { dispatch: "wallet.export" } })],
  ["importWallet",  () => e("span", {}, [
    e("input", { type: "file", style: PW_STYLE }, [], { change: { dispatch: "wallet.import" } }),
    e("span", { style: CAP_STYLE }, [t("load a sealed archive via the host, then =unlockWallet()")]),
  ])],
  ["wallet.unlock", unlockHandler],
  ["wallet.set",    setHandler],
  ["wallet.setNamed", setNamedHandler],
  ["wallet.startEdit", startEditHandler],
  ["wallet.lock",   lockFnExported],
  ["wallet.del",    delHandler],
  ["wallet.export", exportHandler],
  ["wallet.import", importHandler],
]));

// silence "declared but never read" for the accessor introspection import kept
// for documentation/debug parity with the access module.
void accessPolicyOf;
