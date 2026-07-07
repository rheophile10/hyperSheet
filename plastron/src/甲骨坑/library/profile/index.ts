import type { 甲骨, Cel, Fn, State, VNode, AttrValue, EventBinding } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import { el as makeEl, text as T } from "../dom/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// profile — the identity WALLET UI (encrypted-collaborative-sheetapp Phase 1).
// A gen-2 window over the `keystore` library: create / unlock / reshuffle /
// change-passcode / set-name / export-file / import-file / show-recovery-phrase.
//
// Reactivity (inputMap doctrine): the render verb `profileui` is PURE; the verbs
// behind the buttons (profile.*) read the draft cels (profile.p1/p2/nm/imp),
// call keystore.*, and write profile.msg / profile.phrase + the keystore status
// cels — which the content formula references, so it re-renders. No private key
// ever reaches a cel (the keyring lives module-scope inside keystore).
// ============================================================================

type V = VNode;
const el = (tag: string, attrs: Record<string, AttrValue>, children: V[] = [], events?: Record<string, EventBinding>): V =>
  makeEl(tag, attrs as Record<string, AttrValue>, children as VNode[], events as Record<string, EventBinding> | undefined) as V;

const BTN = "padding:.3rem .6rem;border:1px solid #8884;border-radius:.4rem;cursor:pointer;font:.8rem system-ui;background:#8881;color:CanvasText";
const INP = "width:100%;box-sizing:border-box;padding:.3rem .4rem;border:1px solid #8884;border-radius:.4rem;font:.82rem ui-monospace,monospace;background:Canvas;color:CanvasText";
const ROW = "display:flex;flex-direction:column;gap:.25rem;margin:.45rem 0";
const pw = (key: string, ph: string): V => el("input", { type: "password", class: "pf-in", value: "", placeholder: ph, style: INP }, [], { input: { set: key, extract: "value" } });
const txt = (key: string, val: string, ph: string): V => el("input", { type: "text", class: "pf-in", value: val, placeholder: ph, style: INP }, [], { input: { set: key, extract: "value" } });
const btn = (label: string, dispatch: string, cls = ""): V => el("button", { type: "button", class: "pf-btn " + cls, style: BTN }, [T(label)], { click: { dispatch } });
const sectionTitle = (s: string): V => el("div", { style: "font:600 .8rem system-ui;margin:.7rem 0 .1rem;opacity:.8" }, [T(s)]);

