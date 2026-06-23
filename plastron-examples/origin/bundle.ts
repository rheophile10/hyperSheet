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

// Inject the canonical guide from llms.md — THE SINGLE SOURCE. index.html's #llms
// <pre> is just a [[LLMS_GUIDE]] placeholder; fill it with HTML-escaped llms.md,
// whose own [[VOCAB_CATALOG]] / [[OTP_DEMO]] sentinels the blocks below then bake.
// So the #llms div, dist/llms.txt, and the <head> guide block are ALL downstream
// of llms.md — edit that one file and every channel (incl. the llm-eval system
// prompt, which reads llms.md directly) stays in sync.
{
  const md = await Bun.file(join(import.meta.dir, "llms.md")).text();
  const escMd = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = await Bun.file(HTML).text();
  if (!html.includes("[[LLMS_GUIDE]]")) throw new Error("bundle: [[LLMS_GUIDE]] sentinel missing from index.html #llms");
  html = html.replace("[[LLMS_GUIDE]]", () => escMd);   // function form — md may contain $ patterns
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

// Bake the STARTER KIT ([[STARTER_KIT]] sentinel): an inert JSON manifest mapping
// each repo starter/ file to its OPFS path. The first desktop boot's
// origin.seedStarter reads this and fs.writes any missing file, so readme/keyboard
// are real, discoverable files in OPFS rather than baked seed cells.
{
  const starterDir = join(import.meta.dir, "starter");
  const manifest: Record<string, string> = {};
  for (const f of (await readdir(starterDir)).sort()) {
    manifest[`/${f}`] = await Bun.file(join(starterDir, f)).text();
  }
  const json = JSON.stringify(manifest).replace(/<\/script>/g, "<\\/script>");
  let html = await Bun.file(HTML).text();
  if (!html.includes("[[STARTER_KIT]]")) throw new Error("bundle: [[STARTER_KIT]] sentinel missing from index.html");
  html = html.replace("[[STARTER_KIT]]", () => json);   // function form — json has $ patterns
  await Bun.write(HTML, html);
  console.log(`✔ starter kit — ${Object.keys(manifest).length} files (${(json.length / 1024).toFixed(1)} KB)`);
}

// Bake the WORKED OTP DEMO ([[OTP_DEMO]] sentinel) using the SHIPPED card.png as
// the pad — the deploy serves the identical card at /card.png, so the URL is
// always byte-consistent with what visitors download. The pad is PUBLIC, so this
// is a codec demo, not a secret message (the surrounding prose says so). A
// build-time round-trip guard catches any drift. Falls back to a pointer.
{
  const DEMO_FORMULA = `=dom("h1", "🐢 turtles all the way down")`;
  let block: string;
  try {
    const card = await Bun.file(join(import.meta.dir, "card.png")).bytes();
    const { url } = await encodeOtpLink(DEMO_FORMULA, card, "card.png", "https://plastron.ca/");
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

// Emit /llms.txt — the SAME guide as the #llms div, but as a small standalone
// text/plain resource. The div lives ~2/3 through a ~2.9 MB single-file bundle and
// is aria-hidden/sr-only, so fetch tools TRUNCATE past it or readability-style
// extractors STRIP it (this is why Grok couldn't see it). A dedicated llms.txt is
// the reliable channel: tiny, plain text, nothing to render or strip.
{
  const finalHtml = await Bun.file(HTML).text();
  const m = finalHtml.match(/<div id="llms"[\s\S]*?<pre[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) throw new Error("bundle: #llms <pre> not found for llms.txt");
  const txt = m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
  await Bun.write(join(OUT, "llms.txt"), txt + "\n");
  console.log(`✔ dist/llms.txt — ${(txt.length / 1024).toFixed(1)} KB`);

  // Sync the GitHub README's LLM-guide section from the SAME baked guide, so a
  // model reading the repo README gets the identical text as plastron.ca/llms.txt.
  // README ← llms.txt ← llms.md (the single source). Between the sentinels only.
  {
    const readmePath = join(import.meta.dir, "..", "..", "README.md");
    const readme = await Bun.file(readmePath).text();
    const re = /(<!--LLMS_GUIDE_START-->)[\s\S]*?(<!--LLMS_GUIDE_END-->)/;
    if (re.test(readme)) {
      const inner =
        `\n<!-- GENERATED from plastron-examples/origin/llms.md by bun bundle.ts — edit llms.md, not here. -->\n`
        + `<details>\n<summary><b>📖 Full LLM / agent guide</b> — the plastron formula reference `
        + `(also at <a href="https://plastron.ca/llms.txt">plastron.ca/llms.txt</a>)</summary>\n\n`
        + "~~~\n" + txt.replace(/~~~/g, "∼∼∼") + "\n~~~\n\n</details>\n";
      await Bun.write(readmePath, readme.replace(re, (_m, p1, p2) => p1 + inner + p2));
      console.log(`✔ README.md LLM-guide section synced from llms.md`);
    } else {
      console.warn("bundle: README LLMS_GUIDE sentinels not found — skipped README sync");
    }
  }

  // ALSO surface the guide at the very TOP of <head> — an inert text/plain block
  // BEFORE Bun's ~2 MB inlined bundle — so a raw-HTML fetcher with a truncation
  // cap hits it in the first ~50 KB rather than at byte ~1.96 M. Non-executing
  // (wrong script type); re-escape any literal </script> so it can't close early.
  const headBlock =
    `<script type="text/plain" id="llms-guide" data-see="https://plastron.ca/llms.txt">\n`
    + txt.replace(/<\/script>/gi, "<\\/script>") + `\n</script>`;
  let h2 = await Bun.file(HTML).text();
  // Inject at the sentinel — placed AFTER <meta charset> + the small meta tags so
  // charset stays in the first 1024 bytes (encoding) and the metas stay early,
  // but BEFORE Bun's ~2 MB inlined bundle so the guide lands in the first ~50 KB.
  if (!h2.includes("<!--LLMS_HEAD-->")) throw new Error("bundle: <!--LLMS_HEAD--> sentinel missing from index.html <head>");
  h2 = h2.replace("<!--LLMS_HEAD-->", headBlock);
  await Bun.write(HTML, h2);
}

// DOOM assets — =doom() fetches /doom.wasm + /freedoom1.wad from the site root at
// RUNTIME (too big to inline: the 28 MB WAD would wreck the single-file bundle, so
// they ride alongside index.html, not inside it). rm() wiped dist/ at the top, so
// copy them back — otherwise a local `bun bundle.ts` + static server 404s on DOOM.
// The Pages deploy ships them the same way (.github/workflows/pages.yml).
for (const a of ["doom.wasm", "freedoom1.wad"]) {
  const src = Bun.file(join(import.meta.dir, "..", "doom", a));
  if (await src.exists()) {
    await Bun.write(join(OUT, a), src);
    console.log(`✔ dist/${a} — ${((await Bun.file(join(OUT, a)).bytes()).length / 1024 / 1024).toFixed(1)} MB`);
  } else {
    console.log(`⚠ ${a} not found — DOOM won't load until it's present (run plastron-examples/doom build)`);
  }
}

// Relocate Bun's ~1.9 MB inlined module bundle from <head> to the END of <body>,
// so <head> stays tiny and the readable document (guide block + body) comes first
// — a raw-HTML reader then gets everything before the megabytes. The bundle is
// type="module" (deferred), so it still runs after parse, after the sql.js setup
// scripts — execution order is unchanged. (Inline </script> is escaped by Bun, so
// the first </script> after the open is the real close.)
{
  let h3 = await Bun.file(HTML).text();
  const m = h3.match(/<script type="module"[^>]*>[\s\S]*?<\/script>/);
  if (!m) throw new Error("bundle: inlined module <script> not found to relocate to <body>");
  const moduleTag = m[0];
  // Use FUNCTION replacements — a string replacement would interpret $ patterns,
  // and the minified bundle is full of `$` (would corrupt/balloon the output).
  h3 = h3.replace(moduleTag, () => "");                        // pull it out of <head>
  h3 = h3.replace("</body>", () => `${moduleTag}\n</body>`);   // re-attach at end of <body>
  await Bun.write(HTML, h3);
}

const bytes = (await Bun.file(HTML).bytes()).length;
const ALLOWED = new Set(["index.html", "llms.txt", "doom.wasm", "freedoom1.wad"]);
const leftovers = (await readdir(OUT)).filter((f) => !ALLOWED.has(f));
console.log(`✔ dist/index.html — ${(bytes / 1024).toFixed(1)} KB`);
if (leftovers.length) throw new Error(`bundle: unexpected extra files in dist/: ${leftovers.join(", ")}`);
