// ============================================================================
// e2e: Phase 4 N-WAY MESH — THREE browsers collaborate on one sheet over a full
// WebRTC mesh (3 pages = 3 realms; 3 pairwise DataChannels), discovered via the
// relay. Grants are INCREMENTAL (A grants B, then later grants C), so this also
// proves writers PROPAGATION: B was never granted alongside C, yet must accept
// C's edits because A's signed `writers` update reaches the whole mesh.
//
//   A goes live → B joins + A grants B → C joins + A grants C (announces writers)
//   then an edit from ANY peer converges on the other two.
//
//   bun e2e/crdt-sync-mesh.mjs
// ============================================================================
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const { startSignalServer } = await import("../../signal-server.ts");

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8951;
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
const poll = async (page, fn, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await page.evaluate(fn)) return true; await page.waitForTimeout(200); } return false; };
const pollCel = async (page, k, want, ms = 12000) => poll(page, `(${(kk) => JSON.stringify(globalThis.plastron.state.cels.get(kk)?.v ?? null)})(${JSON.stringify(k)}) === ${JSON.stringify(JSON.stringify(want))}`, ms);
const peersN = (page, n) => poll(page, `(globalThis.plastron.state.cels.get("sheetsync.peers")?.v ?? []).length >= ${n}`);
const hasKey = (page, seg) => poll(page, `globalThis.plastron.resolveFn(globalThis.plastron.state,"sheetsync.haskey")(globalThis.plastron.state, ${JSON.stringify(seg)}) === true`);
const writerN = (page, seg, n) => poll(page, `((globalThis.plastron.state.cels.get(${JSON.stringify(seg + ".writers")})?.v) ?? []).length >= ${n}`);

const prep = async (page, name) => {
  await page.goto(URLP);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 12000 });
  await page.waitForTimeout(300);
  return page.evaluate(async ([name, RELAY]) => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("ensureSegments")(s, ["sheetapp", "peer", "sheetsync", "keystore", "crypto", "sheetkeys", "crdt", "sheets", "segment-store", "user-space-ops", "opfs-seeding", "window"]);
    await F("hydrate")(s, [], []);
    await F("runCycle")(s);
    await F("keystore.create")(s, "pass-" + name, name);
    await F("setValue")(s, "sheetsync.relay", RELAY);
    await F("origin.newsheet")(s);                       // "sheet1" + its window
    return { id: s.cels.get("keystore.identity")?.v };
  }, [name, RELAY]);
};

try {
  const A = await browser.newPage(), B = await browser.newPage(), C = await browser.newPage();
  const errs = [];
  for (const [p, who] of [[A, "A"], [B, "B"], [C, "C"]]) {
    p.on("pageerror", (e) => errs.push(who + ":" + String(e).split("\n")[0]));
    p.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/404|Failed to load resource|favicon/.test(t)) errs.push(who + "con:" + t.split("\n")[0]); } });
  }

  const a = await prep(A, "Ada"), b = await prep(B, "Boris"), c = await prep(C, "Cleo");
  ok(a.id && b.id && c.id && new Set([a.id, b.id, c.id]).size === 3, "three distinct identities", { a: a.id?.slice(0, 5), b: b.id?.slice(0, 5), c: c.id?.slice(0, 5) });

  const REF = "win.sheet1.state";
  // ── A goes live; B joins; A grants B ──────────────────────────────────────
  await ev(A, "sheetapp.golive", [REF]);
  await A.waitForTimeout(400);
  await ev(B, "sheetapp.golive", [REF]);
  ok(await peersN(A, 1), "A sees B (mesh edge A–B)", await cel(A, "sheetsync.peers"));
  await ev(A, "sheetapp.grant", [REF]);
  ok(await hasKey(B, "sheet1"), "B got the key (grant #1)");
  ok(await writerN(B, "sheet1", 2), "B's writers = {A,B}", await cel(B, "sheet1.writers"));

  // ── C joins; A grants C → writers update propagates to B ──────────────────
  await ev(C, "sheetapp.golive", [REF]);
  ok(await peersN(A, 2), "A sees B + C (mesh edges A–B, A–C)", await cel(A, "sheetsync.peers"));
  ok(await peersN(C, 2), "C sees A + B (mesh edges A–C, B–C)", await cel(C, "sheetsync.peers"));
  await ev(A, "sheetapp.grant", [REF]);
  ok(await hasKey(C, "sheet1"), "C got the key (grant #2)");
  ok(await writerN(C, "sheet1", 3), "C's writers = {A,B,C}", await cel(C, "sheet1.writers"));
  // THE N-WAY POINT: B, never granted alongside C, learns C via the signed writers update
  ok(await writerN(B, "sheet1", 3), "B learned C is a writer (propagated writers update)", await cel(B, "sheet1.writers"));

  // ── an edit from each peer converges on the other two ─────────────────────
  await ev(A, "sheetsync.commit", ["sheet1", "sheet1.A1", "100"]);
  ok((await pollCel(B, "sheet1.A1", 100)) && (await pollCel(C, "sheet1.A1", 100)), "A's edit reached BOTH B and C", { b: await cel(B, "sheet1.A1"), c: await cel(C, "sheet1.A1") });

  // C edits a formula referencing A1 — B must ACCEPT it (B knows C is a writer)
  await ev(C, "sheetsync.commit", ["sheet1", "sheet1.B1", "=sheet1.A1+1"]);
  ok((await pollCel(A, "sheet1.B1", 101)) && (await pollCel(B, "sheet1.B1", 101)), "C's edit reached A and B; formula derived locally (B1=101)", { a: await cel(A, "sheet1.B1"), b: await cel(B, "sheet1.B1") });

  await ev(B, "sheetsync.commit", ["sheet1", "sheet1.C1", "7"]);
  ok((await pollCel(A, "sheet1.C1", 7)) && (await pollCel(C, "sheet1.C1", 7)), "B's edit reached A and C", { a: await cel(A, "sheet1.C1"), c: await cel(C, "sheet1.C1") });

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs.slice(0, 2).join(" | ") : ""}`);
} finally {
  await browser.close();
  relay.stop();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ all N-way mesh checks passed");
process.exit(failed ? 1 : 0);
