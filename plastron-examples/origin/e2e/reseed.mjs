// e2e: the desktop's ↻ reseed button (origin.reseed, wired in 元's formula) is the
// dev/refresh twin of seedStarter — it FORCE-overwrites the OPFS starter files from
// the page's embedded manifest (even if they exist) and clears the win.geom of the
// worksheets they declare, so an edited geom() re-applies on reopen.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const PORT = 8794, dist = new URL("../dist", import.meta.url).pathname;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; p.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
await p.goto(`http://localhost:${PORT}/index.html`);
await p.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
await p.waitForTimeout(1500);
let pass = 0, fail = 0; const ok = (c, w, g) => { if (c) { pass++; console.log("  ✔", w); } else { fail++; console.log("  ✘", w, "got:", JSON.stringify(g)); } };

// the button lives in 元's formula (desktop genesis), so it's on the clean desktop.
ok(await p.$(".pl-reseed"), "the ↻ reseed button renders on the desktop (from 元's formula)");

// make /readme.f STALE + give readme a stale win.geom, then click ↻ reseed.
await p.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "fs.writeText")("/readme.f", "STALE — should be overwritten");
  const m = { ...(state.cels.get("win.geom")?.v ?? {}) }; m.readme = { x: 9, y: 9, w: 9, h: 9 };
  await resolveFn(state, "setValue")(state, "win.geom", m);
});
await p.click(".pl-reseed");
await p.waitForTimeout(400);
const after = await p.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  return { file: String(await resolveFn(state, "fs.readText")("/readme.f")), geom: state.cels.get("win.geom")?.v?.readme ?? null };
});
ok(!after.file.startsWith("STALE") && after.file.startsWith('=cels("readme"'), "reseed OVERWROTE /readme.f from the manifest", after.file.slice(0, 20));
ok(after.geom == null, "reseed cleared win.geom[readme] so its geom() re-applies on reopen", after.geom);
// reopening the readme now picks up the manifest's geom() (proportional → real px)
await (await p.$('button.pl-nav-icon:has-text("Readme")')).click();
await p.waitForTimeout(800);
const reopened = await p.evaluate(() => globalThis.plastron.state.cels.get("win.geom")?.v?.readme ?? null);
ok(reopened && reopened.w > 50, "reopened readme got a real geom from the refreshed file", reopened);

ok(errs.filter((e) => !/reading 'get'/.test(e)).length === 0, "no page errors", errs.slice(0, 2));
await b.close(); srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
