// ============================================================================
// e2e: Phase 4 — two browsers converge on one ENCRYPTED sheet over real WebRTC.
//
// Two separate pages = two JS realms = two independent peers (own keyring, own
// module-scope data keys). A real RTCDataChannel carries the traffic (manual
// offer/answer brokered by the test; localhost ICE). Proves, in real chromium:
//   A. handshake — two identities; an RTCDataChannel opens between them.
//   B. key-exchange — A ECDH-wraps the sheet data key to B (sheetsync.share);
//      B unwraps it. The wire carries CIPHERTEXT (op frame is iv.cipher, no
//      plaintext source) — and B can only read because it holds the shared key.
//   C. convergence A→B — A edits; the encrypted op crosses; B DECRYPTS, verifies,
//      gates, folds → same value. A formula syncs as TEXT, derives locally on B.
//   D. convergence B→A — B (a co-writer) edits; A converges. Bidirectional.
//   E. writers GATE across identities — on a sheet where only A is a writer, B
//      receives A's edits (reader) but B's own commit is rejected (not a writer),
//      and nothing reaches A.
//
//   bun e2e/crdt-sync-webrtc.mjs
// ============================================================================
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8931;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const URLP = `http://localhost:${PORT}/index.html`;

let failed = 0;
const ok = (c, m, g) => { console.log(`${c ? "✓" : "✗"} ${m}${c ? "" : "  got: " + JSON.stringify(g)}`); if (!c) failed++; };

// --disable-features=WebRtcHideLocalIpsWithMdns: expose real localhost ICE
// candidates so the two-page data channel actually connects in headless chromium.
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-features=WebRtcHideLocalIpsWithMdns"] });

// run a verb in a page's realm. `withState` verbs take (state, ...args); a few
// (crypto.datakey) don't — pass withState:false for those.
const ev = (page, key, args = [], withState = true) => page.evaluate(([key, args, withState]) => {
  const s = globalThis.plastron.state, fn = globalThis.plastron.resolveFn(s, key);
  return fn(...(withState ? [s, ...args] : args));
}, [key, args, withState]);
const cel = (page, k) => page.evaluate((k) => globalThis.plastron.state.cels.get(k)?.v ?? null, k);
const setCelV = (page, k, v, seg) => page.evaluate(([k, v, seg]) => globalThis.plastron.resolveFn(globalThis.plastron.state, "setCel")(globalThis.plastron.state, k, { celType: "ValueCel", v, metadata: { key: k, segment: seg } }), [k, v, seg]);

const prep = async (page, name) => {
  await page.goto(URLP);
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 12000 });
  await page.waitForTimeout(300);
  return page.evaluate(async (name) => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("ensureSegments")(s, ["sheetsync", "crdt", "keystore", "sheetkeys", "crypto", "sheets", "peer", "file-store"]);
    await F("hydrate")(s, [], []);
    await F("runCycle")(s);
    await F("keystore.create")(s, "pass-" + name, name);
    await F("sheetsync.connect")(s);                    // register inbound routes (op/key/hello)
    return { id: s.cels.get("keystore.identity")?.v, ecdh: s.cels.get("keystore.ecdhpub")?.v };
  }, name);
};

const poll = async (page, key, want, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (JSON.stringify(await cel(page, key)) === JSON.stringify(want)) return true;
    await page.waitForTimeout(150);
  }
  return false;
};

