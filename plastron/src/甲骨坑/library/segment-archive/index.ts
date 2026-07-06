import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// segment-archive — tiered + whole-workspace export/import as a role-foldered
// .zip (the `.甲` archive), over dehydrate/hydrate + the zero-dep zip core.
// Runtime-agnostic: the ops take/return Uint8Array, so the host wires the
// sink/source (browser download/upload, or node-fs). The kernel closure is
// always excluded — it ships in the bundle. See
// docs/1-design/2-in-evaluation/segment-archive.md.
//
// The importable surface IS the surface. (The five segment-archive.* verb
// wrappers were removed — every runtime consumer imports these fns directly:
// sheet-io takes zipBytes/unzipBytes, hosts take buildArchive/loadArchive.
// Compose an export as buildArchive(state, includeFor…(state, name)).)
// ============================================================================

export const name = "segment-archive" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>());

export {
  buildArchive, loadArchive,
  includeAll, includeForApplication, includeForLibrary, includeForUser,
  type LoadOptions,
} from "./utils/archive.js";
export { zipBytes, unzipBytes } from "./utils/zip.js";
