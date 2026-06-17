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
import { createInitialState, resolveFn, precomputeOptional } from "../../plastron/dist/index.js";
import { vocabText } from "../../plastron/dist/甲骨坑/application/origin/index.js";
import { encodeOtpLink, otpDecryptPayload, parseOtpUrl } from "../../plastron/dist/甲骨坑/application/origin/share-link.js";

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

// Bake the =vocab() catalog into the <noscript> guide (the [[VOCAB_CATALOG]]
// sentinel in index.html). We boot the origin kernel HEADLESS (no painter —
// vocabText only reads state.cels) and emit the same plain text the in-app
// =vocab() produces, HTML-escaped. If anything fails, fall back to a pointer
// to the live catalog rather than breaking the build.
{
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let catalog: string;
  try {
    const resolve = resolveFn as (s: unknown, k: string) => (...a: unknown[]) => Promise<unknown> | unknown;
    const state = createInitialState();
    await resolve(state, "ensureSegments")(state, ["origin"]);
    await resolve(state, "hydrate")(state, [], []);
    await (resolveFn(state, "precomputeOptional") ?? precomputeOptional)(state);
    await resolve(state, "runCycle")(state);
    catalog = esc(vocabText(state));
  } catch (e) {
    console.warn(`bundle: vocab bake failed (${e}); falling back to a live-catalog pointer`);
    catalog = "(open https://plastron.ca/#raw=%3Dvocab() to read the live catalog)";
  }
  let html = await Bun.file(HTML).text();
  if (!html.includes("[[VOCAB_CATALOG]]")) throw new Error("bundle: [[VOCAB_CATALOG]] sentinel missing from index.html");
  html = html.replace("[[VOCAB_CATALOG]]", catalog);
  await Bun.write(HTML, html);
}

// Bake the WORKED OTP DEMO ([[OTP_DEMO]] sentinel) using the SHIPPED card.png as
// the pad — the deploy serves the identical card at /card.png, so the URL is
// always byte-consistent with what visitors download. The pad is PUBLIC, so this
// is a codec demo, not a secret message (the surrounding prose says so). A
// build-time round-trip guard catches any drift. Falls back to a pointer.
{
  const DEMO_FORMULA = `=dom("h2", "🔑 decrypted with the 🐢 card as a one-time pad")`;
  let block: string;
  try {
    const card = await Bun.file(join(import.meta.dir, "card.png")).bytes();
    const { url } = await encodeOtpLink(DEMO_FORMULA, card, "card-png", "https://plastron.ca/");
    // round-trip guard: the baked URL MUST decrypt back with the same card bytes.
    const back = await otpDecryptPayload(parseOtpUrl(url).payload, card);
    if (back !== DEMO_FORMULA) throw new Error("otp demo round-trip mismatch");
    block = `  formula  ${DEMO_FORMULA}\n  pad      https://plastron.ca/card.png  (${card.length} bytes — download it, load it in the picker)\n  link     ${url}`;
  } catch (e) {
    console.warn(`bundle: otp demo bake failed (${e}); falling back to a pointer`);
    block = `  (open https://plastron.ca/ and run =otpEncrypt() with a pad file to make your own #otp= link)`;
  }
  let html = await Bun.file(HTML).text();
  if (!html.includes("[[OTP_DEMO]]")) throw new Error("bundle: [[OTP_DEMO]] sentinel missing from index.html");
  html = html.replace("[[OTP_DEMO]]", block);
  await Bun.write(HTML, html);
}

const bytes = (await Bun.file(HTML).bytes()).length;
const leftovers = (await readdir(OUT)).filter((f) => f !== "index.html");
console.log(`✔ dist/index.html — ${(bytes / 1024).toFixed(1)} KB`);
if (leftovers.length) throw new Error(`bundle: expected a single file, found extra: ${leftovers.join(", ")}`);
