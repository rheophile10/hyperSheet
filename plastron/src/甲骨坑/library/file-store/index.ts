import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// file-store — Phase A. Pathlib-shaped fns over OPFS (browser) or
// node:fs/promises (CLI). One backend selected sync at module load;
// no per-state config in this phase — see
// docs/1-design/3-accepted/09-storage/opfs-file-store.md.
//
// Formula-callable fns receive (...args) only — no state ref — so the
// backend lives at module scope. The descriptor cels (file-store.backend,
// .root, .*-available) document the active singleton; mutating them
// after install does NOT re-bind. A state-aware fs.bind fn arrives in
// a later phase alongside the broader config-via-cels story.
// ============================================================================

// ----- Capability detection (sync, at module load) -----

interface NavigatorShape {
  storage?: { getDirectory?: () => Promise<OpfsDirHandle> };
}
interface ProcessShape {
  versions?: { node?: string };
  env?: Record<string, string | undefined>;
}

const _opfsAvailable: boolean =
  typeof (globalThis as { navigator?: NavigatorShape }).navigator?.storage?.getDirectory === "function";
const _nodeFsAvailable: boolean =
  typeof (globalThis as { process?: ProcessShape }).process?.versions?.node === "string";

type BackendName = "opfs" | "node-fs" | "none";
const _backend: BackendName =
  _opfsAvailable ? "opfs" : _nodeFsAvailable ? "node-fs" : "none";

// Root override via env var so tests can isolate. Read once at module
// load; subsequent process.env mutations don't propagate (matches the
// "singleton, immutable in Phase A" stance).
const _envRoot =
  (globalThis as { process?: ProcessShape }).process?.env?.PLASTRON_FILE_STORE_ROOT;
const _root: string =
  _backend === "node-fs" ? (_envRoot ?? "./.plastron-fs") : "";

// ----- Path normalization -----

// POSIX-style. Collapses "." and "..", rejects "..  escapes past root.
// Returns the segments array used downstream by both backends.
const splitPath = (input: string): string[] => {
  const trimmed = input.replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return [];
  const parts: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) {
        throw new Error(`file-store: path escapes root: ${input}`);
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts;
};

// ----- Shared backend interface -----

interface FileStat { size: number; isDir: boolean; mtime: number; }

interface FileBackend {
  exists(path: string[]): Promise<boolean>;
  read(path: string[]): Promise<Uint8Array>;
  write(path: string[], content: Uint8Array): Promise<void>;
  delete(path: string[]): Promise<void>;
  mkdir(path: string[], recursive: boolean): Promise<void>;
  rmdir(path: string[], recursive: boolean): Promise<void>;
  list(path: string[]): Promise<string[]>;
  stat(path: string[]): Promise<FileStat>;
  rename(oldPath: string[], newPath: string[]): Promise<void>;
}

// ----- node-fs backend -----

interface NodeFsPromises {
  readFile: (p: string) => Promise<Uint8Array>;
  writeFile: (p: string, c: Uint8Array) => Promise<void>;
  unlink: (p: string) => Promise<void>;
  mkdir: (p: string, opts?: { recursive?: boolean }) => Promise<void>;
  rm: (p: string, opts?: { recursive?: boolean; force?: boolean }) => Promise<void>;
  readdir: (p: string) => Promise<string[]>;
  stat: (p: string) => Promise<{ size: number; isDirectory(): boolean; mtimeMs: number }>;
  rename: (a: string, b: string) => Promise<void>;
  access: (p: string) => Promise<void>;
}
interface NodePath {
  join: (...segments: string[]) => string;
  resolve: (...segments: string[]) => string;
  dirname: (p: string) => string;
  sep: string;
}

