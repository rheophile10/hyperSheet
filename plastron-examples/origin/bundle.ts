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
  // quickjs is NOT external — the singlefile variant (embedded wasm) bundles
  // inline so kind "js"/"quickjs" works offline in one index.html (wasm-only-
  // functions). pyodide/wabt stay external (CDN-loaded, lazy).
  external: ["pyodide", "wabt", "node:fs/promises", "node:path"],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("bundle: Bun.build failed");
}

await inlineAssets(HTML);

// Inline sql.js (the browser SQLite, vendored at vendor/sql.js) so =db / =sql
// work fully offline — no CDN fetch. The kernel's loadSqlJs uses the inlined
// initSqlJs + the __sqliteWasm bytes (and only falls back to the CDN when this
// isn't present, e.g. a minimal build).
const sqlDir = join(import.meta.dir, "vendor", "sql.js");
const sqlJs = (await Bun.file(join(sqlDir, "sql-wasm.js")).text()).replace(/<\/script>/g, "<\\/script>");
const sqlWasmB64 = Buffer.from(await Bun.file(join(sqlDir, "sql-wasm.wasm")).bytes()).toString("base64");
const sqlInline =
  `<script>${sqlJs}</script>` +
  `<script>globalThis.__sqliteWasm=Uint8Array.from(atob(${JSON.stringify(sqlWasmB64)}),c=>c.charCodeAt(0));</script>`;
{
  let html = await Bun.file(HTML).text();
  html = html.includes("</body>") ? html.replace("</body>", `${sqlInline}</body>`) : html + sqlInline;
  await Bun.write(HTML, html);
}

const bytes = (await Bun.file(HTML).bytes()).length;
const leftovers = (await readdir(OUT)).filter((f) => f !== "index.html");
console.log(`✔ dist/index.html — ${(bytes / 1024).toFixed(1)} KB`);
if (leftovers.length) throw new Error(`bundle: expected a single file, found extra: ${leftovers.join(", ")}`);