// profileui(status, name, identity, p1, p2, nm, imp, msg, phrase) — PURE render.
const profileuiFn: Fn = ((status?: unknown, name?: unknown, identity?: unknown, _p1?: unknown, _p2?: unknown, nm?: unknown, _imp?: unknown, msg?: unknown, phrase?: unknown): V => {
  const st = String(status ?? "none");
  const nameV = String(name ?? ""), idV = String(identity ?? ""), idShort = idV ? idV.slice(0, 14) + "…" : "";
  const msgV = String(msg ?? ""), phraseV = String(phrase ?? "");
  const body: V[] = [];

  if (st === "none") {
    body.push(el("p", { style: "margin:.2rem 0;opacity:.85;font:.85rem system-ui" }, [T("Create your plastron identity — a keypair sealed under a passcode you choose. The passcode is UNRECOVERABLE (write down the recovery phrase you get).")]));
    body.push(el("div", { style: ROW }, [el("label", { style: "font:.78rem system-ui;opacity:.7" }, [T("Display name (optional)")]), txt("profile.nm", String(nm ?? ""), "Ada Lovelace")]));
    body.push(el("div", { style: ROW }, [el("label", { style: "font:.78rem system-ui;opacity:.7" }, [T("Passcode (≥4 chars)")]), pw("profile.p1", "passcode"), pw("profile.p2", "confirm passcode")]));
    body.push(btn("Create identity", "profile.create"));
  } else if (st === "locked") {
    body.push(el("p", { style: "margin:.2rem 0;opacity:.85;font:.85rem system-ui" }, [T("A sealed identity exists. Unlock it with your passcode.")]));
    body.push(el("div", { style: ROW }, [pw("profile.p1", "passcode")]));
    body.push(btn("🔓 Unlock", "profile.unlock"));
    body.push(sectionTitle("…or import a keystore file"));
    body.push(el("textarea", { class: "pf-imp", rows: 3, placeholder: "paste keystore file contents", style: INP }, [], { input: { set: "profile.imp", extract: "value" } }));
    body.push(el("div", { style: "display:flex;gap:.4rem;align-items:center" }, [el("input", { type: "file", class: "pf-file", style: "font:.75rem system-ui" }, [], { change: { dispatch: "profile.importfile" } }), pw("profile.p1b", "file passcode")]));
    body.push(btn("Import", "profile.import"));
  } else {
    body.push(el("div", { style: "font:600 .95rem system-ui;margin:.1rem 0" }, [T("👤 " + (nameV || "Anonymous"))]));
    body.push(el("div", { style: "font:.72rem ui-monospace,monospace;opacity:.6;margin-bottom:.3rem" }, [T("identity " + idShort)]));
    body.push(el("div", { style: ROW }, [el("label", { style: "font:.78rem system-ui;opacity:.7" }, [T("Display name")]), txt("profile.nm", nameV, "name"), btn("Set name", "profile.setname")]));
    body.push(sectionTitle("Keys"));
    body.push(el("div", { style: "display:flex;gap:.4rem;flex-wrap:wrap" }, [btn("🔀 Reshuffle keypair", "profile.reshuffle"), btn("⬇ Export keystore file", "profile.export"), btn("🔑 Show recovery phrase", "profile.seed"), btn("🔒 Lock", "profile.lock")]));
    if (phraseV) body.push(el("div", { style: "margin:.4rem 0;padding:.4rem;border:1px dashed #c80;border-radius:.4rem;font:.8rem ui-monospace,monospace;background:#c8801a18" }, [T("recovery phrase (write it down): " + phraseV)]));
    body.push(sectionTitle("Change passcode"));
    body.push(el("div", { style: ROW }, [pw("profile.p1", "current passcode"), pw("profile.p2", "new passcode"), btn("Change passcode", "profile.changepass")]));
  }
  if (msgV) body.push(el("div", { class: "pf-msg", style: "margin-top:.5rem;padding:.35rem .5rem;border-radius:.4rem;font:.8rem system-ui;background:#4a90d922" }, [T(msgV)]));

  return el("div", { class: "profile-app", style: "display:flex;flex-direction:column;height:100%;overflow:auto;padding:.6rem .8rem;font:.85rem system-ui;color:CanvasText" }, body);
}) as Fn;

// ── handler glue: read drafts → keystore.* → write profile.msg/.phrase → repaint ─
const get = (s: State, k: string): string => String(s.cels.get(k)?.v ?? "");
const setMsg = async (s: State, msg: string, phrase = ""): Promise<void> => {
  await (resolveFn(s, "setValueBatch") as Fn)(s, [["profile.msg", msg], ["profile.phrase", phrase]]);
};
const clearDrafts = async (s: State, keys: string[]): Promise<void> => {
  await (resolveFn(s, "setValueBatch") as Fn)(s, keys.map((k) => [k, ""]));
};
const repaint = async (s: State): Promise<void> => {
  await (resolveFn(s, "runCycle") as Fn)(s);
  // land re-fired =view requests (the wallet renders in a view pane now) —
  // the cycle re-derives the =view formula to a request; the effects drain
  // lands it back into the pane slot, THEN paint (the kvSettle order).
  const dr = resolveFn(s, "drain") as Fn;
  if (s.cels.get("origin.effects")) await dr(s, "origin.effects");
  await dr(s, "dom.paint");
};
const KS = (s: State, verb: string, ...a: unknown[]): Promise<unknown> => (resolveFn(s, verb) as Fn)(s, ...a) as Promise<unknown>;
const isErr = (r: unknown): r is { error: string } => !!r && typeof r === "object" && (r as { ok?: boolean }).ok === false;

