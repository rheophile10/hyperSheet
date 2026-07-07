// e2e: 📋 Kanban — the sheets-app document (apps/docs/kanban.json; the old
// app:kanbanapp origin-application is retired). The TASKS worksheet is the
// program; two =view formulas grow the panes: the 📋 board (four status
// columns FILTERing the task rows; a card drags via drag.grab naming its OWN
// status cel, a column drop assigns its name) and the ➕ new-task form
// (inputs param.set the H4:H7 draft cells; the button dispatches sheet.addrow
// with the policy payload — H8's =COUNTA next-id + drafts → columns A..E).
// Opens via origin.opendoc — the verb the 📋 Kanban icon (doc:kanban)
// dispatches — then drives the REAL DOM: drags asserted by handler, the form
// filled and submitted through browser events.
//
//   bun e2e/kanban.mjs        (spawns its own dev server on :8963)
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 8963;
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
const cel = (k) => page.evaluate((key) => globalThis.plastron.state.cels.get(key)?.v ?? null, k);

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForFunction(() => !!globalThis.plastron, { timeout: 30000 });

// 1) open via origin.opendoc — what the 📋 Kanban desktop icon (doc:kanban) dispatches
await page.evaluate(async () => { const { state, resolveFn } = globalThis.plastron; await resolveFn(state, "origin.opendoc")(state, "kanban"); });
await page.waitForTimeout(1200);

last = await page.evaluate(() => globalThis.plastron.state.cels.get("win.kanban.state")?.v ?? null);
ok(!!last && last.closed !== 1, "the Kanban workbook opened (win.kanban.state live)");
ok(last?.sheets?.map((t) => t.title).join(",") === "kanban", "the kanban worksheet is the LEFT tab");
const vt = (last?.views ?? []).map((t) => t.title);
ok(vt.length === 2 && /board/.test(vt[0]) && /new task/.test(vt[1]), `H1/H2's =view() grew the board + form panes (${JSON.stringify(vt)})`);

// 2) the board renders in the right pane: four columns, cards match the sheet.
//    The cardBook shows ONE view at a time — select the board tab like a user.
//    Expected counts come FROM THE SHEET (seed-independent — the backlog grows).
await page.click("text=📋 board");
await page.waitForTimeout(400);
const statusCount = (s) => page.evaluate((st) => {
  let n = 0;
  for (const [k, c] of globalThis.plastron.state.cels) if (/^kanban\.C(?!1$)\d+$/.test(k) && c.v === st) n++;
  return n;
}, s);
const seedReview = await statusCount("Review");
last = await page.evaluate(() => {
  const cols = [...document.querySelectorAll(".pl-wb-right #board .kcol")].map((c) => c.getAttribute("data-col"));
  const review = [...document.querySelectorAll('.pl-wb-right #board .kcol[data-col="Review"] .kcard')];
  return { cols, review: review.length, draggable: review[0]?.getAttribute("draggable"), title: review[0]?.querySelector(".ktitle")?.textContent ?? "" };
});
ok(last.cols?.join(",") === "To Do,Doing,Review,Done", `four status columns (${JSON.stringify(last.cols)})`);
ok(last.review === seedReview && seedReview >= 1, `the Review column matches the sheet (${last.review} cards)`);
ok(last.draggable === "true" && /Rebuild kanban/.test(last.title), "cards are draggable, titled from the sheet");

// 3) drag-reassign: drive the card's own handlers (grab names its status cel,
//    the drop column carries the value) — movement is a setValue through the graph
await page.evaluate(async () => {
  const { state, resolveFn } = globalThis.plastron;
  await resolveFn(state, "drag.grab")(state, "kanban.C2");
  await resolveFn(state, "drag.drop")(state, "Done");
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "origin.effects");
  await resolveFn(state, "drain")(state, "dom.paint");
});
await page.waitForTimeout(400);
last = await cel("kanban.C2");
ok(last === "Done", "drop assigned the status cel (kanban.C2 = Done)");
last = await page.evaluate(() => [...document.querySelectorAll('.pl-wb-right #board .kcol[data-col="Done"] .kcard .ktitle')].map((n) => n.textContent));
ok(last.some((t) => /Rebuild kanban/.test(t)), "the card re-rendered into the Done column");

// 4) the ➕ form, through REAL browser events: select the form view tab, type
//    into the inputs (change → param.set), click ➕ (sheet.addrow)
await page.click("text=➕ new task");
await page.waitForTimeout(400);
const formSel = ".pl-wb-right #newtask";
await page.waitForSelector(`${formSel} input`, { timeout: 5000 }).catch(() => {});
last = await page.evaluate((sel) => !!document.querySelector(`${sel} input`), formSel);
ok(last, "the form pane renders inputs");

await page.fill(`${formSel} input >> nth=0`, "Try the board from two peers");
await page.dispatchEvent(`${formSel} input >> nth=0`, "change");
await page.fill(`${formSel} input >> nth=1`, "ian");
await page.dispatchEvent(`${formSel} input >> nth=1`, "change");
await page.waitForTimeout(200);
last = await cel("kanban.H4");
ok(last === "Try the board from two peers", "typing param.set the title draft cell (kanban.H4)");

const nextId = await cel("kanban.H8");                 // the visible id rule, read before the click
const newRow = nextId + 1;                             // id = row − 1
await page.click(`${formSel} button`);
await page.waitForTimeout(600);
last = { a: await cel(`kanban.A${newRow}`), b: await cel(`kanban.B${newRow}`), c: await cel(`kanban.C${newRow}`), d: await cel(`kanban.D${newRow}`), h4: await cel("kanban.H4"), h8: await cel("kanban.H8") };
ok(last.a === nextId && last.b === "Try the board from two peers" && last.c === "To Do" && last.d === "ian", `sheet.addrow appended row ${newRow} (${JSON.stringify(last)})`);
ok(last.h4 === "" && last.h8 === nextId + 1, `title draft cleared; next-id recomputed to ${nextId + 1}`);
await page.click("text=📋 board");
await page.waitForTimeout(400);
last = await page.evaluate(() => [...document.querySelectorAll('.pl-wb-right #board .kcol[data-col="To Do"] .kcard .ktitle')].map((n) => n.textContent));
ok(last.some((t) => /two peers/.test(t)), "the board picked up the new card in To Do");

ok(errs.length === 0, `no page errors (${errs.length ? errs[0] : "clean"})`);
console.log(`\n${fail === 0 ? "✅" : "❌"} kanban e2e: ${pass} passed, ${fail} failed`);
await browser.close();
srv.kill();
process.exit(fail === 0 ? 0 : 1);
