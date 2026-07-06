// e2e: opening the file-explorer shows EXISTING OPFS content immediately — no
// upload or manual nav needed. Regression guard for the bug where explorerwin()
// seeded an empty listing and nothing called explorer.refresh on open, so the
// root looked empty until you uploaded a file.
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 8797;
const dist = "/home/ian/projects/plastron/plastron-examples/origin/dist";
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0, last;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); if (!c) console.log("      last:", JSON.stringify(last)?.slice(0, 200)); };

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
await page.waitForTimeout(300);

const cel = (k) => page.evaluate((key) => globalThis.plastron.state.cels.get(key)?.v, k);

// 1) seed pre-existing OPFS content BEFORE the explorer is ever opened.
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "ensureSegments")(state, ["file-store"]);
  await resolveFn(state, "fs.write")("/preexisting.txt", "i was here before you opened the explorer");
  await resolveFn(state, "fs.mkdir")("/somedir");
});
ok((await cel("file-store.backend")) === "opfs", "OPFS backend live in browser");

// 2) OPEN the explorer via the "=explorerwin()" formula launch path (origin.navOpen
//    formula branch). No upload, no manual nav.
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "origin.navOpen")(state, "=explorerwin()");
});
await page.waitForTimeout(200);

// 3) the listing at the ROOT cwd should already show the pre-existing entries.
last = await cel("explorer.listing");
ok(String(await cel("explorer.cwd")) === "/", "explorer opened at root cwd");
const names = (last?.entries ?? []).map((e) => e.name);
ok(names.includes("preexisting.txt"), `root listing shows the pre-existing file on open (${JSON.stringify(names)})`);
ok((last?.entries ?? []).some((e) => e.name === "somedir" && e.isDir), "root listing shows the pre-existing dir (flagged isDir)");

// 4) and it's in the actual rendered DOM (the window painted the row).
const domHasFile = await page.evaluate(() =>
  !!document.querySelector(".file-explorer") &&
  /preexisting\.txt/.test(document.querySelector(".file-explorer")?.textContent ?? ""));
ok(domHasFile, "the opened explorer window renders the file row in the DOM");

// 5) the ACTUAL desktop "📁 Files" icon dispatches `app:filesapp` (→ origin.launch
//    runs the filesapp entry `=explorerwin()`), NOT the bare formula. That launch
//    path must ALSO populate the listing on open. Blank the listing + reopen via
//    the real icon action and assert it re-reads OPFS (regression for the icon path).
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "setValue")(state, "explorer.listing", { entries: [], previewText: "" });
  await resolveFn(state, "setValue")(state, "explorer.cwd", "/");
  await resolveFn(state, "origin.navOpen")(state, "app:filesapp");
});
await page.waitForTimeout(250);
last = await cel("explorer.listing");
const iconNames = (last?.entries ?? []).map((e) => e.name);
ok(iconNames.includes("preexisting.txt"), `app:filesapp icon launch ALSO populates the listing (${JSON.stringify(iconNames)})`);

ok(errs.length === 0, `no console/page errors${errs.length ? ": " + errs.slice(0, 2).join(" | ") : ""}`);

console.log(`\n${fail ? "✘" : "✔"} explorer-open: ${pass} pass, ${fail} fail`);
await browser.close(); srv.kill();
process.exit(fail ? 1 : 0);
