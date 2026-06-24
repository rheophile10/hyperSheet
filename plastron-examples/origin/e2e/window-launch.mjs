// e2e: a desktop DOCUMENT launcher (📖 Readme → doc:readme → origin.opendoc) opens
// the readme as a gen-2 sheetapp workbook window (win.readme.state), and — the key
// behavior — RE-clicking the launcher after ✕ REOPENS the closed window
// (origin.navOpen → restoreWindow clears the `closed` flag + raises, not just raise).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const PORT = 8796, dist = new URL("../dist", import.meta.url).pathname;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; p.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
await p.goto(`http://localhost:${PORT}/index.html`);
await p.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
await p.waitForTimeout(1500);
let pass = 0, fail = 0; const ok = (c, w, g) => { if (c) { pass++; console.log("  ✔", w); } else { fail++; console.log("  ✘", w, "got:", JSON.stringify(g)); } };
const W = "win.readme.state";
const winShown = () => p.evaluate((s) => { const w = [...document.querySelectorAll(".pl-window")].find((x) => x.getAttribute("data-win") === s); return !!w && w.offsetParent !== null; }, W);

// 1) the 📖 Readme launcher opens the readme document as a gen-2 workbook window.
await (await p.$('button.pl-desk-icon:has-text("Readme")')).click();
await p.waitForTimeout(1200);
ok(await winShown(), "📖 Readme opened the readme document window (win.readme.state)");

// 2) ✕ closes it (sets state.closed=1 → the frame hides).
await p.click(`.pl-window[data-win="${W}"] .pl-close-btn`);
await p.waitForTimeout(500);
ok(!(await winShown()), "✕ closed the readme window");

// 3) re-clicking 📖 Readme REOPENS the closed window (restoreWindow clears `closed`).
await (await p.$('button.pl-desk-icon:has-text("Readme")')).click();
await p.waitForTimeout(900);
ok(await winShown(), "re-clicking 📖 Readme REOPENS the closed window");

ok(errs.filter((e) => !/reading 'get'/.test(e)).length === 0, "no page errors", errs.slice(0, 2));
await b.close(); srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
