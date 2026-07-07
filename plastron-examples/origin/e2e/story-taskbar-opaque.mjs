// e2e capstone story — "Minimized apps sit on the taskbar as solid, readable chips"
// (card e8844e9c; story-taskbar-opaque-chips). Films the taskbar-opacity bugfix:
//   - the desktop boots; 📖 Readme opens as a window;
//   - the window is DRAGGED so its body sits behind the bottom taskbar strip
//     (the worst-case backdrop for the old bleed-through) — the bar stays ON TOP
//     (elementFromPoint over the chip hits the bar, not the window);
//   - the window is minimized via the titlebar – button; minimize keeps focus, so
//     its chip is the active+min WORST CASE;
//   - computed styles prove the chip AND the bar are fully opaque: opacity === "1"
//     and background-color alpha === 1 (no rgba(…, <1) / transparent);
//   - clicking the chip restores + raises the window (regression on desktop.taskClick).
// House pattern of desktop-boot.mjs (python http.server + headless chromium).
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8827;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));

let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };
// a computed background-color is opaque iff it is not transparent and, if rgba(), α === 1.
const opaqueBg = (bg) => {
  if (!bg || bg === "transparent") return false;
  const m = bg.match(/rgba?\(([^)]+)\)/i);
  if (!m) return true;                         // named/keyword color that isn't "transparent"
  const parts = m[1].split(",").map((s) => s.trim());
  return parts.length < 4 || Number(parts[3]) === 1;
};

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/404|Failed to load resource/.test(t)) errs.push("con:" + t.split("\n")[0]); } });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
  await page.waitForTimeout(1200);

  ok(await page.evaluate(() => !!document.querySelector(".pl-taskbar")), "the taskbar bar renders");

  // ── open 📖 Readme as a window ─────────────────────────────────────────────
  await page.evaluate(async () => {
    const s = globalThis.plastron.state;
    await globalThis.plastron.resolveFn(s, "origin.navOpen")(s, "doc:readme");
    await globalThis.plastron.resolveFn(s, "drain")(s, "dom.paint");
  });
  await page.waitForTimeout(900);
  const ref = await page.evaluate(() => {
    const w = document.querySelector(".pl-window[data-win]");
    return w ? w.getAttribute("data-win") : null;
  });
  ok(!!ref, `Readme opened a window (ref=${ref})`);

  // raise it so its chip is the active one, then confirm a chip exists for it.
  await page.evaluate(async (r) => {
    const s = globalThis.plastron.state;
    await globalThis.plastron.resolveFn(s, "window.raise")(s, r);
    await globalThis.plastron.resolveFn(s, "drain")(s, "dom.paint");
  }, ref);
  await page.waitForTimeout(300);

  // ── DRAG the window so its body sits behind the bottom taskbar strip ────────
  // Compute a drag that lands the window over the taskbar's left chip, so the
  // window is provably UNDER the chip point (the worst-case backdrop).
  const chipSel = `.pl-task`;
  const geom = await page.evaluate((sel) => {
    const chip = document.querySelector(sel);
    const win = document.querySelector(".pl-window[data-win]:not(.pl-window-min)");
    const tb = win && win.querySelector(".pl-titlebar");
    const cr = chip.getBoundingClientRect(), wr = win.getBoundingClientRect(), tr = tb.getBoundingClientRect();
    return {
      cx: cr.left + cr.width / 2, cy: cr.top + cr.height / 2,
      wx: wr.left, wy: wr.top,
      tcx: tr.left + tr.width / 2, tcy: tr.top + tr.height / 2,
    };
  }, chipSel);
  // desired window top-left: put the titlebar ~80px above the chip and the left
  // edge left of the chip, so the window body covers the chip point.
  const desiredLeft = Math.max(0, geom.cx - 140);
  const desiredTop = Math.max(0, geom.cy - 80);
  const targetX = geom.tcx + (desiredLeft - geom.wx);
  const targetY = geom.tcy + (desiredTop - geom.wy);
  await page.mouse.move(geom.tcx, geom.tcy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(geom.tcx + (targetX - geom.tcx) * i / 8, geom.tcy + (targetY - geom.tcy) * i / 8);
  await page.mouse.up();
  await page.waitForTimeout(400);

  // ── the bar (and its chip) paints ABOVE the window ─────────────────────────
  const zcheck = await page.evaluate((sel) => {
    const chip = document.querySelector(sel);
    const win = document.querySelector(".pl-window[data-win]:not(.pl-window-min)");
    const cr = chip.getBoundingClientRect(), wr = win.getBoundingClientRect();
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    const winCoversChip = cx >= wr.left && cx <= wr.right && cy >= wr.top && cy <= wr.bottom;
    const hit = document.elementFromPoint(cx, cy);
    return {
      winCoversChip,
      hitBar: !!(hit && hit.closest && hit.closest(".pl-taskbar")),
      hitWindow: !!(hit && hit.closest && hit.closest(".pl-window:not(.pl-window-min)")),
    };
  }, chipSel);
  ok(zcheck.winCoversChip, "the dragged window body sits under the taskbar chip point (worst-case backdrop set up)");
  ok(zcheck.hitBar && !zcheck.hitWindow, "the taskbar paints ABOVE the window — the chip point hits the bar, not the window");

  // ── minimize via the titlebar – button (minimize keeps focus → active+min) ──
  await page.locator(`.pl-window[data-win="${ref}"] .pl-min-btn`).click();
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => !!document.querySelector(".pl-task.min"), null), "the window minimized to a dimmed chip");

  // ── computed styles: the min chip AND the bar are fully OPAQUE ──────────────
  const styles = await page.evaluate(() => {
    const chip = document.querySelector(".pl-task.min");
    const bar = document.querySelector(".pl-taskbar");
    const cs = getComputedStyle(chip), bs = getComputedStyle(bar);
    const cr = chip.getBoundingClientRect();
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      chipOpacity: cs.opacity, chipBg: cs.backgroundColor, chipColor: cs.color, chipFontStyle: cs.fontStyle,
      chipIsActive: chip.classList.contains("active"),
      barOpacity: bs.opacity, barBg: bs.backgroundColor, barZ: bs.zIndex,
      hitIsChip: !!(hit && (hit === chip || chip.contains(hit) || (hit.closest && hit.closest(".pl-task") === chip))),
    };
  });
  ok(styles.chipIsActive, "the minimized chip is ALSO active (the worst case — minimize keeps focus)");
  ok(styles.chipOpacity === "1", `minimized chip opacity is 1 (was .55) — got ${styles.chipOpacity}`);
  ok(opaqueBg(styles.chipBg), `minimized chip background is opaque — got ${styles.chipBg}`);
  ok(styles.chipFontStyle === "italic", "minimized chip stays italic (dimming is text-only)");
  ok(styles.barOpacity === "1", `taskbar opacity is 1 — got ${styles.barOpacity}`);
  ok(opaqueBg(styles.barBg), `taskbar background is opaque (was #8881) — got ${styles.barBg}`);
  ok(Number(styles.barZ) >= 100000, `taskbar z-index above the window band — got ${styles.barZ}`);
  ok(styles.hitIsChip, "the minimized chip is hit-testable at its center (bar above everything)");

  // ── clicking the chip restores + raises the window ─────────────────────────
  await page.locator(".pl-task.min").click();
  await page.waitForTimeout(400);
  ok(await page.evaluate((r) => {
    const w = document.querySelector(`.pl-window[data-win="${r}"]:not(.pl-window-min)`);
    return !!w && getComputedStyle(w).display !== "none";
  }, ref), "clicking the chip restores the window (regression on desktop.taskClick)");
  ok(await page.evaluate(() => !document.querySelector(".pl-task.min")), "the restored chip is no longer minimized");

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ all taskbar-opaque story checks passed");
process.exit(failed ? 1 : 0);
