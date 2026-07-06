// Dev server for the origin host. Bun bundles the HTML entry on the fly AND
// bakes the [[APP_ARCHIVES]] sentinel (the app/doc archives the desktop boots
// from) — the production build does this in bundle.ts; without it boot.run's
// JSON.parse of #plastron-apps throws and the page renders blank.
//   bun serve.ts   →   http://localhost:5174
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.PORT ?? 5174);
const root = new URL("./", import.meta.url).pathname;
// dev: never let the browser cache HTML/JS, so a plain reload always shows the
// latest bundle + baked archives (clearing site data does NOT clear the HTTP cache).
const NOCACHE = { "cache-control": "no-store, no-cache, must-revalidate", "pragma": "no-cache" };

// { <name>: <archive>, "doc:<name>": <doc-archive> } from apps/*.json + apps/docs/*.json
const bakeArchives = async (): Promise<string> => {
  const appsDir = join(root, "apps");
  const apps: Record<string, unknown> = {};
  for (const f of (await readdir(appsDir)).sort()) {
    if (!f.endsWith(".json")) continue;
    apps[f.replace(/\.json$/, "")] = JSON.parse(await Bun.file(join(appsDir, f)).text());
  }
  const docsDir = join(appsDir, "docs");
  for (const f of (await readdir(docsDir).catch(() => [])).sort()) {
    if (!f.endsWith(".json")) continue;
    apps[`doc:${f.replace(/\.json$/, "")}`] = JSON.parse(await Bun.file(join(docsDir, f)).text());
  }
  return JSON.stringify(apps).replace(/<\/script>/g, "<\\/script>");
};

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (path === "/index.html") {
      const built = await Bun.build({ entrypoints: [root + "index.html"], target: "browser" });
      for (const a of built.outputs) if (a.path.endsWith(".html")) {
        const archives = await bakeArchives();
        // update stamp ({id, notice}) — same recipe as bundle.ts (hash of baked
        // archives + UPDATE.md), so dev boots exercise the update banner too.
        const notice = await Bun.file(join(root, "UPDATE.md")).text().catch(() => "");
        const updateInfo = JSON.stringify({ id: Bun.hash(archives + notice).toString(36), notice })
          .replace(/<\/script>/g, "<\\/script>");
        const html = (await a.text())
          .replace("[[APP_ARCHIVES]]", () => archives) // function form — json has $ patterns
          // anchored to the tag (see bundle.ts): kernel JS mentions sentinel-shaped strings
          .replace('id="plastron-update">[[UPDATE_INFO]]</script>', () => `id="plastron-update">${updateInfo}</script>`)
          .replace("[[LLMS_GUIDE]]", "");              // dev: skip the (non-functional) llms guide bake
        return new Response(html, { headers: { "content-type": "text/html", ...NOCACHE } });
      }
    }
    // Static assets served from the site root at RUNTIME. bundle.ts copies these
    // into dist/ for production; the dev server reads them from their source
    // dirs. Without this, =doom() fetches /doom.wasm and falls through to the
    // JS-bundle catch-all below → WebAssembly.instantiate gets JavaScript →
    // black screen. Keep in sync with bundle.ts's asset copy + ALLOWED set.
    const STATIC: Record<string, { src: string; type: string }> = {
      "/doom.wasm":       { src: join(root, "..", "doom", "doom.wasm"), type: "application/wasm" },
      "/freedoom1.wad":   { src: join(root, "..", "doom", "freedoom1.wad"), type: "application/octet-stream" },
      // plastron-gpu's lazy renderer (三 delivery, 01-rendering.md): the
      // vendored pinned three build; three.module.js imports ./three.core.js.
      "/three.module.js": { src: join(root, "vendor", "three", "three.module.js"), type: "text/javascript" },
      "/three.core.js":   { src: join(root, "vendor", "three", "three.core.js"), type: "text/javascript" },
    };
    if (path in STATIC) {
      const entry = STATIC[path]!;
      const file = Bun.file(entry.src);
      if (await file.exists()) return new Response(file, { headers: { "content-type": entry.type, ...NOCACHE } });
      return new Response("not found", { status: 404 });
    }
    const built = await Bun.build({ entrypoints: [root + "origin-main.ts"], target: "browser" });
    for (const a of built.outputs) if (a.path.endsWith(".js")) return new Response(await a.text(), { headers: { "content-type": "text/javascript", ...NOCACHE } });
    return new Response("not found", { status: 404 });
  },
});
console.log(`🜮 origin host on http://localhost:${port}`);
