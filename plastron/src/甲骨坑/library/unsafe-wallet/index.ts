import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, ensureSegments, resolveFn, secretHandle } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// unsafe-wallet — api keys OUT of the graph, encrypted at rest.
//
// The agent-bridge design's Q3 answer (key custody: host-held, never in the
// graph) made concrete. Keys live in a module-scope Map once unlocked and an
// encrypted file at /plastron/wallet.json otherwise (PBKDF2-SHA-256 600k +
// AES-256-GCM via WebCrypto — browser and Bun, no deps). apiKey(name) returns a
// RESOLVER HANDLE, not the secret: { __key: name, resolve } — consumers (e.g.
// origin's claude()) call resolve() at the effect site, so cel values, saved
// archives, seed() dumps, and ranges fed to an LLM only ever carry the NAME.
// Secrets and the password enter through password-type inputs whose change
// events dispatch to the wallet.* handler cels below — never through formula
// source, never through 元.draft.
//
// UNSAFE because the name is honest: after unlock, any code running in the
// page (a js def, a hostile formula) can call a handle's resolve() or hook
// fetch at the effect site. This protects at-rest and against ACCIDENTAL
// graph leakage; active same-page malice is the review gate's territory.
//
// walletNote is a plain ValueCel the handlers write status into — put
// `=walletNote` in a cell for a reactive status readout.
// ============================================================================

const WALLET_PATH = "/plastron/wallet.json";
const KDF_ITERS = 600_000;

// ── module-scope runtime state (the host-held closure; matches the
//    host/file-store/sound singleton pattern; never dehydrated) ─────────────
let entries: Map<string, string> | null = null; // null = locked
let master: unknown | null = null;              // CryptoKey
let salt: Uint8Array | null = null;
let ephemeral = false;                          // OPFS unavailable → session-only, no file

// ── WebCrypto, structurally narrowed (tsconfig lib has no DOM) ──────────────
interface SubtleLike {
  importKey(format: string, key: Uint8Array, alg: unknown, extractable: boolean, usages: string[]): Promise<unknown>;
  deriveKey(params: unknown, base: unknown, derived: unknown, extractable: boolean, usages: string[]): Promise<unknown>;
  encrypt(params: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(params: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}
interface CryptoLike { subtle: SubtleLike; getRandomValues(a: Uint8Array): Uint8Array }
const cryptoHost = (): CryptoLike => {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!c?.subtle) throw new Error("unsafe-wallet: WebCrypto unavailable in this host");
  return c;
};

const utf8 = { enc: (s: string): Uint8Array => new TextEncoder().encode(s), dec: (b: ArrayBuffer): string => new TextDecoder().decode(b) };
const b64 = {
  enc: (b: Uint8Array): string => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); },
  dec: (s: string): Uint8Array => { const raw = atob(s); const out = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i); return out; },
};

const deriveMaster = async (password: string, kdfSalt: Uint8Array): Promise<unknown> => {
  const { subtle } = cryptoHost();
  const base = await subtle.importKey("raw", utf8.enc(password), { name: "PBKDF2" }, false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: kdfSalt, iterations: KDF_ITERS },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
};

// ── encrypted file ⇄ entries (over file-store's fs.*) ───────────────────────
const fsCall = async (state: State, k: string, ...a: unknown[]): Promise<unknown> => {
  await ensureSegments(state, ["file-store"]);
  return (resolveFn(state, k) as Fn)(...a);
};

