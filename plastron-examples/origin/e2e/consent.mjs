// e2e: the CONSENT security model in real headless chromium (replaces quarantine.mjs).
// A LOCKED (shared/URL) session blocks a dangerous fn until the user consents; an
// own session is trusted.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const PORT = 8801, dist = "/home/ian/projects/plastron/plastron-examples/origin/dist";
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));
let failed = 0; const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const p = await b.newPage();
  await p.goto(`http://localhost:${PORT}/index.html`);
  await p.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
  await p.waitForTimeout(300);
  const put = (src, key) => p.evaluate(async ({ src, key }) => {
    const { state, resolveFn } = globalThis.plastron;
    await resolveFn(state, "origin.edit")(state, key);
    await resolveFn(state, "setValue")(state, "元.draft", src);
    await resolveFn(state, "origin.run")(state, key);
    for (let i = 0; i < 6; i++) { await resolveFn(state, "runCycle")(state); if (state.cels.get("origin.effects")) await resolveFn(state, "drain")(state, "origin.effects"); }
    return String(state.cels.get(key)?.v ?? "");
  }, { src, key });
  const setConsentCel = (patch) => p.evaluate((patch) => { const { state } = globalThis.plastron; const c = state.cels.get("consent")?.v ?? {}; state.cels.set("consent", { celType: "ValueCel", metadata: { key: "consent", segment: "kernel" }, v: { ...c, ...patch }, locked: false }); }, patch);

  const CDN = '=cdn("https://cdn.jsdelivr.net/npm/canvas-confetti")';
  ok((await put(CDN, "c1")).startsWith("loaded"), "own session: =cdn runs (trusted)");
  await setConsentCel({ __locked: true });  // what bootFromHash does for a shared #f= sheet
  ok(/#BLACKLISTED\(cdn/.test(await put(CDN, "c2")), "locked session: =cdn is #BLACKLISTED until consented");
  await setConsentCel({ cdn: { allow: true, category: "net" } });
  ok((await put(CDN, "c3")).startsWith("loaded"), "after consent: =cdn runs");
} finally { await b.close(); srv.kill(); }
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ consent e2e passed");
process.exit(failed ? 1 : 0);