const createNodeBackend = async (root: string): Promise<FileBackend> => {
  // Dynamic imports with /* @vite-ignore */ so browser bundlers skip
  // these specifiers (the segment installs in both runtimes; the OPFS
  // path won't reach here).
  const fs   = await import(/* @vite-ignore */ "node:fs/promises") as unknown as NodeFsPromises;
  const path = await import(/* @vite-ignore */ "node:path")        as unknown as NodePath;

  const resolvedRoot = path.resolve(root);
  await fs.mkdir(resolvedRoot, { recursive: true });

  const abs = (segments: string[]): string => {
    if (segments.length === 0) return resolvedRoot;
    const joined = path.join(resolvedRoot, ...segments);
    // Defense-in-depth: splitPath rejects ".." escapes already, but
    // re-check the resolved path in case path.resolve normalizes
    // anything we missed (symlinks aren't followed by resolve, but
    // the assertion is cheap).
    const resolved = path.resolve(joined);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`file-store: resolved path escapes root: ${segments.join("/")}`);
    }
    return resolved;
  };

  const swallowMissing = async (fn: () => Promise<void>): Promise<void> => {
    try { await fn(); }
    catch (e) { if ((e as { code?: string }).code !== "ENOENT") throw e; }
  };

  return {
    exists: async (p) => fs.access(abs(p)).then(() => true, () => false),
    read:   (p)       => fs.readFile(abs(p)),
    write:  async (p, content) => {
      const absPath = abs(p);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, content);
    },
    delete: async (p) => swallowMissing(() => fs.unlink(abs(p))),
    mkdir:  (p, recursive) => fs.mkdir(abs(p), { recursive }),
    rmdir:  async (p, recursive) =>
      swallowMissing(() => fs.rm(abs(p), { recursive, force: true })),
    list:   (p) => fs.readdir(abs(p)),
    stat:   async (p) => {
      const s = await fs.stat(abs(p));
      return { size: s.size, isDir: s.isDirectory(), mtime: s.mtimeMs };
    },
    rename: (oldP, newP) => fs.rename(abs(oldP), abs(newP)),
  };
};

// ----- OPFS backend -----

interface OpfsFile {
  size: number;
  lastModified: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}