// Persist the encrypted wallet to OPFS. If the host has no usable storage
// (e.g. a no-OPFS context), fall back to an EPHEMERAL session wallet —
// keys live in memory for this tab only, never written. Returns true if
// it wrote a file, false if it went ephemeral.
const persist = async (state: State): Promise<boolean> => {
  if (!entries || !master || !salt) throw new Error("unsafe-wallet: persist while locked");
  if (ephemeral) return false;
  const c = cryptoHost();
  const nonce = c.getRandomValues(new Uint8Array(12));
  const plain = utf8.enc(JSON.stringify(Object.fromEntries(entries)));
  const data = new Uint8Array(await c.subtle.encrypt({ name: "AES-GCM", iv: nonce }, master, plain));
  const file = { v: 1, kdf: { alg: "PBKDF2-SHA-256", n: KDF_ITERS, salt: b64.enc(salt) }, nonce: b64.enc(nonce), data: b64.enc(data) };
  try {
    await fsCall(state, "fs.mkdir", "/plastron");
    await fsCall(state, "fs.writeText", WALLET_PATH, JSON.stringify(file));
    return true;
  } catch {
    ephemeral = true; // storage unavailable — keep going in-memory
    return false;
  }
};

const note = async (state: State, msg: string): Promise<void> => {
  await (resolveFn(state, "setValue") as Fn)(state, "walletNote", msg);
  // setValue re-fires walletNote-dependent cels via the cascade — including any
  // =walletKeys(walletNote) genesis cel, whose request updates but isn't
  // materialized until genesis.commit drains (a fresh origin.commit drains it;
  // an input-driven re-fire does not). Drain it so per-key cels regenerate,
  // then paint. No-op when no genesis cel depends on the wallet.
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

/** apiKey(name) — a kernel SecretHandle: the NAME plus a resolver the wallet
 *  closes over. NOT the secret. The kernel guarantees it never persists more
 *  than its name (dehydrate sanitizes it); resolution happens at the effect
 *  site (e.g. inside claude()'s fetch), never as a cel value. */
const keyFn: Fn = (name: unknown) => {
  const n = String(name ?? "");
  return secretHandle(n, () => entries?.get(n));
};

// walletKeys(trigger) — GENESIS: materialize one ROW per stored key into a
// `keys` worksheet: column A = the live handle (renders 🔑 name, referenceable
// as =claude(chat!A1, keys!A1)); column B = a delete button (✕ → wallet.del).
// Pass walletNote so it regenerates when keys change / the wallet locks. Per-key
// cels. Locked / empty → no cels (the genesis sweep removes prior key rows).
const DEL_STYLE = "font-family:ui-monospace,monospace;font-size:.75rem;padding:.1rem .4rem;border:1px solid #d4453e55;border-radius:.3rem;background:#d4453e1a;color:#d4453e;cursor:pointer";
const walletKeysFn: Fn = (_trigger?: unknown): { genesis: true; layer: string; cels: Record<string, unknown> } => {
  const cels: Record<string, unknown> = {};
  if (entries) {
    [...entries.keys()].sort().forEach((name, i) => {
      const row = i + 1;
      // A: a ValueCel holding the live handle — 🔑 name, referenceable. The
      // resolver reads live `entries`; dehydrate sanitizes it.
      cels[`keys.A${row}`] = { celType: "ValueCel", v: secretHandle(name, () => entries?.get(name)), metadata: { name: `A${row}` } };
      // B: a delete button (a plain-data vnode — no closures); click dispatches
      // wallet.del with the key name; the form-control guard keeps the click
      // from hijacking into cell-edit.
      cels[`keys.B${row}`] = { celType: "ValueCel", metadata: { name: `B${row}` },
        v: e("button", { type: "button", title: `delete "${name}"`, style: DEL_STYLE }, [t("✕")], { click: { dispatch: "wallet.del", payload: name } }) };
    });
  }
  return { genesis: true, layer: "keys", cels };
};

// locked(trigger?) — the lock state as a BOOLEAN value (true = locked). Pass a
// reactive cel (=locked(walletNote)) so it tracks lock/unlock. This is the
// "A1's value is true/false" cell: editKey/others can depend on it.
const lockedFn: Fn = (_trigger?: unknown): boolean => !entries;

// editKey(lockCell, name) — per-key edit + delete in ONE cell. Pass the lock
// cell (=wallet() or =locked(walletNote)) as the FIRST arg so this cell depends
// on it and re-evaluates on lock/unlock (reactivity through inputMap — the lock
// cell IS the dependency). Gated on the live lock state: locked → can't edit;
// unlocked → a secret box to set/update the key + a ✕ to delete it. One cell per
// key you want to manage: =editKey(A1, "anthropic").
const editKeyFn: Fn = (_lock: unknown, name: unknown): unknown => {
  const n = String(name ?? "").trim();
  if (!n) return "(editKey: name a key — =editKey(A1, \"anthropic\"))";
  if (!entries) return e("span", { style: STAT_STYLE }, [t(`🔒 ${n} — unlock to edit`)]);
  const has = entries.has(n);
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
  if (!entries) return "(wallet locked — =unlockWallet())";
  if (entries.size === 0) return "(wallet empty — =setKey(\"anthropic\"))";
  return [...entries.keys()].sort().join("\n");
};

const unlockWalletFn: Fn = () =>
  pwInput("wallet.unlock", undefined, "choose a wallet password…",
    "Enter = unlock (no default — your first password CREATES the wallet); status: =walletNote");

// setKey(name [, trigger]) — pass walletNote as `trigger` so this cel
// re-fires when the wallet locks/unlocks (a fn can't make its callers depend
// on wallet state; the explicit trigger is the plastron-idiomatic wiring,
// same as the =wallet(walletNote) panel). Without it, the box stays at its
// boot-time message even after you unlock.
const setKeyFn: Fn = (name: unknown, _trigger?: unknown) => {
  const n = String(name ?? "").trim();
  if (!n) return "(setKey: name it, e.g. =setKey(\"anthropic\", walletNote))";
  if (!entries) return "(wallet locked — =unlockWallet(), then =setKey(\"anthropic\", walletNote))";
  return pwInput("wallet.set", n, `secret for "${n}"…`,
    `Enter = store; then use it as apiKey("${n}")`);
};

// A lock BUTTON (locks on click, not on render — rendering a =lockWallet()
// cell must not lock the wallet just by existing). The imperative lock lives
// in the wallet.lock handler, shared with the wallet() panel.
const BTN_STYLE = "font-family:ui-monospace,monospace;font-size:.8rem;padding:.15rem .55rem;border:1px solid #8884;border-radius:.3rem;background:#8881;cursor:pointer";
const lockWalletFn: Fn = (): V =>
  e("button", { type: "button", style: BTN_STYLE }, [t("🔒 lock")], { click: { dispatch: "wallet.lock" } });

// wallet(trigger) — a reactive, SELF-CONTAINED wallet UI. Pass a reactive cel
// (=wallet(walletNote)) so it re-renders on every lock/unlock/set: the handlers
// bump walletNote, this cel re-fires, and reads live module state. Locked → the
// unlock box. Unlocked → status + lock button + the key names + an add-a-key
// row (name field → wallet.newName cel; secret field → wallet.setNamed). Add-key
// lives HERE, inside the unlocked state, NOT as a standalone =setKey cell that
// would need its own trigger — you can't set a key on a locked wallet, so the
// affordance belongs where "unlocked" already is, with the dependency intrinsic.
const PANEL_STYLE = "display:flex;align-items:center;gap:.5rem;flex-wrap:wrap";
const COL_STYLE = "display:flex;flex-direction:column;gap:.35rem";
const STAT_STYLE = "font-family:ui-monospace,monospace;font-size:.82rem;color:CanvasText";
const NAME_STYLE = "font-family:ui-monospace,monospace;font-size:.85rem;padding:.15rem .4rem;border:1px solid #8884;border-radius:.3rem;background:#8881;min-width:8rem";
const walletFn: Fn = (_trigger?: unknown): V => {
  if (!entries) {
    return e("div", { style: PANEL_STYLE }, [
      e("span", { style: STAT_STYLE }, [t("🔒 locked")]),
      pwInput("wallet.unlock", undefined, "wallet password…",
        "Enter = unlock (first password creates the wallet)"),
    ]);
  }
  const n = entries.size;
  const names = [...entries.keys()].sort();
  return e("div", { style: COL_STYLE }, [
    e("div", { style: PANEL_STYLE }, [
      e("span", { style: STAT_STYLE }, [t(`🔓 unlocked — ${n} key${n === 1 ? "" : "s"}${ephemeral ? " · session-only" : ""}`)]),
      e("button", { type: "button", style: BTN_STYLE }, [t("🔒 lock")], { click: { dispatch: "wallet.lock" } }),
    ]),
    // each stored key as a chip with a ✕ delete button (dispatch wallet.del).
    // This renders + refreshes correctly because the panel is one reactive cel
    // (re-fires on walletNote); it does NOT need the keys-worksheet rendering.
    ...(names.length ? [e("div", { style: PANEL_STYLE }, names.map((name) =>
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

const exportWalletFn: Fn = () =>
  e("button", { type: "button", style: PW_STYLE }, [t("⬇ wallet.json (encrypted)")], { click: { dispatch: "wallet.export" } });

const importWalletFn: Fn = () =>
  e("span", {}, [
    e("input", { type: "file", style: PW_STYLE }, [], { change: { dispatch: "wallet.import" } }),
    e("span", { style: CAP_STYLE }, [t("pick an exported wallet.json, then =unlockWallet()")]),
  ]);

// ── handlers — called (state, payload, event) by the dispatch binding ───────
type InputEvent = { target?: { value?: string; files?: ArrayLike<{ text(): Promise<string> }> } };

const unlockHandler: Fn = async (stateArg: unknown, _payload: unknown, event: unknown) => {
  const state = stateArg as State;
  if (!shouldSubmit(event)) return state; // ignore every non-Enter keystroke
  const target = (event as InputEvent)?.target;
  const pw = String(target?.value ?? "");
  if (!pw) return state;
  if (target) target.value = "";
  try {
    let raw: string | null = null;
    try { raw = String(await fsCall(state, "fs.readText", WALLET_PATH)); } catch { raw = null; }
    if (raw) {
      const file = JSON.parse(raw) as { v: number; kdf: { n: number; salt: string }; nonce: string; data: string };
      const s = b64.dec(file.kdf.salt);
      const m = await deriveMaster(pw, s);
      const plain = await cryptoHost().subtle.decrypt({ name: "AES-GCM", iv: b64.dec(file.nonce) }, m, b64.dec(file.data));
      entries = new Map(Object.entries(JSON.parse(utf8.dec(plain)) as Record<string, string>));
      master = m; salt = s;
      await note(state, `(wallet unlocked — ${entries.size} key${entries.size === 1 ? "" : "s"}; =apiKeys())`);
    } else {
      salt = cryptoHost().getRandomValues(new Uint8Array(16));
      master = await deriveMaster(pw, salt);
      entries = new Map();
      const wrote = await persist(state);
      await note(state, wrote
        ? "(new wallet created — =setKey(\"anthropic\") next)"
        : "(session wallet — no storage here, keys live for this tab only; =setKey(\"anthropic\"))");
    }
  } catch {
    entries = null; master = null; salt = null;
    await note(state, "(unlock failed — wrong password?)");
  }
  return state;
};

const setHandler: Fn = async (stateArg: unknown, payload: unknown, event: unknown) => {
  const state = stateArg as State;
  if (!shouldSubmit(event)) return state; // ignore every non-Enter keystroke
  const target = (event as InputEvent)?.target;
  const secret = String(target?.value ?? "");
  if (!secret) return state;
  if (target) target.value = "";
  if (!entries) { await note(state, "(wallet locked — =unlockWallet() first)"); return state; }
  const n = String(payload ?? "");
  entries.set(n, secret);
  await persist(state);
  await note(state, `(stored "${n}" — ${entries.size} key${entries.size === 1 ? "" : "s"}; use apiKey("${n}"))`);
  return state;
};

type DomDownload = {
  document?: { createElement(t: string): { href: string; download: string; click(): void; remove(): void }; body: { appendChild(n: unknown): void } };
  URL?: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void };
  Blob?: new (parts: unknown[]) => unknown;
};

const exportHandler: Fn = async (stateArg: unknown) => {
  const state = stateArg as State;
  const g = globalThis as DomDownload;
  if (!g.document || !g.URL || !g.Blob) return state;
  let raw: string;
  try { raw = String(await fsCall(state, "fs.readText", WALLET_PATH)); }
  catch { await note(state, "(nothing to export — no wallet yet; =unlockWallet() creates one)"); return state; }
  const url = g.URL.createObjectURL(new g.Blob([raw]));
  const a = g.document.createElement("a");
  a.href = url; a.download = "wallet.json";
  g.document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => g.URL!.revokeObjectURL(url), 1000);
  return state;
};

const importHandler: Fn = async (stateArg: unknown, _payload: unknown, event: unknown) => {
  const state = stateArg as State;
  const file = (event as InputEvent)?.target?.files?.[0];
  if (!file) return state;
  const raw = await file.text();
  try { JSON.parse(raw); } catch { await note(state, "(import failed — not a wallet file)"); return state; }
  await fsCall(state, "fs.mkdir", "/plastron");
  await fsCall(state, "fs.writeText", WALLET_PATH, raw);
  entries = null; master = null; salt = null;
  await note(state, "(wallet file imported — =unlockWallet() to open it)");
  return state;
};

// imperative lock — the core shared by the lock button and the wallet() panel.
// Bumps walletNote so any reactive panel re-renders to its locked state.
const lockHandler: Fn = async (stateArg: unknown) => {
  const state = stateArg as State;
  entries = null; master = null; salt = null;
  await note(state, "(wallet locked)");
  return state;
};

// delete a key — dispatched by a per-key ✕ button (payload = the name). Bumps
// walletNote so =walletKeys regenerates (the deleted row sweeps).
const delHandler: Fn = async (stateArg: unknown, name: unknown) => {
  const state = stateArg as State;
  if (!entries) return state;
  const n = String(name ?? "");
  if (entries.delete(n)) {
    await persist(state);
    await note(state, `(deleted "${n}" — ${entries.size} key${entries.size === 1 ? "" : "s"} left)`);
  }
  return state;
};

// add-a-key from the panel: the NAME was typed into the wallet.newName cel
// (names aren't secret — a cel is fine); the SECRET arrives on the event and
// never touches a cel. Reads both, stores, clears the name buffer, re-encrypts.
const setNamedHandler: Fn = async (stateArg: unknown, _payload: unknown, event: unknown) => {
  const state = stateArg as State;
  if (!shouldSubmit(event)) return state;
  if (!entries) { await note(state, "(wallet locked — unlock first)"); return state; }
  const target = (event as InputEvent)?.target;
  const secret = String(target?.value ?? "");
  const name = String(state.cels.get("wallet.newName")?.v ?? "").trim();
  if (!name) { await note(state, "(name the key in the left box, then enter the secret)"); return state; }
  if (!secret) return state;
  if (target) target.value = "";
  entries.set(name, secret);
  await persist(state);
  await (resolveFn(state, "setValue") as Fn)(state, "wallet.newName", "");
  await note(state, `(stored "${name}" — ${entries.size} key${entries.size === 1 ? "" : "s"}; use apiKey("${name}"))`);
  return state;
};

// edit a key (panel ✎): populate the add-key NAME buffer so the next secret
// entered on the right OVERWRITES this key (re-encrypts). Names aren't secret.
const startEditHandler: Fn = async (stateArg: unknown, payload: unknown): Promise<unknown> => {
  const state = stateArg as State;
  const name = String(payload ?? "").trim();
  await (resolveFn(state, "setValue") as Fn)(state, "wallet.newName", name);
  await note(state, `(editing "${name}" — enter the new secret on the right, Enter to save)`);
  return state;
};

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
  ["exportWallet",  exportWalletFn],
  ["importWallet",  importWalletFn],
  ["wallet.unlock", unlockHandler],
  ["wallet.set",    setHandler],
  ["wallet.setNamed", setNamedHandler],
  ["wallet.startEdit", startEditHandler],
  ["wallet.lock",   lockHandler],
  ["wallet.del",    delHandler],
  ["wallet.export", exportHandler],
  ["wallet.import", importHandler],
]));
