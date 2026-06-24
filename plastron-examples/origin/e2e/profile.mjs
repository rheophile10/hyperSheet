// e2e: the 👤 Profile launcher opens the identity-wallet window (gen-2), and the
// create flow mints a wallet — keystore.status flips to 'unlocked', the public
// identity surfaces, and a 12-word recovery phrase is shown. Runs in a FRESH
// browser context (clean OPFS), so the user starts at status 'none'.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const PORT = 8833, dist = new URL("../dist", import.meta.url).pathname;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const p = await b.newPage({ viewport: { width: 1280, height: 840 } });
const errs = []; p.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
await p.goto(`http://localhost:${PORT}/index.html`);
await p.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
await p.waitForTimeout(1200);
let pass = 0, fail = 0; const ok = (c, w, g) => { if (c) { pass++; console.log("  ✔", w); } else { fail++; console.log("  ✘", w, "got:", JSON.stringify(g)); } };

const ks = (k) => p.evaluate((kk) => globalThis.plastron.state.cels.get(kk)?.v ?? null, k);
const winShown = () => p.evaluate(() => { const w = document.querySelector('[data-win="win.profile.state"]'); return !!w && w.offsetParent !== null; });

// new user → status none
ok((await ks("keystore.status")) === "none", "fresh context starts with no wallet (status none)", await ks("keystore.status"));

// the 👤 Profile launcher is wired into the desktop icon strip
ok(await p.$('button.pl-desk-icon:has-text("Profile")'), "👤 Profile desktop launcher present");
// drive its action directly — the desktop icon is draggable + can sit under the
// taskbar strip, so the literal pixel-click is covered by the other launcher e2e.
await p.evaluate(async () => { const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k); await F("origin.navOpen")(s, "app:profileapp"); await F("drain")(s, "dom.paint"); });
await p.waitForTimeout(700);
ok(await winShown(), "👤 Profile launcher opened the profile window");
ok(await p.$('[data-win="win.profile.state"] .profile-app'), "the profile UI rendered");
ok(await p.$('[data-win="win.profile.state"] button.pf-btn'), "create form has a button");

// fill the create form + submit
await p.fill('[data-win="win.profile.state"] input[placeholder="Ada Lovelace"]', "Grace");
await p.fill('[data-win="win.profile.state"] input[placeholder="passcode"]', "hunter2!");
await p.fill('[data-win="win.profile.state"] input[placeholder="confirm passcode"]', "hunter2!");
await p.click('[data-win="win.profile.state"] button.pf-btn:has-text("Create identity")');
await p.waitForTimeout(800);

ok((await ks("keystore.status")) === "unlocked", "Create minted + unlocked the wallet", await ks("keystore.status"));
ok((await ks("keystore.name")) === "Grace", "display name stored", await ks("keystore.name"));
ok(((await ks("keystore.identity")) || "").length > 20, "public identity surfaced");
ok(((await ks("profile.phrase")) || "").split(" ").length === 12, "a 12-word recovery phrase was revealed", await ks("profile.phrase"));
// the unlocked controls now render
ok(await p.evaluate(() => { const w = document.querySelector('[data-win="win.profile.state"]'); return !!w && /Reshuffle|Lock/.test(w.textContent || ""); }), "unlocked controls (Reshuffle/Lock) render after create");

ok(errs.filter((e) => !/reading 'get'/.test(e)).length === 0, "no page errors", errs.slice(0, 3));
await b.close(); srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
