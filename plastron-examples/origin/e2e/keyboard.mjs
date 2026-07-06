// e2e: 🎹 Keyboard — the formula-first keyboard document (apps/docs/keyboard.json).
// The accepted shape: the worksheet (LEFT) holds note/freq DATA rows plus ONE
// visible =view("piano", dom(…)) formula (its cell value is the ⧉ token); the
// playable piano keys render in the workbook's RIGHT view pane — NOT inside the
// grid. Pressing a key dispatches origin.tone with the freq CELL's value; editing
// a note cell through the real formula bar re-labels the key reactively.
//
//   bun e2e/keyboard.mjs        (spawns its own dev server on :8895)
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 8895;
const originDir = new URL("..", import.meta.url).pathname;
const srv = spawn("bun", ["serve.ts"], { cwd: originDir, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
for (let i = 0; i < 60; i++) {                       // dev server builds on demand — poll it up
  try { const r = await fetch(`http://localhost:${PORT}/index.html`); if (r.ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome", headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text()); });

let pass = 0, fail = 0, last;
const ok = (c, w) => { c ? pass++ : fail++; console.log(`  ${c ? "✔" : "✘"} ${w}`); if (!c) console.log("      last:", JSON.stringify(last)?.slice(0, 260)); };

// the settle origin.fire runs after a commit — lands request→effect (=view)
// formulas + repaints. Needed after opendoc until sheetapp drains origin.effects
// itself (see the sheetapp.opendoc settle diff in the stream report).
const settle = () => page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  const drain = resolveFn(state, "drain"), runCycle = resolveFn(state, "runCycle");
  for (let i = 0; i < 6; i++) {
    await runCycle(state);
    if (state.cels.get("genesis.commit")) await drain(state, "genesis.commit");
    if (state.cels.get("origin.effects")) await drain(state, "origin.effects");
  }
  await resolveFn(state, "view.refresh")(state);
  await runCycle(state);
  // the rewire's runCycle re-fires the generative cells — land them (the drain's
  // runCascade re-renders the grid with the ⧉ tokens) and paint LAST, with no
  // runCycle in between (a cycle would re-fire the =view cells back to their
  // pending requests) — mirrors origin.fire's post-rewire order.
  if (state.cels.get("origin.effects")) await drain(state, "origin.effects");
  await drain(state, "dom.paint");
});

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });
await page.waitForSelector('button.pl-desk-icon[data-icon="🎹 Keyboard"]', { timeout: 15000 });

// 1) open the doc via the REAL desktop icon (dispatches origin.navOpen "doc:keyboard")
await page.click('button.pl-desk-icon[data-icon="🎹 Keyboard"]');
await page.waitForTimeout(1200);
await settle();
await page.waitForTimeout(300);

last = await page.evaluate(() => globalThis.plastron.state.cels.get("win.keyboard.state")?.v ?? null);
ok(!!last && last.closed !== 1, "the Keyboard workbook opened (win.keyboard.state live)");
ok(last?.sheets?.map((t) => t.title).join(",") === "keyboard", "the note/freq worksheet is the LEFT tab");
ok(last?.views?.map((t) => t.title).join(",") === "piano", "the =view formula contributed the 'piano' VIEW tab on the right");

// 2) the keys render in the RIGHT pane — none inside the grid
last = await page.evaluate(() => ({
  right: document.querySelectorAll(".pl-wb-right #piano button.pl-key").length,
  left: document.querySelectorAll(".pl-wb-left button.pl-key").length,
  labels: Array.from(document.querySelectorAll(".pl-wb-right #piano button.pl-key")).map((b) => b.textContent?.trim()).join(""),
}));
ok(last.right === 7, `seven piano keys render in the RIGHT view pane (${last.right})`);
ok(last.left === 0, "NO key buttons render inside the worksheet grid");
ok(last.labels === "CDEFGAB", `key caps come from the note cells (${last.labels})`);

// 3) the generating cell: ⧉ token in the grid, =view source in the formula bar.
// Nudge the frame first: after the effects drain lands the ⧉ token, the grid
// CONTENT cel re-derives but the mount-headed workbook FRAME suppresses value
// propagation — it re-renders on the next window interaction (a tab click),
// exactly like a user touching the workbook. (Same opendoc settle gap.)
await page.evaluate(() => {
  const tab = Array.from(document.querySelectorAll(".pl-wb-left .pl-wb-tab")).find((b) => b.textContent?.trim() === "keyboard");
  tab?.click();
});
await page.waitForTimeout(400);
last = await page.evaluate(() => document.querySelector('.cell-value[data-key="keyboard.C1"]')?.textContent ?? null);
ok(typeof last === "string" && last.includes("⧉ piano"), `C1 shows the ⧉ token, not the keyboard (${JSON.stringify(last)})`);
await page.click('.cell-value[data-key="keyboard.C1"]');
await page.waitForTimeout(300);
last = await page.evaluate(() => ({
  bar: document.querySelector("textarea.fx-input")?.value ?? "",
  f: globalThis.plastron.state.cels.get("keyboard.C1")?.f ?? "",
}));
ok(last.f.startsWith('=view("piano"'), "C1 keeps its =view source (f starts with =view)");
ok(last.bar.replace(/\s+/g, " ").includes('=view( "piano"') || last.bar.startsWith('=view("piano"'),
  "selecting C1 shows the GENERATING formula in the formula bar");

// 4) pressing a key dispatches origin.tone (no errors — sound is a fire-and-forget effect)
await page.click(".pl-wb-right #piano button.pl-key");
await page.waitForTimeout(400);
ok(errs.length === 0, "pressing a key played without page errors");

// 5) reactivity through the REAL commit path: relabel + retune C via the formula bar
await page.click('.cell-value[data-key="keyboard.A2"]');
await page.waitForTimeout(250);
await page.fill("textarea.fx-input", "Do");
await page.press("textarea.fx-input", "Enter");
await page.waitForTimeout(600);
last = await page.evaluate(() => Array.from(document.querySelectorAll(".pl-wb-right #piano button.pl-key")).map((b) => b.textContent?.trim()).join(""));
ok(last === "DoDEFGAB", `editing the note cell re-labeled the key in the view pane (${last})`);
await page.click('.cell-value[data-key="keyboard.B2"]');
await page.waitForTimeout(250);
await page.fill("textarea.fx-input", "300");
await page.press("textarea.fx-input", "Enter");
await page.waitForTimeout(600);
last = await page.evaluate(() => {
  const slot = globalThis.plastron.state.cels.get("piano.view")?.v?.children?.[0]?.children?.[0];
  const row = slot?.children?.find((c) => c.tag === "div");
  return row?.children?.filter((c) => c.tag === "button")?.[0]?.events?.click?.payload ?? null;
});
ok(last === 300, `editing the freq cell re-tuned the key (origin.tone payload ${JSON.stringify(last)})`);

ok(errs.length === 0, `no page errors (${errs.length ? errs[0]?.slice(0, 200) : "clean"})`);

console.log(`\n${pass} pass, ${fail} fail`);
await browser.close();
srv.kill();
process.exit(fail ? 1 : 0);
