import type { 甲骨, Cel, Fn, State, VNode, AttrValue, EventBinding } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import { el as makeEl, text as T } from "../dom/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// winapps — generic UI for WINDOWED APPS (windowing-architecture.md). Toolbars +
// buttons that ANY app composes into its window content. The window FRAME lives in
// `window`; SHEET-specific UI (the grid) lives in `sheets`. Here lives only what is
// reusable across apps — the chrome an app puts ABOVE its content.
//
// (Phase 3 will also move the winapp(id,title,body) constructor + the application-
// segment-contract cels here; for now this is the shared toolbar vocabulary.)
// ============================================================================

type V = VNode;
const el = makeEl as unknown as (tag: string, attrs?: Record<string, AttrValue>, children?: V[], events?: Record<string, EventBinding>) => V;
const isVnode = (v: unknown): v is V => !!v && typeof v === "object" && ((v as { type?: unknown }).type === "el" || (v as { type?: unknown }).type === "text");

const BTN = "border:0;background:transparent;cursor:pointer;font:600 .95rem ui-monospace,monospace;padding:.1rem .4rem;line-height:1;border-radius:.2rem;color:CanvasText";

// toolbtn(glyph, title, handler, payload?) — a toolbar/titlebar button. It STOPS
// pointerdown (so a click in a window's chrome doesn't start a window/tab drag) and
// dispatches `handler(state, payload, event)` on click. The atom every app's toolbar
// is built from (save 💾, open 📁, run ⚡, …).
const toolbtn: Fn = ((glyph: unknown, title: unknown, handler: unknown, payload?: unknown): V =>
  el("button", { class: "pl-toolbtn", title: String(title ?? ""), style: BTN }, [T(String(glyph ?? ""))],
    { pointerdown: { dispatch: "window.stop" }, click: { dispatch: String(handler ?? ""), ...(payload === undefined ? {} : { payload }) } })) as Fn;

// toolbar(...children) — a horizontal toolbar ROW (an app puts it above its content).
// Arrays flatten; non-vnodes are dropped, so MAP(...) of buttons works.
const toolbar: Fn = ((...kids: unknown[]): V => {
  const out: V[] = [];
  for (const k of kids) for (const item of (Array.isArray(k) ? k.flat(8) : [k])) if (isVnode(item)) out.push(item);
  return el("div", { class: "pl-apptoolbar", style: "flex:0 0 auto;display:flex;align-items:center;gap:.25rem;padding:.25rem .4rem;background:#8881;border-bottom:1px solid #8883" }, out);
}) as Fn;

// ── app install: assets manifest → OPFS ──────────────────────────────────────
// An application declares the files it needs (a DOOM WAD, a model, fonts) in an
// ASSETS MANIFEST so origin-applications can be defined in formula-cels: a formula
// installs the assets to OPFS, then loads them from OPFS into state. The manifest is
// app-AGNOSTIC, so install lives here (winapps), not in winapps-wasm.
//
//   { name, version, readme?, assets: [ { url, opfs, sha? } ] }
//     version  a content/version tag (often a sha) for the app release
//     assets   each file: where to FETCH it (url) + where it lands in OPFS (opfs)
//              + an optional SHA-256 hex (sha) verified on download
//
// app.install(manifest)  — download each missing asset to its opfs path (idempotent;
//                          sha-verified if given). manifest may be the object or a URL
//                          to its JSON. Returns a one-line status. app.installed(m) —
//                          true iff every asset is already present.
interface Asset { url: string; opfs: string; sha?: string }
interface Manifest { name?: string; version?: string; readme?: string; assets?: Asset[] }

const fetchBytes = async (url: string): Promise<Uint8Array> => {
  const r = await (globalThis as { fetch: typeof fetch }).fetch(url);
  if (!r.ok) throw new Error(`install: ${url} HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};
const resolveManifest = async (m: unknown): Promise<Manifest> => {
  if (typeof m === "string") return await fetchBytes(m).then((b) => JSON.parse(new TextDecoder().decode(b)) as Manifest);
  return (m && typeof m === "object") ? m as Manifest : {};
};
const sha256hex = async (bytes: Uint8Array): Promise<string> => {
  const subtle = (globalThis as { crypto?: { subtle?: { digest(a: string, d: ArrayBuffer): Promise<ArrayBuffer> } } }).crypto?.subtle;
  if (!subtle) throw new Error("install: no WebCrypto for sha verification");
  const d = await subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
};
const assetsOf = (m: Manifest): Asset[] => Array.isArray(m.assets) ? m.assets.filter((a) => a && a.url && a.opfs) : [];

// file-store fs.* are STATELESS (fs.exists(path) / fs.write(path, bytes)) — they
// dispatch over the module-singleton backend, so no State arg.
const installedFn: Fn = (async (state: State, manifest: unknown): Promise<boolean> => {
  const m = await resolveManifest(manifest);
  const exists = resolveFn(state, "fs.exists") as Fn;
  for (const a of assetsOf(m)) if (!(await exists(a.opfs))) return false;
  return true;
}) as Fn;

const installFn: Fn = (async (state: State, manifest: unknown): Promise<string> => {
  const m = await resolveManifest(manifest);
  const exists = resolveFn(state, "fs.exists") as Fn;
  const write = resolveFn(state, "fs.write") as Fn;
  const out: string[] = [];
  for (const a of assetsOf(m)) {
    if (await exists(a.opfs)) { out.push(`= ${a.opfs}`); continue; }          // already installed
    const bytes = await fetchBytes(a.url);
    if (a.sha) { const got = await sha256hex(bytes); if (got !== a.sha) throw new Error(`install: ${a.url} sha mismatch (${got.slice(0, 12)}… ≠ ${a.sha.slice(0, 12)}…)`); }
    await write(a.opfs, bytes);
    out.push(`+ ${a.opfs} (${bytes.length}b)`);
  }
  return out.length ? out.join("; ") : "no assets";
}) as Fn;

export const name = "winapps" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["toolbtn", toolbtn],
  ["toolbar", toolbar],
  ["app.install", installFn],
  ["app.installed", installedFn],
]));