interface OpfsWritable {
  write: (data: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
}
interface OpfsFileHandle {
  kind: "file";
  name: string;
  getFile: () => Promise<OpfsFile>;
  createWritable: () => Promise<OpfsWritable>;
  move?: (newParent: OpfsDirHandle, newName?: string) => Promise<void>;
}
interface OpfsDirHandle {
  kind: "directory";
  name: string;
  getDirectoryHandle: (name: string, opts?: { create?: boolean }) => Promise<OpfsDirHandle>;
  getFileHandle:      (name: string, opts?: { create?: boolean }) => Promise<OpfsFileHandle>;
  removeEntry:        (name: string, opts?: { recursive?: boolean }) => Promise<void>;
  values:             () => AsyncIterable<OpfsFileHandle | OpfsDirHandle>;
  move?:              (newParent: OpfsDirHandle, newName?: string) => Promise<void>;
}

const createOpfsBackend = async (): Promise<FileBackend> => {
  const nav = (globalThis as { navigator: NavigatorShape }).navigator;
  if (!nav.storage?.getDirectory) {
    throw new Error("file-store: OPFS unavailable (re-probe failed)");
  }
  const opfsRoot = await nav.storage.getDirectory();

  const walkDir = async (segments: string[], create: boolean): Promise<OpfsDirHandle> => {
    let dir = opfsRoot;
    for (const name of segments) {
      dir = await dir.getDirectoryHandle(name, { create });
    }
    return dir;
  };

  const fileAt = async (segments: string[], create: boolean): Promise<OpfsFileHandle> => {
    if (segments.length === 0) throw new Error("file-store: empty file path");
    const parent = await walkDir(segments.slice(0, -1), create);
    return parent.getFileHandle(segments[segments.length - 1], { create });
  };

  // Three-way probe — used by exists/stat to avoid catching the same
  // NotFoundError twice in callers.
  const probe = async (segments: string[]): Promise<"file" | "dir" | "missing"> => {
    if (segments.length === 0) return "dir";
    let parent: OpfsDirHandle;
    try { parent = await walkDir(segments.slice(0, -1), false); }
    catch { return "missing"; }
    const name = segments[segments.length - 1];
    try { await parent.getFileHandle(name);      return "file"; } catch { /* not a file */ }
    try { await parent.getDirectoryHandle(name); return "dir";  } catch { return "missing"; }
  };

  return {
    exists: async (p) => (await probe(p)) !== "missing",

    read: async (p) => {
      const fh = await fileAt(p, false);
      const f  = await fh.getFile();
      return new Uint8Array(await f.arrayBuffer());
    },

    write: async (p, content) => {
      const fh = await fileAt(p, true);
      const w  = await fh.createWritable();
      try { await w.write(content); } finally { await w.close(); }
    },

    delete: async (p) => {
      if (p.length === 0) return;
      let parent: OpfsDirHandle;
      try { parent = await walkDir(p.slice(0, -1), false); } catch { return; }
      try { await parent.removeEntry(p[p.length - 1]); } catch { /* missing — no-op */ }
    },

    mkdir: async (p, _recursive) => {
      // OPFS getDirectoryHandle({create:true}) is always per-segment-
      // create, so recursion is implicit.
      await walkDir(p, true);
    },

    rmdir: async (p, recursive) => {
      if (p.length === 0) {
        // Origin root itself can't be removed; clear children if recursive.
        if (!recursive) return;
        for await (const entry of opfsRoot.values()) {
          try { await opfsRoot.removeEntry(entry.name, { recursive: true }); }
          catch { /* swallow */ }
        }
        return;
      }
      let parent: OpfsDirHandle;
      try { parent = await walkDir(p.slice(0, -1), false); } catch { return; }
      try { await parent.removeEntry(p[p.length - 1], { recursive }); }
      catch { /* missing — no-op */ }
    },

    list: async (p) => {
      const dir = await walkDir(p, false);
      const names: string[] = [];
      for await (const entry of dir.values()) names.push(entry.name);
      return names;
    },

    stat: async (p) => {
      const kind = await probe(p);
      if (kind === "missing") throw new Error(`file-store: not found: ${p.join("/")}`);
      if (kind === "dir")     return { size: 0, isDir: true, mtime: 0 };
      const fh = await fileAt(p, false);
      const f  = await fh.getFile();
      return { size: f.size, isDir: false, mtime: f.lastModified };
    },

    rename: async (oldP, newP) => {
      if (oldP.length === 0) throw new Error("file-store: cannot rename root");
      if (newP.length === 0) throw new Error("file-store: cannot move to root");

      const oldParent = await walkDir(oldP.slice(0, -1), false);
      const newParent = await walkDir(newP.slice(0, -1), true);
      const oldName   = oldP[oldP.length - 1];
      const newName   = newP[newP.length - 1];

      let handle: OpfsFileHandle | OpfsDirHandle;
      try { handle = await oldParent.getFileHandle(oldName); }
      catch {
        try { handle = await oldParent.getDirectoryHandle(oldName); }
        catch { throw new Error(`file-store: rename source not found: ${oldP.join("/")}`); }
      }

      // Prefer the native .move() (Chromium 110+, Safari 17.4+). Fallback
      // is file-only — directory move via read+write would need a tree
      // walk, which Phase A doesn't ship.
      if (typeof handle.move === "function") {
        await handle.move(newParent, newName);
        return;
      }
      if (handle.kind !== "file") {
        throw new Error(
          `file-store: directory rename requires FileSystemHandle.move (unsupported here)`,
        );
      }
      const f     = await handle.getFile();
      const bytes = new Uint8Array(await f.arrayBuffer());
      const dst   = await newParent.getFileHandle(newName, { create: true });
      const w     = await dst.createWritable();
      try { await w.write(bytes); } finally { await w.close(); }
      await oldParent.removeEntry(oldName);
    },
  };
};

// ----- Backend singleton -----

let _backendPromise: Promise<FileBackend> | undefined;

const getBackend = (): Promise<FileBackend> => {
  if (_backendPromise) return _backendPromise;
  if (_backend === "opfs")    _backendPromise = createOpfsBackend();
  else if (_backend === "node-fs") _backendPromise = createNodeBackend(_root);
  else _backendPromise = Promise.reject(new Error(
    "file-store: no backend available — neither OPFS nor node:fs/promises detected.",
  ));
  return _backendPromise;
};

// ----- Fn surface -----

const toBytes = (content: unknown): Uint8Array => {
  if (content instanceof Uint8Array) return content;
  if (typeof content === "string")   return new TextEncoder().encode(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  throw new Error(`fs.write: content must be Uint8Array | string | ArrayBuffer (got ${typeof content})`);
};

const exists:    Fn = async (path: unknown) =>
  (await getBackend()).exists(splitPath(String(path)));
const read:      Fn = async (path: unknown) =>
  (await getBackend()).read(splitPath(String(path)));
const readText:  Fn = async (path: unknown) => {
  const bytes = await (await getBackend()).read(splitPath(String(path)));
  return new TextDecoder("utf-8").decode(bytes);
};
const write:     Fn = async (path: unknown, content: unknown) =>
  (await getBackend()).write(splitPath(String(path)), toBytes(content));
const writeText: Fn = async (path: unknown, content: unknown) =>
  (await getBackend()).write(splitPath(String(path)), new TextEncoder().encode(String(content)));
const del:       Fn = async (path: unknown) =>
  (await getBackend()).delete(splitPath(String(path)));
const mkdir:     Fn = async (path: unknown, recursive: unknown) =>
  (await getBackend()).mkdir(splitPath(String(path)), recursive === undefined ? true : Boolean(recursive));
const rmdir:     Fn = async (path: unknown, recursive: unknown) =>
  (await getBackend()).rmdir(splitPath(String(path)), recursive === undefined ? true : Boolean(recursive));
const list:      Fn = async (path: unknown) =>
  (await getBackend()).list(splitPath(String(path)));
const stat:      Fn = async (path: unknown) =>
  (await getBackend()).stat(splitPath(String(path)));
const rename:    Fn = async (oldP: unknown, newP: unknown) =>
  (await getBackend()).rename(splitPath(String(oldP)), splitPath(String(newP)));

// Additive internal export: the path-string fs operations, for sibling
// segments (e.g. segment-store) that compose over file-store at the
// module level rather than re-implementing the backend. Not a cel; not
// part of the public kernel API. fs.* cels remain the formula-facing
// surface.
export const fsOps = {
  exists, read, readText, write, writeText,
  delete: del, mkdir, rmdir, list, stat, rename,
} as const;

// The active backend label, decided at module load. Sibling segments
// (cli-segment-export) gate cel installation on this — CLI-only fns
// install only when the live backend is node-fs.
export const backend = _backend;

// Backend-relative root (resolved root for node-fs; "" for OPFS). Used by
// cli-segment-export to locate the store on the real filesystem.
export const root = _root;

// ----- file-binary schema protocols -----

const fileBinarySize: Fn = (v: unknown) =>
  v instanceof Uint8Array ? v.length : 0;

const fileBinaryIsChanged: Fn = (oldV: unknown, newV: unknown) => {
  if (!(oldV instanceof Uint8Array) || !(newV instanceof Uint8Array)) return oldV !== newV;
  if (oldV.length !== newV.length) return true;
  for (let i = 0; i < oldV.length; i++) if (oldV[i] !== newV[i]) return true;
  return false;
};

const fileBinaryMime: Fn = (_v: unknown) => "application/octet-stream";

// ----- Segment export -----

export const name = "file-store" as const;

// fs.command — the file-op vocabulary's shared logic (ls/tree/mkdir/rm/mv/cat/
// write/touch/stat), moved here from origin so the capability lives with the
// store (apps-are-cels: a reusable file capability is a library, not app code).
// Calls the module-scope backend fns directly and returns a formatted string; a
// host's verb (=ls, =cat, …) emits a descriptor whose drain delegates here.
const fsJoin = (dir: string, name: string): string =>
  (dir === "/" ? "" : dir.replace(/\/+$/, "")) + "/" + name;

const fsTree = async (path: string, prefix = ""): Promise<string> => {
  const names = ((await list(path)) as unknown as string[]).slice().sort();
  const out: string[] = [];
  for (const n of names) {
    const full = fsJoin(path, n);
    const st = await (stat(full) as unknown as Promise<{ isDir?: boolean }>).catch(() => null);
    if (st?.isDir) { out.push(`${prefix}${n}/`); out.push(await fsTree(full, `${prefix}  `)); }
    else out.push(`${prefix}${n}`);
  }
  return out.filter(Boolean).join("\n");
};

const fsCommand: Fn = (async (op: unknown, path: unknown, to?: unknown, text?: unknown): Promise<string> => {
  const o = String(op ?? ""); const p = String(path ?? "");
  if (o === "ls") {
    const names = ((await list(p)) as unknown as string[]).slice().sort();
    const lines = await Promise.all(names.map(async (n) => {
      const st = await (stat(fsJoin(p, n)) as unknown as Promise<{ isDir?: boolean }>).catch(() => null);
      return st?.isDir ? `${n}/` : n;
    }));
    return lines.length ? lines.join("\n") : "(empty)";
  }
  if (o === "tree") return (await fsTree(p)) || "(empty)";
  if (o === "mkdir") { await mkdir(p); return `mkdir ${p}`; }
  if (o === "rm") {
    const st = await (stat(p) as unknown as Promise<{ isDir?: boolean }>).catch(() => null);
    if (st?.isDir) await rmdir(p); else await del(p);
    return `rm ${p}`;
  }
  if (o === "mv") { await rename(p, String(to)); return `mv ${p} → ${String(to)}`; }
  if (o === "cat") return String(await readText(p));
  if (o === "write") { await writeText(p, String(text ?? "")); return `wrote ${p}`; }
  if (o === "touch") { if (!(await exists(p))) await writeText(p, ""); return `touch ${p}`; }
  if (o === "stat") {
    const st = (await stat(p)) as unknown as { size?: number; isDir?: boolean; mtime?: unknown };
    return [`path: ${p}`, `isDir: ${st.isDir}`, `size: ${st.size}`, st.mtime != null ? `mtime: ${String(st.mtime)}` : ""].filter(Boolean).join("\n");
  }
  return `(unknown fs op: ${o})`;
}) as Fn;

// fs.pickToCel — the missing "picked-file bytes → base64 into a named cel"
// bridge. An on('change') handler for an <input type=file>: it reads the
// event's selected file, base64-encodes its raw bytes, and writes that
// string to the cel named by the payload (via setValue, so the graph
// advances). Mechanism, zero policy — the destination cel is an argument,
// and no path/name is authored here (file-explorer's upload writes OPFS by
// the file's own name; this writes the CALLER'S cel instead, the shape a
// sheetapp needs to hand image bytes to a py cell). No-op if no file.
interface PickFile { arrayBuffer: () => Promise<ArrayBuffer>; }
interface PickEvent { target?: { files?: ArrayLike<PickFile> | null } }

const bytesToBase64 = (bytes: Uint8Array): string => {
  const g = globalThis as { btoa?: (s: string) => string };
  let bin = "";
  const CHUNK = 0x8000;                              // avoid arg-count limits
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  if (typeof g.btoa === "function") return g.btoa(bin);
  // Non-DOM runtime without btoa: manual RFC-4648 encode (mechanism only).
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1], b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += A[(n >> 18) & 63]! + A[(n >> 12) & 63]!;
    out += b1 === undefined ? "=" : A[(n >> 6) & 63]!;
    out += b2 === undefined ? "=" : A[n & 63]!;
  }
  return out;
};

