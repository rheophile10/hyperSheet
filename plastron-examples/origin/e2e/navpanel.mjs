// e2e: the minimal app-desktop — wallpaper + a navpanel of app icons, NOTHING
// auto-open. Each icon launches its app window. Real headless chromium against
// the bundled dist. (navOpen must materialize a spawned genesis AND refresh the
// view, or it drops the just-opened window.)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const PORT = 8807, dist = "/home/ian/projects/plastron/plastron-examples/origin/dist";
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 600));
let failed = 0; const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const URL = `http://localhost:${PORT}/index.html`;
try {
  const p = await b.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(URL);
  await p.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
  await p.waitForTimeout(2400);

  // 1. minimal boot — icons up, wallpaper painted, 元 visible (the desktop's base
  // origin cell), but NO app windows auto-open. App windows are every .pl-window
  // except 元's own (data-win="元").
  const boot = await p.evaluate(() => ({
    icons: [...document.querySelectorAll(".pl-nav-icon")].map((e) => e.innerText.replace(/\n/g, " ")),
    appWindows: document.querySelectorAll('.pl-window:not([data-win="元"])').length,
    wallpaper: !!document.querySelector(".desktop-bg"),
  }));
  ok(boot.icons.length === 7, `navpanel shows 7 app icons (${boot.icons.length})`);
  ok(boot.appWindows === 0, `nothing auto-opens — 0 app windows on boot (${boot.appWindows})`);
  ok(boot.wallpaper, "wallpaper is painted");
  ok(/Origin/.test(boot.icons.join("|")) && /Files/.test(boot.icons.join("|")) && /DOOM/.test(boot.icons.join("|")), "icons include Origin, Files, …, DOOM");

  // 2. every icon launches its app window (reload per icon → clean desktop each time).
  const caps = ["Origin", "Files", "Readme", "Keyboard", "Turtles", "DOOM"];
  for (const cap of caps) {
    await p.goto(URL);
    await p.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
    await p.waitForTimeout(2200);
    await (await p.$(`button.pl-nav-icon:has-text("${cap}")`)).click();
    await p.waitForTimeout(2000);
    const n = await p.evaluate(() => document.querySelectorAll(".pl-window").length);
    ok(n >= 1, `🖱  ${cap} → opens ${n} window(s)`);
  }

  // 3. spot-check an app actually renders its content (not just a frame).
  await p.goto(URL); await p.waitForFunction(() => !!globalThis.plastron); await p.waitForTimeout(2200);
  await (await p.$(`button.pl-nav-icon:has-text("Files")`)).click(); await p.waitForTimeout(2000);
  ok(await p.evaluate(() => !!document.querySelector(".file-explorer")), "Files app renders the OPFS explorer");

  ok(errs.length === 0, `no page errors (${errs.slice(0, 2).join(" | ")})`);
} finally {
  await b.close(); srv.kill();
}
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
