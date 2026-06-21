import type {
  甲骨, Cel, Fn, State, VNode, AttrValue, EventBinding,
} from "../../../types/index.js";
import { bindNativeFns, resolveFn, ensureSegments } from "../../../kernel/index.js";
import { el as makeEl, text as T } from "../dom/index.js";
import { openAsSheet } from "../sheet-host/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// file-explorer — the OPFS file UI as a LIBRARY capability (sibling of
// dom/windows/sheet-host). The application only composes it. Extracted from
// origin (where it grew up alongside the OPFS vocabulary): the explorer render
// verb + its nav/open/delete/rename handlers + the upload/download verbs all
// live here now, so `library/windows`' explorerwin() genesis no longer reaches
// UP into the application for them.
//
// Reactivity (inputMap doctrine): the render verb `explorer` is PURE; the async
// OPFS reads live in the dispatch handlers, which write explorer.cwd/.preview/
// .listing. The window content formula `(explorer explorer.cwd explorer.preview
// explorer.listing)` REFERENCES those cels, so a handler's write re-fires the
// render through the graph — no hand-rolled repaint of the formula itself.
// ============================================================================

// loose view alias for ergonomic access; the canonical VNode the painter sees
// is built by the library `el`/`text` (the same adapter origin uses).
type V = { type: "el" | "text"; tag?: string; key?: string; memo?: unknown; attrs?: Record<string, unknown>; events?: Record<string, unknown>; children?: V[]; text?: string };
const el = (tag: string, attrs: Record<string, unknown>, children: V[], events?: Record<string, unknown>): V =>
  makeEl(tag, attrs as Record<string, AttrValue>, children as VNode[], events as Record<string, EventBinding> | undefined) as V;

const parentPath = (p: string): string => {
  const norm = "/" + p.split("/").filter(Boolean).join("/");
  if (norm === "/") return "/";
  const i = norm.lastIndexOf("/");
  return i <= 0 ? "/" : norm.slice(0, i);
};
// --- binary-preview guard. Never text-preview a binary/huge file (decoding
//     megabytes of bytes into a string blows out browser memory). A file is
//     "previewable text" only when its extension isn't a known binary one AND
//     it's under PREVIEW_MAX_BYTES AND its bytes are valid UTF-8.
const PREVIEW_MAX_BYTES = 256 * 1024;
const BINARY_EXTS = new Set([
  "wasm", "wad", "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif",
  "zip", "甲", "xlsx", "xls", "pdf", "gz", "tar", "br", "db", "sqlite",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "wav", "ogg", "mov", "webm",
]);
const fileExt = (path: string): string => {
  const base = path.split("/").pop() || path;
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
};
const fmtBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
// strict UTF-8 validity probe (TextDecoder with fatal:true throws on invalid bytes)
const isValidUtf8 = (bytes: Uint8Array): boolean => {
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; }
  catch { return false; }
};
const joinPath = (dir: string, name: string): string =>
  (dir === "/" ? "" : dir.replace(/\/+$/, "")) + "/" + name;
// per-file action button (🗑 / ✎ / ⬇) — a small dispatch control beside a file
const feAction = (icon: string, title: string, dispatch: string, payload: string): V =>
  el("button", { class: "fe-act", type: "button", title, style: "border:0;background:transparent;cursor:pointer;font-size:.8rem;padding:0 .15rem;line-height:1" },
    [T(icon)], { click: { dispatch, payload } });
