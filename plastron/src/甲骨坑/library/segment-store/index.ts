import type { 甲骨, 冊, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// segment-store — chunk B of the segment-lifecycle umbrella. A pure
// composition over file-store's fs.* operations: no new I/O primitives.
// Dehydrated segments live under `plastron/segments/<name>/<version>/`
// as a manifest.json (冊) + segment.json (甲骨) pair; `plastron/index.json`
// is the name → version lookup table.
//
// See docs/1-design/2-in-evaluation/segment-opfs-layout.md for the full
// design (layout, versioning, atomicity). Uncompressed JSON in v1.
//
// NOTE: ships flat (segment-store.ts + .json) to match all sibling
// segments and the src/index.ts boot wiring; the design sketched a
// `segment-store/` subfolder. The flat form is the convention.
// ============================================================================

// ----- Storage layout -----

// Layout root — also seeded as the locked ValueCel "store.root" so
// sibling storage segments compose over the same on-disk shape via the
// registry instead of an import.
const STORE_ROOT = "plastron";
const ROOT = STORE_ROOT;
const INDEX = `${ROOT}/index.json`;
const INDEX_TMP = `${ROOT}/index.json.tmp`;
const segDir = (name: string, version: string) => `${ROOT}/segments/${name}/${version}`;
// origin-user DOCUMENTS accumulate under their app: plastron/segments/<app>/documents/<doc>/<version>/
// — near the app's own segment dir (the index records each doc's app so get/del
// can find it without re-reading the manifest). Apps/libs stay flat.
const docDir = (app: string, name: string, version: string) => `${ROOT}/segments/${app}/documents/${name}/${version}`;
const dirOf = (name: string, version: string, app?: string) => app ? docDir(app, name, version) : segDir(name, version);
const appOfManifest = (manifest: unknown): string | undefined => {
  const m = manifest as { role?: string; applications?: unknown } | undefined;
  const apps = Array.isArray(m?.applications) ? m!.applications : [];
  return (m?.role === "user-space" && typeof apps[0] === "string") ? apps[0] : undefined;
};

// Deterministic content hash (cyrb53 → 53-bit hex). Cross-runtime (Bun.hash is
// CLI-only), sync, dependency-free — used to stamp a segment's `sha` (a version
// identity + integrity id the origin load-gate pins against).
const contentHash = (str: string): string => {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
};

interface IndexEntry { latest: string; versions: string[]; app?: string; }
export interface IndexFile { version: number; segments: Record<string, IndexEntry>; }

// ----- fs access through file-store's cels (isolation: the dependency
// is a cel edge, visible to segmentAdjacency, never an import) -----

const fsFn = (state: State, key: string): Fn => {
  const fn = resolveFn(state, key);
  if (!fn) throw new Error(`segment-store: file-store cel "${key}" is not installed`);
  return fn;
};
const exists    = (st: State, p: string) => fsFn(st, "fs.exists")(p)    as Promise<boolean>;
const readText  = (st: State, p: string) => fsFn(st, "fs.readText")(p)  as Promise<string>;
const writeText = (st: State, p: string, c: string) => fsFn(st, "fs.writeText")(p, c) as Promise<void>;
const rmdir     = (st: State, p: string) => fsFn(st, "fs.rmdir")(p, true) as Promise<void>;
const rename    = (st: State, p: string, b: string) => fsFn(st, "fs.rename")(p, b) as Promise<void>;

// ----- Name / version validation -----

// A stored name or version becomes a filesystem path component. Reject
// anything that isn't a safe single segment: empty, separators, NUL,
// "." / ".." traversal, or a leading dot.
const assertComponent = (kind: "name" | "version", value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`segment-store: ${kind} must be a non-empty string`);
  }
  if (value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`segment-store: invalid ${kind} "${value}" (contains a path separator or NUL)`);
  }
  if (value === "." || value === ".." || value.startsWith(".")) {
    throw new Error(`segment-store: invalid ${kind} "${value}" (must not start with '.')`);
  }
  return value;
};

// ----- Index read / atomic write -----

const readIndex = async (state: State): Promise<IndexFile> => {
  if (!(await exists(state, INDEX))) return { version: 1, segments: {} };
  try {
    const parsed = JSON.parse(await readText(state, INDEX)) as IndexFile;
    if (!parsed || typeof parsed !== "object" || typeof parsed.segments !== "object") {
      throw new Error("malformed");
    }
    return parsed;
  } catch (e) {
    throw new Error(`segment-store: index.json is unreadable/corrupt: ${(e as Error).message}`);
  }
};

// Index-last + tmp-file-rename: write the new index to a temp path, then
// rename over the live file. The rename is atomic on every backend we
// target, so a reader sees either the old or the new index, never a
// partial write.
const writeIndexAtomic = async (state: State, idx: IndexFile): Promise<void> => {
  await writeText(state, INDEX_TMP, JSON.stringify(idx, null, 2));
  await rename(state, INDEX_TMP, INDEX);
};