const pickToCel: Fn = (async (state: unknown, celKey: unknown, event: unknown): Promise<unknown> => {
  const st = state as State;
  const file = (event as PickEvent | undefined)?.target?.files?.[0];
  if (!file) return st;
  const bytes = new Uint8Array(await file.arrayBuffer());
  // setValue runs the cascade (which fires dependents, including =view panes
  // that read this cel) before it resolves.
  await (resolveFn(st, "setValue") as Fn)(st, String(celKey ?? ""), bytesToBase64(bytes));
  // A dispatch handler that writes a cel a =view reads must repaint — the dom
  // event dispatcher is fire-and-forget. Same recipe as the generic input
  // handler param.set (ecs): land the re-fired =view requests (origin.effects),
  // then paint the DOM (dom.paint). Both guarded — no-op off-DOM.
  const dr = resolveFn(st, "drain") as Fn | undefined;
  if (dr && st.cels.get("origin.effects")) await dr(st, "origin.effects");
  if (dr && st.cels.get("dom.paint")) await dr(st, "dom.paint");
  return st;
}) as Fn;

const _cels = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["fs.command",            fsCommand],
  ["fs.pickToCel",          pickToCel],
  ["fs.exists",             exists],
  ["fs.read",               read],
  ["fs.readText",           readText],
  ["fs.write",              write],
  ["fs.writeText",          writeText],
  ["fs.delete",             del],
  ["fs.mkdir",              mkdir],
  ["fs.rmdir",              rmdir],
  ["fs.list",               list],
  ["fs.stat",               stat],
  ["fs.rename",             rename],
  ["file-binary_size",      fileBinarySize],
  ["file-binary_isChanged", fileBinaryIsChanged],
  ["file-binary_mime",      fileBinaryMime],
]));

// JSON seeds the descriptor cels with v=null; populate from the
// module-load probes so reads of file-store.backend / .root return the
// active singleton's values.
for (const cel of _cels) {
  if (cel.celType !== "ValueCel") continue;
  switch (cel.metadata.key) {
    case "file-store.opfs-available":    cel.v = _opfsAvailable;    break;
    case "file-store.node-fs-available": cel.v = _nodeFsAvailable;  break;
    case "file-store.backend":           cel.v = _backend;          break;
    case "file-store.root":              cel.v = _root;             break;
  }
}

export const cels: Cel[] = _cels;
