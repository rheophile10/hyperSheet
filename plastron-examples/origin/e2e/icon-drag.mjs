// e2e: dragging a desktop icon moves it to the cursor — it does NOT teleport to
// the upper-left corner. Regression for the iconGrab offset bug: a never-moved
// icon is absent from desktop.iconpos and is laid out at [16, 12 + i*ICON_H], but
// the grab handler used to assume a phantom [16,16] origin, so the first
// pointermove snapped the tile's top to ~16 (it jumped to the top-left). The fix
// measures the tile's real on-screen rect (it's position:fixed) at grab time.
//
// Drives REAL pointer events (page.mouse → pointerdown/move/up → iconGrab/Move/Drop)
// and asserts the dropped tile tracks the cursor in BOTH axes. The y axis is the
// discriminator: we pick a tile laid out well below the top edge, so the old
// teleport-to-~16 is unmistakable.
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8829;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));

let failed = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) failed++; };

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/404|Failed to load resource/.test(t)) errs.push("con:" + t.split("\n")[0]); } });
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 10000 });
  await page.waitForTimeout(1200);

  ok(await page.evaluate(() => [...document.querySelectorAll("button.pl-desk-icon")].length >= 4), "desktop icons render");

  // pick a tile that (a) has never been moved (absent from desktop.iconpos), (b)
  // is laid out well below the top edge (start.top >> 16, so a teleport is loud),
  // and (c) is actually hittable (not occluded by an open window).
  const pick = await page.evaluate(() => {
    for (const el of document.querySelectorAll("button.pl-desk-icon")) {
      const r = el.getBoundingClientRect();
      if (r.top < 150) continue;                          // want a deep icon
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit.closest(".pl-desk-icon") === el) {
        return { label: el.getAttribute("data-icon"), left: parseFloat(el.style.left), top: parseFloat(el.style.top), cx, cy };
      }
    }
    return null;
  });
  ok(!!pick, `found a hittable, never-moved icon below the fold${pick ? ` (${pick.label} @ ${pick.left},${pick.top})` : ""}`);

  if (pick) {
    ok(await page.evaluate((lbl) => !(lbl in (globalThis.plastron.state.cels.get("desktop.iconpos")?.v ?? {})), pick.label),
      "icon has no stored position (so the drag MUST measure its on-screen rect)");

    const dx = 130, dy = 70;
    await page.mouse.move(pick.cx, pick.cy);
    await page.mouse.down();
    await page.mouse.move(pick.cx + dx, pick.cy + dy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(180);

    const after = await page.evaluate((lbl) => {
      const el = document.querySelector(`button.pl-desk-icon[data-icon="${lbl}"]`);
      const stored = globalThis.plastron.state.cels.get("desktop.iconpos")?.v?.[lbl] ?? null;
      return { left: el ? parseFloat(el.style.left) : null, top: el ? parseFloat(el.style.top) : null, stored };
    }, pick.label);

    const expL = pick.left + dx, expT = pick.top + dy;
    ok(after.left !== null && Math.abs(after.left - expL) <= 14, `icon tracked the cursor in x (${after.left} ≈ ${expL})`);
    ok(after.top !== null && Math.abs(after.top - expT) <= 14, `icon tracked the cursor in y (${after.top} ≈ ${expT})`);
    // the actual regression: the old bug snapped top to ~16 (phantom [16,16] origin)
    ok(after.top !== null && after.top > 100, `icon did NOT teleport to the upper-left (top ${after.top} stayed near the grab point, not ~16)`);
    ok(Array.isArray(after.stored), "drop persisted the new position into desktop.iconpos");
  }

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ all icon-drag checks passed");
process.exit(failed ? 1 : 0);