const createFn: Fn = (async (s: State): Promise<State> => {
  const p1 = get(s, "profile.p1"), p2 = get(s, "profile.p2");
  if (p1 !== p2) { await setMsg(s, "Passcodes don't match."); await repaint(s); return s; }
  const r = await KS(s, "keystore.create", p1, get(s, "profile.nm")) as { ok: boolean; phrase?: string; error?: string };
  await clearDrafts(s, ["profile.p1", "profile.p2"]);
  if (isErr(r)) await setMsg(s, r.error); else await setMsg(s, "Identity created. SAVE this recovery phrase:", r.phrase ?? "");
  await repaint(s); return s;
}) as Fn;
// after a successful unlock, unlocking the wallet IS logging in to plastron:
// restore the wallet-wrapped session sidecars, fan each restored name out to
// its provider's refresh op (supabase.<project> → supabase.auth refresh), and
// re-persist any session that was signed in while the wallet was locked.
const restoreSessions = async (s: State): Promise<string> => {
  const restore = resolveFn(s, "session.restore") as Fn | undefined;
  if (!restore) return "";
  const names = await (restore(s) as Promise<string[]>).catch(() => [] as string[]);
  let ok = 0;
  for (const n of names) {
    const m = /^supabase\.(.+)$/.exec(n);
    const auth = m ? resolveFn(s, "supabase.auth") as Fn | undefined : undefined;
    if (!m || !auth) continue;
    try { const msg = String(await auth(s, "refresh", m[1])); if (/refreshed/.test(msg)) ok++; } catch { /* revoked/offline — stays signed out */ }
  }
  const persist = resolveFn(s, "session.persist") as Fn | undefined;
  if (persist) await (persist(s) as Promise<unknown>).catch(() => { /* best-effort */ });
  return ok ? ` ${ok} session${ok > 1 ? "s" : ""} restored.` : "";
};

const unlockFn: Fn = (async (s: State): Promise<State> => {
  const r = await KS(s, "keystore.unlock", get(s, "profile.p1")) as { ok: boolean; error?: string };
  await clearDrafts(s, ["profile.p1"]);
  if (isErr(r)) { await setMsg(s, r.error); await repaint(s); return s; }
  const sessions = await restoreSessions(s);
  await setMsg(s, `Unlocked.${sessions}`); await repaint(s); return s;
}) as Fn;
const lockFn: Fn = (async (s: State): Promise<State> => { await KS(s, "keystore.lock"); await setMsg(s, "Locked."); await repaint(s); return s; }) as Fn;
const reshuffleFn: Fn = (async (s: State): Promise<State> => {
  const r = await KS(s, "keystore.reshuffle") as { ok: boolean; history?: number; error?: string };
  await setMsg(s, isErr(r) ? r.error : `New keypair minted (old one kept in history — ${r.history} retired).`); await repaint(s); return s;
}) as Fn;
const changepassFn: Fn = (async (s: State): Promise<State> => {
  const r = await KS(s, "keystore.changePasscode", get(s, "profile.p1"), get(s, "profile.p2")) as { ok: boolean; error?: string };
  await clearDrafts(s, ["profile.p1", "profile.p2"]);
  await setMsg(s, isErr(r) ? r.error : "Passcode changed."); await repaint(s); return s;
}) as Fn;
const setnameFn: Fn = (async (s: State): Promise<State> => {
  const r = await KS(s, "keystore.setName", get(s, "profile.nm")) as { ok: boolean; error?: string };
  await setMsg(s, isErr(r) ? r.error : "Name updated."); await repaint(s); return s;
}) as Fn;
const seedFn: Fn = (async (s: State): Promise<State> => {
  const r = await KS(s, "keystore.seedPhrase") as { ok: boolean; phrase?: string; error?: string };
  if (isErr(r)) await setMsg(s, r.error); else await setMsg(s, "Recovery phrase — write it down, it is your only backup besides the file:", r.phrase ?? "");
  await repaint(s); return s;
}) as Fn;
const importFn: Fn = (async (s: State): Promise<State> => {
  const pass = get(s, "profile.p1b") || get(s, "profile.p1");
  const r = await KS(s, "keystore.import", get(s, "profile.imp"), pass) as { ok: boolean; name?: string; error?: string };
  await clearDrafts(s, ["profile.p1", "profile.p1b", "profile.imp"]);
  if (isErr(r)) { await setMsg(s, r.error); await repaint(s); return s; }
  const sessions = await restoreSessions(s);   // an imported wallet can unwrap its own sidecars
  await setMsg(s, `Imported "${r.name ?? ""}". Unlocked.${sessions}`); await repaint(s); return s;
}) as Fn;