// ----- Ops -----

// putRaw is the unguarded write: validate name/version, write the two
// files, update the index atomically. It does NOT refuse kernel-closure
// segments — that guard lives on the public `put` below. The seeding
// path (opfs-seeding) needs to write the kernel closure into the store,
// so it composes over putRaw directly. Exported for that reason; not a
// formula-facing cel.
const putRaw: Fn = async (
  stateArg: unknown, nameArg: unknown, versionArg: unknown, manifest: unknown, segment: unknown,
) => {
  const state = stateArg as State;
  const name = assertComponent("name", nameArg);
  const version = assertComponent("version", versionArg);

  // origin-user docs land under their app's documents/ subfolder; apps/libs flat.
  const app = appOfManifest(manifest);
  // Per-segment files first, so any index entry we add below already has
  // its payload on disk.
  const dir = dirOf(name, version, app);
  // Content-address the segment: stamp the manifest's sha from the dehydrated
  // cels (the origin load-gate pins an origin-user against its app's sha).
  (manifest as { sha?: string }).sha = contentHash(JSON.stringify(segment));
  await writeText(state, `${dir}/manifest.json`, JSON.stringify(manifest, null, 2));
  await writeText(state, `${dir}/segment.json`, JSON.stringify(segment, null, 2));

  const idx = await readIndex(state);
  const entry = idx.segments[name] ?? { latest: version, versions: [] };
  if (!entry.versions.includes(version)) entry.versions.push(version);
  entry.latest = version;
  if (app) entry.app = app; else delete entry.app;
  idx.segments[name] = entry;
  await writeIndexAtomic(state, idx);
};

const put: Fn = async (
  stateArg: unknown, nameArg: unknown, versionArg: unknown, manifest: unknown, segment: unknown,
) => {
  // Kernel-role guard runs BEFORE the write — calling the public put on a
  // kernel-closure segment is a programming error (use the seeding path).
  if ((manifest as 冊)?.role === "kernel") {
    throw new Error(
      `segment-store: refusing to put kernel-closure segment "${String(nameArg)}" — kernel seeds are bundled, not stored.`,
    );
  }
  return putRaw(stateArg, nameArg, versionArg, manifest, segment);
};

const get: Fn = async (stateArg: unknown, nameArg: unknown, versionArg?: unknown) => {
  const state = stateArg as State;
  const name = String(nameArg);
  const idx = await readIndex(state);
  const entry = idx.segments[name];
  if (!entry) return undefined;
  const version = versionArg === undefined ? entry.latest : String(versionArg);
  if (!entry.versions.includes(version)) return undefined;
  const dir = dirOf(name, version, entry.app);
  if (!(await exists(state, `${dir}/manifest.json`))) return undefined;
  const manifest = JSON.parse(await readText(state, `${dir}/manifest.json`)) as 冊;
  const segment = JSON.parse(await readText(state, `${dir}/segment.json`)) as 甲骨;
  return { manifest, segment };
};

const list: Fn = async (stateArg: unknown) => {
  const idx = await readIndex(stateArg as State);
  // `app` marks a DOCUMENT (installed under an application) — pickers use it
  // to tell openable docs from library/application segments.
  return Object.entries(idx.segments).map(([name, entry]) =>
    ({ name, latest: entry.latest, ...(entry.app ? { app: entry.app } : {}) }));
};

const del: Fn = async (stateArg: unknown, nameArg: unknown, versionArg?: unknown) => {
  const state = stateArg as State;
  const name = String(nameArg);
  const idx = await readIndex(state);
  const entry = idx.segments[name];
  if (!entry) return; // nothing to do
  const version = versionArg === undefined ? entry.latest : String(versionArg);

  await rmdir(state, dirOf(name, version, entry.app));

  entry.versions = entry.versions.filter((v) => v !== version);
  if (entry.versions.length === 0) {
    delete idx.segments[name];
  } else if (entry.latest === version) {
    // Repoint latest to the most-recent remaining version. v1 has no
    // semver ordering; "last surviving in insertion order" is the rule.
    entry.latest = entry.versions[entry.versions.length - 1];
  }
  await writeIndexAtomic(state, idx);
};

const has: Fn = async (stateArg: unknown, nameArg: unknown) => {
  const idx = await readIndex(stateArg as State);
  return Boolean(idx.segments[String(nameArg)]);
};

// ----- Segment export -----

export const name = "segment-store" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["store.put",    put],
  ["store.get",    get],
  ["store.list",   list],
  ["store.delete", del],
  ["store.has",    has],
  // Unguarded write + raw index read, cel-bound so sibling segments
  // (opfs-seeding, cli-segment-export) compose via dispatch, never import.
  ["store.putRaw",    putRaw],
  ["store.readIndex", (async (st: unknown) => readIndex(st as State)) as Fn],
]));
