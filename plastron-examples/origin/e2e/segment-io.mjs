// e2e: the segment-io round-trip in real headless chromium — mint a workbook,
// =export it to a 甲骨 archive, =import it into a FRESH page, verify it round-trips.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const PORT = 8802, dist = "/home/ian/projects/plastron/plastron-examples/origin/dist";
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));
let failed = 0; const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const newPage = async () => { const p = await b.newPage(); await p.goto(`http://localhost:${PORT}/index.html`); await p.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 }); await p.waitForTimeout(300); return p; };
const put = (p, src, key) => p.evaluate(async ({ src, key }) => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "origin.edit")(state, key);
  await resolveFn(state, "setValue")(state, "元.draft", src);
  await resolveFn(state, "origin.commit")(state, key);
  for (let i = 0; i < 8; i++) { await resolveFn(state, "runCycle")(state); if (state.cels.get("genesis.commit")) await resolveFn(state, "drain")(state, "genesis.commit"); if (state.cels.get("origin.effects")) await resolveFn(state, "drain")(state, "origin.effects"); }
  return String(state.cels.get(key)?.v ?? "");
}, { src, key });
try {
  const a = await newPage();
  await put(a, '(cels 2 2 "books" (at "A1" "title") (at "B2" 7))', "books_gen");
  const archive = await put(a, '=export("books")', "x1");
  ok(/"books\.B2"/.test(archive), "=export produced a 甲骨 archive of the segment");

  const d = await newPage();
  ok(await d.evaluate(() => globalThis.plastron.state.cels.get("books.B2") === undefined), "fresh page has no books");
  const msg = await put(d, `=import('${archive}')`, "i1");
  ok(/imported books/.test(msg), "=import confirms");
  ok(await d.evaluate(() => globalThis.plastron.state.cels.get("books.B2")?.v === 7), "B2 round-trips to 7");
  ok(await d.evaluate(() => globalThis.plastron.state.cels.get("books.A1")?.v === "title"), "A1 round-trips");
} finally { await b.close(); srv.kill(); }
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ segment-io e2e passed");
process.exit(failed ? 1 : 0);