// profile.export — keystore.export → trigger a browser download of identity.kc.
interface DLHost { document?: { createElement(t: string): { href: string; download: string; click(): void } }; URL?: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void }; Blob?: new (parts: unknown[], o: unknown) => unknown }
const exportFn: Fn = (async (s: State): Promise<State> => {
  const blob = await KS(s, "keystore.export") as unknown;
  if (typeof blob !== "string") { await setMsg(s, "Nothing to export (unlock first)."); await repaint(s); return s; }
  const g = globalThis as DLHost;
  if (g.document && g.URL?.createObjectURL && g.Blob) {
    const url = g.URL.createObjectURL(new g.Blob([blob], { type: "application/json" }));
    const a = g.document.createElement("a"); a.href = url; a.download = "plastron-identity.kc"; a.click(); g.URL.revokeObjectURL(url);
    await setMsg(s, "Exported plastron-identity.kc — keep it safe (it's sealed under your passcode).");
  } else await setMsg(s, "Export unavailable off-browser.");
  await repaint(s); return s;
}) as Fn;

// profile.importfile — a <input type=file> change: read the file text into the
// import draft. Browser File API (best-effort; off-browser is a no-op).
const importfileFn: Fn = (async (s: State, _p: unknown, event?: unknown): Promise<State> => {
  const e = event as { target?: { files?: ArrayLike<{ text?: () => Promise<string> }> } } | undefined;
  const file = e?.target?.files?.[0];
  if (file?.text) { try { const txtBlob = await file.text(); await (resolveFn(s, "setValue") as Fn)(s, "profile.imp", txtBlob); await setMsg(s, "File loaded — enter its passcode and Import."); } catch { await setMsg(s, "Couldn't read the file."); } }
  await repaint(s); return s;
}) as Fn;

// profilewin() — GENESIS: the gen-2 profile WINDOW (self-mounting wframe).
// Legacy standalone window; the 👤 Profile desktop icon now opens the identity
// sheetapp doc (doc:identity), whose wallet =view renders profileui directly.
const profilewinFn: Fn = ((): unknown => {
  const lay = "win.profile", sref = `${lay}.state`, cref = `${lay}.content`;
  return { genesis: true, kind: "window", layer: lay, cels: {
    [cref]: { celType: "FormulaCel", f: "(profileui keystore.status keystore.name keystore.identity profile.p1 profile.p2 profile.nm profile.imp profile.msg profile.phrase)", metadata: { name: "content", parser: "f", segment: lay } },
    [sref]: { celType: "ValueCel", v: { ref: sref, x: 200, y: 90, w: 420, h: 520, z: 1, min: 0, max: 0, closed: 0, title: "👤 Profile", tabs: [{ ref: cref, title: "Identity" }], active: 0 }, metadata: { name: "state", segment: lay } },
    [`${lay}.frame`]: { celType: "FormulaCel", f: `(mount ".origin" (wframe ${sref} win.active ${cref}))`, metadata: { name: "frame", parser: "f", segment: lay } },
  } };
}) as Fn;

export const name = "profile" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["profileui", profileuiFn],
  ["profilewin", profilewinFn],
  ["profile.create", createFn],
  ["profile.unlock", unlockFn],
  ["profile.lock", lockFn],
  ["profile.reshuffle", reshuffleFn],
  ["profile.changepass", changepassFn],
  ["profile.setname", setnameFn],
  ["profile.seed", seedFn],
  ["profile.import", importFn],
  ["profile.importfile", importfileFn],
  ["profile.export", exportFn],
]));
