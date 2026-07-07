// e2e capstone story — "My desktop icons fill the screen top-to-bottom and wrap
// into columns" (card 3c4307ac; story-desktop-icon-wrap). Films the vertical-fill
// icon wrap:
//   - the desktop boots in a SHORT window (1280×520): the icons fill the left edge
//     top-to-bottom and continue in NEW columns to the RIGHT (≥2 distinct left
//     values), and no icon spills below the taskbar;
//   - the window is RESIZED TALLER (1280×900): the icons re-wrap on their own —
//     more per column, so FEWER columns (fewer distinct left values), no refresh;
//   - one icon is DRAGGED and dropped: it stays where it was put (and survives a
//     further resize), while the rest keep their flowed positions;
//   - a launcher is CLICKED (📖 Readme): its window opens, same as always.
// House pattern of desktop-boot.mjs (python http.server + headless chromium).
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8831;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));

let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };

// distinct rounded `left` values across every desktop icon tile = the column count.
const columnLayout = (page) => page.evaluate(() => {
  const tiles = [...document.querySelectorAll("button.pl-desk-icon")];
  const lefts = [...new Set(tiles.map((t) => Math.round(parseFloat(t.style.left))))].sort((a, b) => a - b);
  const tb = document.querySelector(".pl-taskbar");
  const barTop = tb ? tb.getBoundingClientRect().top : Infinity;
  const maxBottom = Math.max(...tiles.map((t) => t.getBoundingClientRect().bottom));
  return { count: tiles.length, columns: lefts, maxBottom, barTop };
});

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  // start SHORT: a viewport too short for one column of 13 icons.
  const page = await browser.newPage({ viewport: { width: 1280, height: 520 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/404|Failed to load resource/.test(t)) errs.push("con:" + t.split("\n")[0]); } });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
  await page.waitForTimeout(1200);

  // ── SHORT window: icons fill top-to-bottom and wrap into columns to the right ──
  const short = await columnLayout(page);
  ok(short.count >= 12, `all desktop icons render (${short.count} tiles)`);
  ok(short.columns.length >= 2, `short window → icons wrap into ≥2 columns (left values: ${short.columns.join(", ")})`);
  ok(short.columns[0] <= 16, `the first column sits at the left edge (x=${short.columns[0]})`);
  ok(short.columns[1] > short.columns[0], `new columns grow RIGHTWARD (col2 x=${short.columns[1]} > col1 x=${short.columns[0]})`);
  ok(short.maxBottom <= short.barTop, `no icon spills below the taskbar (lowest icon bottom ${Math.round(short.maxBottom)} ≤ taskbar top ${Math.round(short.barTop)})`);

  // ── RESIZE TALLER: re-wrap through the graph → fewer columns, no refresh ──────
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(600);
  const tall = await columnLayout(page);
  ok(tall.columns.length < short.columns.length, `taller window re-wraps to FEWER columns on its own (${short.columns.length} → ${tall.columns.length})`);
  ok(tall.maxBottom <= tall.barTop, `still no icon below the taskbar after resize (bottom ${Math.round(tall.maxBottom)} ≤ ${Math.round(tall.barTop)})`);

  // ── DRAG one icon: it stays where dropped ────────────────────────────────────
  const pick = await page.evaluate(() => {
    for (const el of document.querySelectorAll("button.pl-desk-icon")) {
      const r = el.getBoundingClientRect();
      if (r.top < 150) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit.closest(".pl-desk-icon") === el) return { label: el.getAttribute("data-icon"), left: parseFloat(el.style.left), top: parseFloat(el.style.top), cx, cy };
    }
    return null;
  });
  ok(!!pick, `found a hittable icon to drag${pick ? ` (${pick.label})` : ""}`);
  if (pick) {
    const dx = 320, dy = 60;
    await page.mouse.move(pick.cx, pick.cy);
    await page.mouse.down();
    await page.mouse.move(pick.cx + dx, pick.cy + dy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const moved = await page.evaluate((lbl) => {
      const el = document.querySelector(`button.pl-desk-icon[data-icon="${lbl}"]`);
      return { left: parseFloat(el.style.left), top: parseFloat(el.style.top), stored: globalThis.plastron.state.cels.get("desktop.iconpos")?.v?.[lbl] ?? null };
    }, pick.label);
    ok(Math.abs(moved.left - (pick.left + dx)) <= 16 && Math.abs(moved.top - (pick.top + dy)) <= 16, `the dragged icon stays where dropped (${Math.round(moved.left)},${Math.round(moved.top)})`);
    ok(Array.isArray(moved.stored), "the drop persisted its position into desktop.iconpos (survives re-wraps)");

    // it holds its pinned spot across a further resize (persisted position wins).
    await page.setViewportSize({ width: 1280, height: 650 });
    await page.waitForTimeout(500);
    const afterResize = await page.evaluate((lbl) => { const el = document.querySelector(`button.pl-desk-icon[data-icon="${lbl}"]`); return { left: parseFloat(el.style.left), top: parseFloat(el.style.top) }; }, pick.label);
    ok(Math.abs(afterResize.left - moved.left) <= 1 && Math.abs(afterResize.top - moved.top) <= 1, "the pinned icon keeps its dropped position through the next resize");
  }

  // ── CLICK a launcher: its window opens ───────────────────────────────────────
  const readme = await page.$('button.pl-desk-icon:has-text("Readme")');
  ok(!!readme, "the 📖 Readme launcher is present");
  if (readme) {
    await readme.click();
    await page.waitForTimeout(1200);
    ok(await page.evaluate(() => [...document.querySelectorAll(".pl-window[data-win]")].some((w) => /readme/.test(w.getAttribute("data-win")) && w.offsetParent !== null)), "clicking 📖 Readme opened its window (launch still works from a flowed icon)");
  }

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ all desktop-icon-wrap story checks passed");
process.exit(failed ? 1 : 0);
