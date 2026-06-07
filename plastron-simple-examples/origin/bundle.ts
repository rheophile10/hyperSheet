// ============================================================================
// bundle — produce a single self-contained dist/index.html for the origin
// host (the north-star starting point: 元 in freespace). Mirrors the
// plastron-os bundler but with no Doom assets, so the output is tiny.
//   bun bundle.ts
// Never commit dist/ — reproducible from source (the Pages workflow rebuilds).
// ============================================================================
import { join } from "node:path";
import { rm, readdir } from "node:fs/promises";
import { inlineAssets } from "../plastron-os/inline-assets.js";

const OUT = join(import.meta.dir, "dist");
const HTML = join(OUT, "index.html");

await rm(OUT, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "index.html")],
  outdir: OUT,
  target: "browser",
  minify: true,
  sourcemap: "none",
  external: ["pyodide", "quickjs-emscripten", "wabt", "node:fs/promises", "node:path"],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("bundle: Bun.build failed");
}

await inlineAssets(HTML);

const bytes = (await Bun.file(HTML).bytes()).length;
const leftovers = (await readdir(OUT)).filter((f) => f !== "index.html");
console.log(`✔ dist/index.html — ${(bytes / 1024).toFixed(1)} KB`);
if (leftovers.length) throw new Error(`bundle: expected a single file, found extra: ${leftovers.join(", ")}`);