try {
  const A = await browser.newPage();
  const B = await browser.newPage();
  const errs = [];
  for (const [p, who] of [[A, "A"], [B, "B"]]) {
    p.on("pageerror", (e) => errs.push(who + ":" + String(e).split("\n")[0]));
    p.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/404|Failed to load resource|favicon/.test(t)) errs.push(who + "con:" + t.split("\n")[0]); } });
  }

  // ════ A. two identities + an RTCDataChannel between them ═══════════════════
  const a = await prep(A, "Ada");
  const b = await prep(B, "Boris");
  ok(a.id && b.id && a.id !== b.id, "A. two distinct identities", { a: a.id?.slice(0, 8), b: b.id?.slice(0, 8) });

  const offer = await ev(A, "peerOffer", []);
  const answer = await ev(B, "peerAnswer", [offer]);
  await ev(A, "peerAccept", [answer]);
  let opened = false;
  for (let i = 0; i < 30 && !opened; i++) {
    await A.waitForTimeout(300);
    opened = (await A.evaluate(() => globalThis.__peerOpen === true)) && (await B.evaluate(() => globalThis.__peerOpen === true));
  }
  ok(opened, "A. the WebRTC data channel opened on both peers");

  // ════ B. key-exchange — A grants B the sheet key; the wire is ciphertext ═══
  // A owns "doc" with both as writers, then shares (ECDH-wrap key + writers + log).
  await setCelV(A, "doc.writers", [a.id, b.id], "doc");
  const shared = await ev(A, "sheetsync.share", ["doc", b.ecdh]);
  ok(shared.ok === true && shared.frame.t === "key" && !!shared.frame.env, "B. A.share ECDH-wraps the sheet key to B", { ok: shared.ok });
  const bHasKey = await (async () => { for (let i = 0; i < 30; i++) { if (await ev(B, "sheetsync.haskey", ["doc"])) return true; await B.waitForTimeout(150); } return false; })();
  ok(bHasKey, "B. B unwrapped + now holds the sheet data key");
  ok(JSON.stringify(await cel(B, "doc.writers")) === JSON.stringify([a.id, b.id]), "B. B adopted the writers list from the grant", await cel(B, "doc.writers"));

  // ════ C. convergence A→B (encrypted op over the wire) ═════════════════════
  const c1 = await ev(A, "sheetsync.commit", ["doc", "doc.A1", "100"]);
  ok(c1.frame?.t === "op" && /^[^.]+\.[^.]+$/.test(c1.frame.enc) && !JSON.stringify(c1.frame).includes("100"), "C. the op on the wire is an iv.cipher envelope (no plaintext)", c1.frame?.enc?.slice(0, 24));
  ok(await poll(B, "doc.A1", 100), "C. B decrypted + folded A's edit (doc.A1 = 100)", await cel(B, "doc.A1"));
  await ev(A, "sheetsync.commit", ["doc", "doc.B1", "=doc.A1*2"]);
  ok(await poll(B, "doc.B1", 200), "C. a formula synced as TEXT, derived locally on B (B1 = 200)", await cel(B, "doc.B1"));

  // ════ D. convergence B→A (B is a co-writer) ═══════════════════════════════
  const d1 = await ev(B, "sheetsync.commit", ["doc", "doc.A1", "7"]);
  ok(d1.ok === true && d1.frame?.t === "op", "D. B (a writer) commits + emits an op", d1);
  ok(await poll(A, "doc.A1", 7), "D. A converged on B's edit (doc.A1 = 7)", await cel(A, "doc.A1"));
  ok(await poll(A, "doc.B1", 14), "D. A re-derived its formula from B's edit (B1 = 14)", await cel(A, "doc.B1"));

  // ════ E. writers GATE across identities — a reader can't author ═══════════
  // "ro": only A is a writer. A shares it to B; A's edits reach B; B can't commit.
  await setCelV(A, "ro.writers", [a.id], "ro");
  await ev(A, "sheetsync.share", ["ro", b.ecdh]);
  await (async () => { for (let i = 0; i < 30; i++) { if (await ev(B, "sheetsync.haskey", ["ro"])) return; await B.waitForTimeout(150); } })();
  await ev(A, "sheetsync.commit", ["ro", "ro.A1", "55"]);
  ok(await poll(B, "ro.A1", 55), "E. B (reader) receives A's edit on a read-only sheet (ro.A1 = 55)", await cel(B, "ro.A1"));
  const bTry = await ev(B, "sheetsync.commit", ["ro", "ro.A1", "999"]);
  ok(bTry.ok === false && /writer/i.test(bTry.error ?? ""), "E. B's own commit is rejected — not a writer", bTry);
  await A.waitForTimeout(600);
  ok((await cel(A, "ro.A1")) === 55, "E. nothing from B's rejected edit reached A (ro.A1 still 55)", await cel(A, "ro.A1"));

  // ════ F. the LIVE path — an edit via origin.fire (the ⚡ button) ═══════════
  // Not sheetsync.commit directly: drive the SAME handler the formula bar's ⚡
  // dispatches. On a collaborative sheet (doc has writers + a crdt log) origin's
  // commit routes the edit through sheetsync → signs, records a CRDT op, encrypts,
  // and broadcasts. Convergence on B proves the wiring (a plain setCel wouldn't ship).
  const beforeLayers = ((await cel(A, "doc.crdt")) ?? []).length;
  await A.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("setValue")(s, "元.draft", "314");        // type 314 into the formula bar
    await F("origin.fire")(s, "doc.A1");               // press ⚡
  });
  ok(((await cel(A, "doc.crdt")) ?? []).length === beforeLayers + 1, "F. origin.fire recorded a new CRDT op (not a plain setCel)", { before: beforeLayers, after: ((await cel(A, "doc.crdt")) ?? []).length });
  ok(await poll(B, "doc.A1", 314), "F. the ⚡ edit converged to B over WebRTC (doc.A1 = 314)", await cel(B, "doc.A1"));

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs.slice(0, 2).join(" | ") : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ all WebRTC CRDT-sync checks passed");
process.exit(failed ? 1 : 0);
