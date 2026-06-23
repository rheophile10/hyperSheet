// version — snapshot llms.md so every recorded result is traceable to the EXACT
// guide that produced it. On each run we content-hash llms.md, archive a copy
// under versions/llms-<hash>.md (idempotent — same content → same file, written
// once), and return the short id to stamp on every CSV row.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const VERSIONS_DIR = join(here, "versions");

export interface GuideVersion {
  id: string;        // short content hash, e.g. "a1b2c3d4"
  path: string;      // the archived snapshot path
  source: string;    // the full llms.md text (the system prompt)
  bytes: number;
}

/** Hash + archive the current llms.md; return its version id + text. */
export const snapshotGuide = (): GuideVersion => {
  const srcPath = join(here, "..", "llms.md");
  const source = readFileSync(srcPath, "utf8");
  const id = createHash("sha256").update(source).digest("hex").slice(0, 12);
  if (!existsSync(VERSIONS_DIR)) mkdirSync(VERSIONS_DIR, { recursive: true });
  const path = join(VERSIONS_DIR, `llms-${id}.md`);
  if (!existsSync(path)) writeFileSync(path, source);
  return { id, path, source, bytes: Buffer.byteLength(source, "utf8") };
};

// CLI: `bun version.ts` → print the current guide id (and archive it).
if (import.meta.main) {
  const v = snapshotGuide();
  console.log(`llms.md version ${v.id}  (${(v.bytes / 1024).toFixed(1)} KB)  → ${v.path.replace(here + "/", "")}`);
}
