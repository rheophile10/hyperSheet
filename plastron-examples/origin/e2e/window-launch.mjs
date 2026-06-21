// e2e: the navpanel launchers (open:/<file>.f → openFile) open worksheet windows
// FLUSH to the viewport (geom(0,0,1,1) → the actual corner — #app has no padding),
// and REOPEN a window the ✕ had closed (openFile uses winsheet.restore, which
// clears the closed flag — not just winsheet.raise).
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
const winBox = (seg) => p.evaluate((s) => { const w = [...document.querySelectorAll(".pl-window")].find((x) => x.getAttribute("data-win") === s); return w ? ((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(w.getBoundingClientRect()) : null; }, seg);

// 1) full-viewport readme is FLUSH — geom(0,0,1,1) → (0,0), no 32px gap.
await (await p.$('button.pl-nav-icon:has-text("Readme")')).click();
await p.waitForTimeout(1000);
const box = await winBox("readme");
ok(box && box.x === 0 && box.y === 0, "readme window is flush to (0,0) — no gap", box);
ok(box && box.w === 1280 && box.h === 800, "readme fills the viewport (1280×800)", box);

// 2) ✕ closes it, then re-clicking the launcher REOPENS it (restore clears `closed`).
await p.click('.pl-window[data-win="readme"] .pl-close-btn');
await p.waitForTimeout(500);
ok((await winBox("readme")) === null, "✕ closed the readme window", await winBox("readme"));
await (await p.$('button.pl-nav-icon:has-text("Readme")')).click();
await p.waitForTimeout(900);
ok((await winBox("readme")) !== null, "re-clicking 📖 Readme REOPENS the closed window", await winBox("readme"));

ok(errs.filter((e) => !/reading 'get'/.test(e)).length === 0, "no page errors", errs.slice(0, 2));
await b.close(); srv.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