const renderExplorer = (cwd: string, entries: { name: string; isDir: boolean }[], preview: string, previewText: string, previewBinary: boolean): V => {
  const rowStyle = "display:flex;align-items:center;gap:.4rem;padding:.25rem .4rem;border-radius:.3rem;cursor:pointer;font:.82rem ui-monospace,monospace";
  const rows: V[] = [];
  if (cwd !== "/") {
    rows.push(el("div", { class: "fe-row fe-up", style: rowStyle + ";opacity:.8" },
      [T("📁 ..")], { click: { dispatch: "explorer.nav", payload: parentPath(cwd) } }));
  }
  for (const e of entries) {
    const full = joinPath(cwd, e.name);
    if (e.isDir) {
      rows.push(el("div", { class: "fe-row fe-dir", style: rowStyle },
        [T(`📁 ${e.name}/`)], { click: { dispatch: "explorer.nav", payload: full } }));
    } else {
      // file row: clickable name (preview) + per-file actions (delete/rename/download)
      rows.push(el("div", { class: "fe-row fe-file" + (full === preview ? " fe-sel" : ""), style: rowStyle + (full === preview ? ";background:#4a90d955" : "") },
        [el("span", { class: "fe-name", style: "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" },
           [T(`📄 ${e.name}`)], { click: { dispatch: "explorer.open", payload: full }, dblclick: { dispatch: "explorer.openSheet", payload: full } }),
         el("span", { class: "fe-acts", style: "display:flex;gap:.1rem;flex:0 0 auto" }, [
           feAction("🗑", `delete ${e.name}`, "explorer.delete", full),
           feAction("✎", `rename ${e.name}`, "explorer.rename", full),
           feAction("⬇", `download ${e.name}`, "explorer.download", full),
         ])]));
    }
  }
  if (!entries.length) rows.push(el("div", { style: "opacity:.6;padding:.3rem;font:.8rem ui-monospace,monospace" }, [T("(empty)")]));
  const left: V[] = [
    el("div", { class: "fe-bar", style: "display:flex;align-items:center;gap:.4rem;padding:.25rem .4rem;border-bottom:1px solid #8884;font:600 .8rem ui-monospace,monospace" },
      [T(`📂 ${cwd}`)]),
    el("div", { class: "fe-list", style: "flex:1 1 auto;overflow:auto;padding:.2rem" }, rows),
    el("div", { class: "fe-upload", style: "padding:.3rem .4rem;border-top:1px solid #8884;font:.75rem system-ui" },
      [T("upload here: "), el("input", { class: "opfs-upload", type: "file", title: `upload into ${cwd}` }, [], { change: { dispatch: "explorer.upload", payload: cwd } })]),
  ];
  // preview body: a binary/oversize file shows a placeholder + download button
  // (never the bytes); a text file shows its content in a <pre>.
  const previewBody: V[] = previewBinary
    ? [el("div", { class: "fe-binary", style: "flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.6rem;padding:1rem;text-align:center;font:.8rem system-ui;opacity:.85" },
        [T(previewText), el("button", { class: "opfs-btn fe-dl", type: "button", title: `download ${preview}` },
           [T(`⬇ download ${preview.split("/").pop() || preview}`)], { click: { dispatch: "explorer.download", payload: preview } })])]
    : [el("pre", { style: "flex:1 1 auto;overflow:auto;margin:0;padding:.4rem;font:.78rem ui-monospace,monospace;white-space:pre-wrap;word-break:break-word" }, [T(previewText)])];
  const right: V[] = preview
    ? [el("div", { class: "fe-preview", style: "flex:1 1 50%;min-width:0;border-left:1px solid #8884;display:flex;flex-direction:column" },
        [el("div", { style: "padding:.25rem .4rem;border-bottom:1px solid #8884;font:600 .78rem ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, [T(preview.split("/").pop() || preview)]),
         ...previewBody])]
    : [];
  return el("div", { class: "file-explorer", style: "display:flex;height:100%;min-height:0" },
    [el("div", { class: "fe-pane", style: "flex:1 1 50%;min-width:0;display:flex;flex-direction:column" }, left), ...right]);
};
const explorerFn: Fn = (cwd?: unknown, preview?: unknown, listing?: unknown): V => {
  const c = cwd == null || cwd === "" ? "/" : String(cwd);
  const pv = preview == null ? "" : String(preview);
  const lst = (listing && typeof listing === "object") ? listing as { entries?: { name: string; isDir: boolean }[]; previewText?: string; previewBinary?: boolean } : {};
  return renderExplorer(c, Array.isArray(lst.entries) ? lst.entries : [], pv, String(lst.previewText ?? ""), !!lst.previewBinary);
};

// explorerListing — the async OPFS read the nav/open handlers share: list the
// cwd (fs.list + fs.stat), sort folders-first, and cat the preview file. Lands
// as explorer.listing, which the content formula references → reactive repaint.
const explorerListing = async (state: State, cwd: string, preview: string): Promise<{ entries: { name: string; isDir: boolean }[]; previewText: string; previewBinary: boolean }> => {
  await ensureSegments(state, ["file-store"]);
  const list = resolveFn(state, "fs.list") as Fn, fstat = resolveFn(state, "fs.stat") as Fn;
  const names = ((await (list(cwd) as Promise<string[]>).catch(() => [])) as string[]).slice();
  const entries: { name: string; isDir: boolean }[] = [];
  for (const n of names) {
    const st = (await (fstat(joinPath(cwd, n)) as Promise<{ isDir?: boolean }>).catch(() => null)) as { isDir?: boolean } | null;
    entries.push({ name: n, isDir: !!st?.isDir });
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  let previewText = "", previewBinary = false;
  if (preview) {
    const ext = fileExt(preview);
    const st = (await ((fstat(preview)) as Promise<{ size?: number; isDir?: boolean }>).catch(() => null)) as { size?: number; isDir?: boolean } | null;
    const size = Number(st?.size ?? 0);
    if (BINARY_EXTS.has(ext) || size > PREVIEW_MAX_BYTES) {
      // known-binary extension or oversize → never read it as text (memory).
      previewBinary = true;
      previewText = `binary file — ${ext || "no ext"}, ${fmtBytes(size)} — ⬇ download to inspect`;
    } else {
      // small + non-binary-ext: read RAW bytes and only decode if valid UTF-8.
      const bytes = (await ((resolveFn(state, "fs.read") as Fn)(preview) as Promise<Uint8Array>).catch(() => null)) as Uint8Array | null;
      if (bytes == null) { previewBinary = true; previewText = "(cannot read file)"; }
      else if (!isValidUtf8(bytes)) { previewBinary = true; previewText = `binary file — ${ext || "no ext"}, ${fmtBytes(bytes.byteLength)} — ⬇ download to inspect`; }
      else previewText = new TextDecoder("utf-8").decode(bytes);
    }
  }
  return { entries, previewText, previewBinary };
};

// --- upload / download — a cel becomes a button / file input that moves bytes
//     between OPFS and the user's disk. The formula returns a vnode VALUE (like
//     dom()); its dispatch handler runs in the browser (click/change), where
//     Blob/File/URL exist. The genuinely new plumbing for opfs-formulas. ---
const downloadFn: Fn = (path: unknown): V => {
  const p = String(path ?? "");
  return el("button", { class: "opfs-btn", type: "button", title: `download ${p}` },
    [T(`⬇ ${p.split("/").pop() || p}`)], { click: { dispatch: "explorer.download", payload: p } });
};
const uploadFn: Fn = (path?: unknown): V => {
  const dir = path == null || path === "" ? "/" : String(path);
  return el("input", { class: "opfs-upload", type: "file", title: `upload into ${dir}` },
    [], { change: { dispatch: "explorer.upload", payload: dir } });
};

// dispatch targets — called (state, payload, event) on click/change.
type DomDownload = {
  document?: { createElement(t: string): { href: string; download: string; click(): void; remove(): void }; body: { appendChild(n: unknown): void } };
  URL?: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void };
  Blob?: new (parts: unknown[]) => unknown;
};
const downloadHandler: Fn = async (stateArg: unknown, path: unknown) => {
  const state = stateArg as State;
  const g = globalThis as DomDownload;
  if (!g.document || !g.URL || !g.Blob) return state;
  await ensureSegments(state, ["file-store"]);
  const p = String(path ?? "");
  const bytes = (await (resolveFn(state, "fs.read") as Fn)(p)) as Uint8Array;
  const url = g.URL.createObjectURL(new g.Blob([bytes]));
  const a = g.document.createElement("a");
  a.href = url; a.download = p.split("/").pop() || "download";
  g.document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => g.URL!.revokeObjectURL(url), 1000);
  return state;
};
const uploadHandler: Fn = async (stateArg: unknown, dir: unknown, event: unknown) => {
  const state = stateArg as State;
  await ensureSegments(state, ["file-store"]);
  const file = (event as { target?: { files?: ArrayLike<{ name: string; arrayBuffer(): Promise<ArrayBuffer> }> } })?.target?.files?.[0];
  if (!file) return state;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const d = String(dir ?? "/");
  const dest = (d === "/" ? "" : d.replace(/\/+$/, "")) + "/" + file.name;
  await (resolveFn(state, "fs.write") as Fn)(dest, bytes);
  // refresh the explorer (if open) so the freshly-uploaded file shows up.
  if (state.cels.get("explorer.cwd")) await refreshExplorer(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
};

// setOrCreate — write a value cel (used by the explorer nav state cels). Creates
// it under the explorer's window segment if the explorer window isn't seeded.
const setOrCreate = async (state: State, key: string, v: unknown): Promise<void> => {
  if (state.cels.get(key)) await (resolveFn(state, "setValue") as Fn)(state, key, v);
  else await (resolveFn(state, "setCel") as Fn)(state, key, { celType: "ValueCel", v, metadata: { key, segment: "win.explorer" } });
};

// refreshExplorer — recompute explorer.listing from the current cwd/preview and
// write it back. The content formula `(explorer explorer.cwd explorer.preview
// explorer.listing)` references explorer.listing, so this write re-fires the
// render through the graph (no hand-rolled repaint of the formula itself).
const refreshExplorer = async (state: State): Promise<void> => {
  const cwd = String(state.cels.get("explorer.cwd")?.v ?? "/") || "/";
  const preview = String(state.cels.get("explorer.preview")?.v ?? "");
  const listing = await explorerListing(state, cwd, preview);
  await setOrCreate(state, "explorer.listing", listing);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
};

// explorer.nav — descend into a folder (or climb via a "/parent" payload). Sets
// explorer.cwd, clears the preview, recomputes the listing. The explorer window
// content formula references explorer.cwd/listing, so it re-fires reactively.
const explorerNav: Fn = async (stateArg: unknown, path: unknown) => {
  const state = stateArg as State;
  const p = String(path ?? "/") || "/";
  await setOrCreate(state, "explorer.cwd", p);
  await setOrCreate(state, "explorer.preview", "");
  await refreshExplorer(state);
  return state;
};

// explorer.open — preview a file: set explorer.preview and recompute the listing
// (which cats the file into previewText). Reactive via explorer.listing.
const explorerOpen: Fn = async (stateArg: unknown, path: unknown) => {
  const state = stateArg as State;
  await setOrCreate(state, "explorer.preview", String(path ?? ""));
  await refreshExplorer(state);
  return state;
};

// explorer.openSheet — double-click a file in the explorer: a .csv/.xlsx/.甲 file
// OPENS as a new sheet WINDOW (read its OPFS bytes → openAsSheet, which detects
// the format by extension and materializes a standalone sheet window). Any other
// file falls back to the text-preview behavior.
const SHEET_EXTS = new Set(["csv", "xlsx", "xls", "甲"]);
const explorerOpenSheet: Fn = async (stateArg: unknown, path: unknown) => {
  const state = stateArg as State;
  const p = String(path ?? "");
  if (!SHEET_EXTS.has(fileExt(p))) return explorerOpen(state, p);   // not a sheet → preview
  await ensureSegments(state, ["file-store"]);
  const bytes = (await ((resolveFn(state, "fs.read") as Fn)(p) as Promise<Uint8Array>).catch(() => null)) as Uint8Array | null;
  if (!bytes) return state;
  await openAsSheet(state, bytes, p.split("/").pop() || p);
  return state;
};

// explorer.refresh — populate explorer.listing for the current cwd. The host
// calls it once at boot so the explorer window shows its initial listing (the
// nav/open handlers refresh it thereafter).
const explorerRefresh: Fn = async (stateArg: unknown) => {
  const state = stateArg as State;
  if (state.cels.get("explorer.cwd")) await refreshExplorer(state);
  return state;
};

// explorer.delete — fs.delete a file, clear the preview if it was showing, then
// refresh the listing (reactive via explorer.listing).
const explorerDelete: Fn = async (stateArg: unknown, path: unknown) => {
  const state = stateArg as State;
  const p = String(path ?? "");
  if (!p) return state;
  await ensureSegments(state, ["file-store"]);
  await ((resolveFn(state, "fs.delete") as Fn)(p) as Promise<unknown>).catch(() => {});
  if (String(state.cels.get("explorer.preview")?.v ?? "") === p) await setOrCreate(state, "explorer.preview", "");
  await refreshExplorer(state);
  return state;
};

// explorer.rename — prompt for a new NAME (same dir), fs.rename, follow the
// preview if it moved, then refresh. No-op off-DOM (no prompt available).
type DomPrompt = { prompt?: (msg: string, def?: string) => string | null };
const explorerRename: Fn = async (stateArg: unknown, path: unknown) => {
  const state = stateArg as State;
  const p = String(path ?? "");
  if (!p) return state;
  const g = globalThis as DomPrompt;
  if (typeof g.prompt !== "function") return state;
  const old = p.split("/").pop() || p;
  const next = g.prompt(`Rename "${old}" to:`, old);
  if (next == null || next === "" || next === old) return state;
  await ensureSegments(state, ["file-store"]);
  const dest = joinPath(parentPath(p), String(next).replace(/^\/+/, ""));
  await ((resolveFn(state, "fs.rename") as Fn)(p, dest) as Promise<unknown>).catch(() => {});
  if (String(state.cels.get("explorer.preview")?.v ?? "") === p) await setOrCreate(state, "explorer.preview", dest);
  await refreshExplorer(state);
  return state;
};

export const name = "file-explorer" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["explorer", explorerFn],
  ["explorer.nav", explorerNav],
  ["explorer.open", explorerOpen],
  ["explorer.openSheet", explorerOpenSheet],
  ["explorer.refresh", explorerRefresh],
  ["explorer.delete", explorerDelete],
  ["explorer.rename", explorerRename],
  ["explorer.download", downloadHandler],
  ["explorer.upload", uploadHandler],
  ["download", downloadFn],
  ["upload", uploadFn],
]));
