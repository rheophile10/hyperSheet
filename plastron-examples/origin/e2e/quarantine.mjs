// e2e/quarantine — the security model in a REAL browser:
//   1. the desktop control panel (⬇ 龜甲 + 🛡 per-capability toggles) renders.
//   2. a #raw= URL boots a LOCKED kernel and the shared formula IS 元.
//   3. a net-using shared formula comes back #DENIED — the jail holds.
//   4. =jail(seed) renders a sandboxed iframe (allow-scripts, no same-origin).
import { chromium } from "playwright";
import { join, dirname } from "path"; import { fileURLToPath } from "url";
import { spawn } from "child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8762;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", join(repoRoot, "dist")], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));
const URL = `http://localhost:${PORT}/index.html`;
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; };

const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await b.newContext();
const booted = (page) => page.waitForFunction(() => globalThis.plastron && globalThis.plastron.state, { timeout: 15000 });

try {
  // ── 1. normal boot: the control panel renders ───────────────────────────
  const p1 = await ctx.newPage();
  await p1.goto(URL); await booted(p1);
  await p1.waitForSelector(".pl-ctl", { timeout: 8000 }).catch(() => {});
  ok(await p1.$(".pl-ctl") !== null, "desktop control panel (.pl-ctl) renders");
  const panelText = (await p1.textContent(".pl-ctl").catch(() => "")) ?? "";
  ok(/龜甲/.test(panelText), "⬇ 龜甲 download button present");
  ok(["code", "net", "storage", "secrets"].every((c) => panelText.includes(c)), "🛡 per-capability toggles present (code/net/storage/secrets)");
  const kFull = await p1.evaluate(() => globalThis.plastron.state.cels.get("信.kernel")?.v ?? "none");
  ok(kFull === "none", "no-hash boot leaves the kernel FULL (no 信.kernel lock cel)");

  // ── 2. #raw= URL boots LOCKED and the shared formula IS 元 ──────────────
  const p2 = await ctx.newPage();
  await p2.goto(URL + "#raw=" + encodeURIComponent("=6+36")); await booted(p2);
  await p2.waitForTimeout(600);
  const r2 = await p2.evaluate(() => ({ k: globalThis.plastron.state.cels.get("信.kernel")?.v, y: globalThis.plastron.state.cels.get("元")?.v }));
  ok(r2.k && r2.k.net === false && r2.k.code === false, "#raw= boot LOCKS the kernel (net/code off)");
  ok(r2.y === 42, "the shared formula became 元 and rendered jailed (=6+36 → 42)");

  // ── 3. a net-using shared formula is #DENIED ────────────────────────────
  const p3 = await ctx.newPage();
  await p3.goto(URL + "#raw=" + encodeURIComponent('=chat("hi","k","m","https://api.anthropic.com")')); await booted(p3);
  await p3.waitForTimeout(800);
  const y3 = await p3.evaluate(() => String(globalThis.plastron.state.cels.get("元")?.v ?? ""));
  ok(y3.startsWith("#DENIED(net"), `net refused on a URL boot — the jail holds (got ${y3.slice(0, 40)})`);

  // ── 4. jail(seed) → a sandboxed iframe ──────────────────────────────────
  const j = await p1.evaluate(async () => {
    const { state, resolveFn } = globalThis.plastron;
    await resolveFn(state, "setValue")(state, "元.draft", '=jail("=cels(3,3)")');
    await resolveFn(state, "origin.commit")(state, "jtest");
    await resolveFn(state, "drain")(state, "origin.effects");
    const v = state.cels.get("jtest")?.v;
    return { tag: v?.tag, sandbox: v?.attrs?.sandbox, src: v?.attrs?.src };
  });
  ok(j.tag === "iframe" && j.sandbox === "allow-scripts" && !/same-origin/.test(j.sandbox), "jail() → <iframe sandbox=allow-scripts> (opaque origin, never same-origin)");
  ok(/#raw=/.test(j.src ?? ""), "the jail iframe boots this page with the seed in #raw=");
} finally {
  await b.close(); srv.kill();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
