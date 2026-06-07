// Dev server for the origin host. Bun bundles the HTML entry on the fly.
//   bun serve.ts   →   http://localhost:5174
const port = Number(process.env.PORT ?? 5174);
const root = new URL("./", import.meta.url).pathname;
Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (path === "/index.html") {
      const built = await Bun.build({ entrypoints: [root + "index.html"], target: "browser" });
      for (const a of built.outputs) if (a.path.endsWith(".html")) return new Response(await a.text(), { headers: { "content-type": "text/html" } });
    }
    const built = await Bun.build({ entrypoints: [root + "origin-main.ts"], target: "browser" });
    for (const a of built.outputs) if (a.path.endsWith(".js")) return new Response(await a.text(), { headers: { "content-type": "text/javascript" } });
    return new Response("not found", { status: 404 });
  },
});
console.log(`🜮 origin host on http://localhost:${port}`);
