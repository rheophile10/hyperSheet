// e2e: the UPDATE-NOTIFICATION system — how a plastron.ca visitor learns an
// update shipped and opts into it:
//   bundle.ts/serve.ts bake {id, notice} (hash of baked archives + UPDATE.md)
//   into the inert #plastron-update tag → boot's origin.updateCheck compares
//   the id against the persisted last-seen id (/plastron/update-seen) →
//   mismatch fills origin.update → the desktop 🔄 chip surfaces (updatebanner)
//   → click → the what's-new window (UPDATE.md, pre-wrap) → [Later] persists
//   the seen id and dismisses; [🔄 Refresh demo docs & reload] force-reinstalls
//   the baked set (no confirm — the flow IS the consent), persists, reloads.
// First boot on a fresh profile is CURRENT by definition: the seen id
// initializes to the page's id and no banner shows.
//   bun e2e/update-notice.mjs        (spawns its own dev server on :8899)
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT ?? 8899);
const originDir = new URL("..", import.meta.url).pathname;
const srv = spawn("bun", ["serve.ts"], { cwd: originDir, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://localhost:${PORT}/index.html`); if (r.ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0, last;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); if (!c) console.log("      last:", JSON.stringify(last)?.slice(0, 240)); };

const bakedId = () => page.evaluate(() => JSON.parse(document.getElementById("plastron-update")?.textContent ?? "{}").id ?? null);
const seenId = () => page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  try { return String(await resolveFn(state, "fs.readText")("/plastron/update-seen")); } catch { return null; }
});
const chipVisible = () => page.evaluate(() => !!document.querySelector(".pl-update-chip button"));
const boot = async (reload = false) => {
  if (reload) await page.reload(); else await page.goto(`http://localhost:${PORT}/index.html`, { timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });
  await page.waitForTimeout(1800);   // boot.run: install → updateCheck → desktop hydrate + paint
};

// ── 1) FRESH profile: current by definition — no banner, marker initialized ──
await boot();
const id0 = await bakedId();
ok(typeof id0 === "string" && id0.length > 0, `the page bakes a build stamp (#plastron-update id ${id0})`);
last = await chipVisible();
ok(last === false, "fresh boot: NO update chip (fresh install is current)");
last = await seenId();
ok(last === id0, `fresh boot initialized the seen id to the page's (${last})`);

// ── 2) STALE profile: an old seen id + reload → the chip surfaces ────────────
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "fs.writeText")("/plastron/update-seen", "stale-build-0");
});
await boot(true);
last = await chipVisible();
ok(last === true, "stale seen id + reload: the 🔄 update chip surfaces (top-right)");

// ── 3) chip click → the what's-new window shows the UPDATE.md notice ─────────
await page.click(".pl-update-chip button");
await page.waitForTimeout(700);
last = await page.evaluate(() => document.querySelector(".pl-update-notice")?.textContent ?? "");
ok(/What's new/.test(last) && /Formula-first fish docs/i.test(last), `the notice window shows UPDATE.md (${JSON.stringify(last.slice(0, 60))}…)`);
ok(await page.evaluate(() => !!document.querySelector(".pl-update-later") && !!document.querySelector(".pl-update-refresh")),
  "the window offers [Later] and [🔄 Refresh demo docs & reload]");

// ── 4) [Later]: dismiss — seen id persists, chip unmounts, stays gone ────────
await page.click(".pl-update-later");
await page.waitForTimeout(600);
ok((await chipVisible()) === false, "[Later] dismisses the chip immediately (origin.update cleared reactively)");
ok(await page.evaluate(() => (globalThis.plastron.state.cels.get("win.update.state")?.v?.closed ?? 0) === 1), "[Later] closes the notice window");
ok((await seenId()) === id0, "[Later] persisted the seen id");
await boot(true);
ok((await chipVisible()) === false, "after reload: still no chip (dismissed until the next build)");

// ── 5) [Refresh]: stale again → delete a baked doc → refresh reinstalls it ───
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "fs.writeText")("/plastron/update-seen", "stale-build-1");
});
await boot(true);
ok((await chipVisible()) === true, "stale again: the chip is back");
// simulate a drifted install: drop a baked doc from the store
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "store.delete")(state, "boids");
});
last = await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  return (await resolveFn(state, "store.list")(state)).some((e) => e.name === "boids");
});
ok(last === false, "precondition: the boids demo doc deleted from the store");
await page.click(".pl-update-chip button");
await page.waitForTimeout(700);
await page.click(".pl-update-refresh");            // force-reinstall + seen id + location.reload()
await page.waitForTimeout(2500);                   // ride the reload
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });
await page.waitForTimeout(1800);
last = await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  return (await resolveFn(state, "store.list")(state)).filter((e) => e.name === "boids");
});
ok(last?.length === 1, `[Refresh] reinstalled the baked set (boids back in the store: ${JSON.stringify(last)})`);
ok((await chipVisible()) === false, "after the refresh-reload: no chip (seen id persisted before reload)");
ok((await seenId()) === id0, "the seen id equals the page's build id");

ok(errs.length === 0, `no page errors (${errs.length ? errs[0]?.slice(0, 200) : "clean"})`);

console.log(`\n${pass} pass, ${fail} fail`);
await browser.close();
srv.kill();
process.exit(fail ? 1 : 0);
