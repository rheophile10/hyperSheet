// ============================================================================
// e2e: Phase 4 UX — two users collaborate via the SHEETAPP UI (📡 Go Live / 🤝
// Grant) over a signaling relay, no SDP copy-paste, no direct verb plumbing.
//
// Both pages open a fresh sheet (origin.newsheet → "sheet1"), press 📡 Go Live
// (join room "plastron-sheet1" via the relay + register sync routes), one presses
// 🤝 Grant (add the peer to writers + ECDH-share the sheet key). Then a normal
// ⚡ edit on one converges on the other. Proves the buttons render, presence is
// tracked reactively (peer.connected / sheetsync.peers), and the live path works.
//
//   bun e2e/crdt-sync-ui.mjs
// ============================================================================
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const { startSignalServer } = await import("../../signal-server.ts");

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8941;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const relay = startSignalServer(0);
const RELAY = `ws://localhost:${relay.port}`;
const URLP = `http://localhost:${PORT}/index.html`;

let failed = 0;
const ok = (c, m, g) => { console.log(`${c ? "✓" : "✗"} ${m}${c ? "" : "  got: " + JSON.stringify(g)}`); if (!c) failed++; };

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-features=WebRtcHideLocalIpsWithMdns"] });

const ev = (page, key, args = []) => page.evaluate(([key, args]) => { const s = globalThis.plastron.state; return globalThis.plastron.resolveFn(s, key)(s, ...args); }, [key, args]);
const cel = (page, k) => page.evaluate((k) => globalThis.plastron.state.cels.get(k)?.v ?? null, k);
const poll = async (page, fn, ms = 9000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn)) return true; await page.waitForTimeout(150); } return false; };
const pollCel = async (page, k, want, ms = 9000) => poll(page, `(${(kk) => JSON.stringify(globalThis.plastron.state.cels.get(kk)?.v ?? null)})(${JSON.stringify(k)}) === ${JSON.stringify(JSON.stringify(want))}`, ms);

const prep = async (page, name) => {
  await page.goto(URLP);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 12000 });
  await page.waitForTimeout(400);
  return page.evaluate(async ([name, RELAY]) => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("ensureSegments")(s, ["sheetapp", "peer", "sheetsync", "keystore", "crypto", "sheetkeys", "crdt", "sheets", "segment-store", "user-space-ops", "opfs-seeding", "window"]);
    await F("hydrate")(s, [], []);
    await F("runCycle")(s);
    await F("keystore.create")(s, "pass-" + name, name);
    await F("setValue")(s, "sheetsync.relay", RELAY);
    await F("origin.newsheet")(s);                       // creates "sheet1" + its workbook window
    return { id: s.cels.get("keystore.identity")?.v, ecdh: s.cels.get("keystore.ecdhpub")?.v, hasWin: !!s.cels.get("win.sheet1.state") };
  }, [name, RELAY]);
};

try {
  const A = await browser.newPage();
  const B = await browser.newPage();
  const errs = [];
  for (const [p, who] of [[A, "A"], [B, "B"]]) {
    p.on("pageerror", (e) => errs.push(who + ":" + String(e).split("\n")[0]));
    p.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/404|Failed to load resource|favicon/.test(t)) errs.push(who + "con:" + t.split("\n")[0]); } });
  }

  const a = await prep(A, "Ada");
  const b = await prep(B, "Boris");
  ok(a.hasWin && b.hasWin, "both opened a sheet1 workbook window", { a: a.hasWin, b: b.hasWin });
  ok(a.id && b.id && a.id !== b.id, "two distinct identities", { a: a.id?.slice(0, 6), b: b.id?.slice(0, 6) });

  // the 📡 / 🤝 toolbar buttons render in the workbook chrome
  const toolsA = await A.evaluate(() => (globalThis.plastron.state.cels.get("win.sheet1.state")?.v?.tools ?? []).map((t) => t.icon));
  ok(toolsA.includes("📡") && toolsA.includes("🤝"), "📡 Go Live + 🤝 Grant buttons are in the toolbar", toolsA);

  // ════ 📡 Go Live on both — they meet in room "plastron-sheet1" via the relay ═
  await ev(A, "sheetapp.golive", ["win.sheet1.state"]);
  await A.waitForTimeout(400);
  await ev(B, "sheetapp.golive", ["win.sheet1.state"]);
  ok(await pollCel(A, "sheetsync.room", "plastron-sheet1"), "A joined room plastron-sheet1", await cel(A, "sheetsync.room"));
  const connected = (await poll(A, () => globalThis.plastron.state.cels.get("peer.connected")?.v === true)) && (await poll(B, () => globalThis.plastron.state.cels.get("peer.connected")?.v === true));
  ok(connected, "peer.connected is reactively true on both (the data channel opened)");

  // presence: each sees the other via hello (the open-hook re-announces on connect)
  ok(await poll(A, () => (globalThis.plastron.state.cels.get("sheetsync.peers")?.v ?? []).length >= 1), "A sees B in sheetsync.peers (reactive presence)", await cel(A, "sheetsync.peers"));
  ok(await poll(B, () => (globalThis.plastron.state.cels.get("sheetsync.peers")?.v ?? []).length >= 1), "B sees A in sheetsync.peers");

  // ════ 🤝 Grant — A gives B the key + write access ═════════════════════════
  await ev(A, "sheetapp.grant", ["win.sheet1.state"]);
  ok(await poll(B, () => globalThis.plastron.resolveFn(globalThis.plastron.state, "sheetsync.haskey")(globalThis.plastron.state, "sheet1") === true), "B received the sheet key (🤝 grant)");
  ok(await poll(B, () => { const w = globalThis.plastron.state.cels.get("sheet1.writers")?.v ?? []; return Array.isArray(w) && w.length >= 2; }), "B adopted the writers list (both are writers)", await cel(B, "sheet1.writers"));

  // ════ a normal ⚡ edit on A converges on B ════════════════════════════════
  await A.evaluate(async () => { const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k); await F("setValue")(s, "元.draft", "123"); await F("origin.fire")(s, "sheet1.A1"); });
  ok(await pollCel(B, "sheet1.A1", 123), "A's ⚡ edit converged on B (sheet1.A1 = 123)", await cel(B, "sheet1.A1"));

  // and B (now a writer) edits back → A converges
  await B.evaluate(async () => { const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k); await F("setValue")(s, "元.draft", "=sheet1.A1+1"); await F("origin.fire")(s, "sheet1.B1"); });
  ok(await pollCel(A, "sheet1.B1", 124), "B's ⚡ edit converged on A (sheet1.B1 = 124)", await cel(A, "sheet1.B1"));

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs.slice(0, 2).join(" | ") : ""}`);
} finally {
  await browser.close();
  relay.stop();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ all Phase 4 UX (Go Live / Grant) checks passed");
process.exit(failed ? 1 : 0);
