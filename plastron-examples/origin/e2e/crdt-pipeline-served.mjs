// ============================================================================
// e2e: the encrypted-collaborative CRDT change pipeline — SERVED (OPFS) mode.
//
// Served over http (real origin) so OPFS is live (file-store.backend === "opfs").
// One user, single page. Proves end to end, in real chromium:
//   A. identity — keystore.create mints a wallet; status flips to "unlocked".
//   B. CRDT pipeline — sheetsync.commit runs an edit through
//      gate→diff→crdt.layer→sign→verify→gate→crdt.append→fold→runCycle. The
//      op-log GROWS, the fold lands in the source cel, a formula DERIVES locally,
//      and the source hash advances.
//   C. SOURCES ONLY — the op-log carries a formula's TEXT, never its derived value.
//   D. writers GATE — a non-writer's commit is rejected and does NOT mutate.
//   E. encryption — sheetkeys.sealsheet emits ciphertext (no source leak);
//      opensheet decrypts + restores after the live cels are clobbered.
//   F. OPFS persistence — the sealed keystore survives a full reload; a second
//      page UNLOCKS it with the passcode (encryption-at-rest across sessions).
//
//   bun e2e/crdt-pipeline-served.mjs
// ============================================================================
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const dist = new URL("../dist", import.meta.url).pathname;
const PORT = 8911;
const srv = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dist], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const URLP = `http://localhost:${PORT}/index.html`;

let failed = 0;
const ok = (c, m, g) => { console.log(`${c ? "✓" : "✗"} ${m}${c ? "" : "  got: " + JSON.stringify(g)}`); if (!c) failed++; };

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
// ONE context — so OPFS storage is shared across the reload in F. (Playwright's
// browser.newPage() makes a fresh context each call → separate storage; a real
// "reload the tab" is page.reload() inside a single context.)

// bring up the crypto/CRDT stack on whatever page just loaded (boot OR reload).
const prep = async (page) => {
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 12000 });
  await page.waitForTimeout(400);
  return page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("ensureSegments")(s, ["keystore", "crypto", "sheetkeys", "sheetsync", "crdt", "sheets", "file-store"]);
    await F("hydrate")(s, [], []);
    await F("runCycle")(s);
    return s.cels.get("file-store.backend")?.v;
  });
};

// page helpers (run a single verb in the page realm)
const mk = (page) => ({
  commit: (seg, key, src) => page.evaluate(([seg, key, src]) => globalThis.plastron.resolveFn(globalThis.plastron.state, "sheetsync.commit")(globalThis.plastron.state, seg, key, src), [seg, key, src]),
  cel: (k) => page.evaluate((k) => globalThis.plastron.state.cels.get(k)?.v ?? null, k),
  celType: (k) => page.evaluate((k) => globalThis.plastron.state.cels.get(k)?.celType ?? null, k),
  map: (seg) => page.evaluate((seg) => globalThis.plastron.state.cels.get(`${seg}.crdt`)?.v ?? {}, seg),
  verb: (k, ...a) => page.evaluate(([k, a]) => globalThis.plastron.resolveFn(globalThis.plastron.state, k)(globalThis.plastron.state, ...a), [k, a]),
  setCel: (k, spec) => page.evaluate(([k, spec]) => globalThis.plastron.resolveFn(globalThis.plastron.state, "setCel")(globalThis.plastron.state, k, { metadata: { key: k, segment: k.split(".")[0] }, ...spec }), [k, spec]),
});

try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/404|Failed to load resource|favicon/.test(t)) errs.push("con:" + t.split("\n")[0]); } });

  await page.goto(URLP);
  const backend = await prep(page);
  const bootInfo = await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    const createRes = await F("keystore.create")(s, "e2e-served-pass", "Editor");
    return { createRes, status: s.cels.get("keystore.status")?.v, identity: s.cels.get("keystore.identity")?.v };
  });
  const P = mk(page);

  // ════ A. served origin has OPFS + an unlocked identity ════════════════════
  ok(backend === "opfs", "A. served origin → file-store.backend is opfs", { backend });
  ok(bootInfo.createRes?.ok === true, "A. keystore.create mints a wallet", bootInfo.createRes);
  ok(bootInfo.status === "unlocked" && typeof bootInfo.identity === "string" && bootInfo.identity.length > 0, "A. identity unlocked (Ed25519 public present)", bootInfo);

  // ════ B. the LWW pipeline: edit → projects → map records a winner → hash ════
  const r1 = await P.commit("doc", "doc.A1", "5");
  ok(r1.ok === true && (await P.map("doc"))["doc.A1"]?.val === 5, "B. first commit: ok, map records doc.A1=5", r1);
  ok((await P.cel("doc.A1")) === 5, "B. the edit projected into the source cel (5)", await P.cel("doc.A1"));
  ok(/^[0-9a-f]{64}$/.test(r1.hash ?? ""), "B. a 64-hex source hash is stamped", r1.hash);

  const r2 = await P.commit("doc", "doc.B1", "=doc.A1*2");
  ok(r2.ok === true && Object.keys(await P.map("doc")).length === 2, "B. formula commit: map now has 2 cells", r2);
  ok((await P.celType("doc.B1")) === "FormulaCel" && (await P.cel("doc.B1")) === 10, "B. formula restored + derived locally (B1=10)", { t: await P.celType("doc.B1"), v: await P.cel("doc.B1") });

  const r3 = await P.commit("doc", "doc.A1", "20");
  ok(Object.keys(await P.map("doc")).length === 2 && (await P.cel("doc.A1")) === 20, "B. re-edit A1=20: in-place (still 2 cells), latest wins", r3);
  ok((await P.cel("doc.B1")) === 40, "B. downstream formula RE-derived locally (B1=40)", await P.cel("doc.B1"));
  ok(r3.hash !== r1.hash, "B. the source hash advanced with the change", { a: r1.hash, b: r3.hash });

  // ════ C. SOURCES ONLY — the map holds formula TEXT, never derived values ════
  const map = await P.map("doc");
  ok(map["doc.B1"]?.kind === "f" && map["doc.B1"]?.val === "=doc.A1*2", "C. the map carries the formula SOURCE text", map["doc.B1"]);
  ok(typeof map["doc.B1"]?.val === "string", "C. B1's map value is the TEXT, not the derived 40 (which lives only in the cell)", { mapVal: map["doc.B1"]?.val, cellVal: await P.cel("doc.B1") });

  // ════ D. writers GATE — restrict a fresh seg to a stranger, my commit drops ═
  await P.commit("gate", "gate.A1", "1");                                  // creates gate (me = open writer)
  await P.setCel("gate.writers", { celType: "ValueCel", v: ["a-stranger-pubkey"] });
  const gated = await P.commit("gate", "gate.A1", "999");
  ok(gated.ok === false && /writer/i.test(gated.error ?? ""), "D. non-writer commit rejected", gated);
  ok((await P.cel("gate.A1")) === 1, "D. the rejected edit did NOT mutate the cell (still 1)", await P.cel("gate.A1"));

  // ════ E. encryption — seal emits ciphertext; open restores after a clobber ═
  const sealed = await P.verb("sheetkeys.sealsheet", "doc");
  ok(sealed.ok === true, "E. sealsheet ok", sealed.ok);
  ok(typeof sealed.blob === "string" && !/doc\.A1\*2|"v":\s*20/.test(sealed.blob), "E. the sealed blob is ciphertext — no source/value leak", sealed.blob?.slice(0, 80));
  const blobMeta = JSON.parse(sealed.blob);
  ok(blobMeta.seg === "doc" && /^[0-9a-f]{64}$/.test(blobMeta.hash ?? ""), "E. blob carries seg + a source hash", { seg: blobMeta.seg, hash: blobMeta.hash });
  await P.setCel("doc.A1", { celType: "ValueCel", v: 999 });               // clobber the live source
  const opened = await P.verb("sheetkeys.opensheet", sealed.blob);
  ok(opened.ok === true && opened.seg === "doc", "E. opensheet decrypts + restores", opened);
  ok((await P.cel("doc.A1")) === 20, "E. value source restored from ciphertext (A1 back to 20)", await P.cel("doc.A1"));
  ok((await P.celType("doc.B1")) === "FormulaCel", "E. formula source restored", await P.celType("doc.B1"));

  // ════ F. OPFS persistence — RELOAD the tab: the sealed keystore survives ════
  // page.reload() destroys the JS realm (module-scope KEYRING resets to null), so
  // a successful unlock proves the wallet was read back from OPFS, not memory.
  await page.reload();
  await prep(page);
  const reload = await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    const statusAtBoot = s.cels.get("keystore.status")?.v;       // should be "locked" (persisted, not yet unlocked)
    const had = await F("keystore.has")(s);
    const wrong = await F("keystore.unlock")(s, "not-the-passcode");
    const right = await F("keystore.unlock")(s, "e2e-served-pass");
    return { statusAtBoot, had, wrongOk: wrong.ok, rightOk: right.ok, status: s.cels.get("keystore.status")?.v, identity: s.cels.get("keystore.identity")?.v };
  });
  ok(reload.had === true, "F. after reload, OPFS still holds the sealed keystore", reload);
  ok(reload.wrongOk === false, "F. a wrong passcode is rejected (encryption-at-rest)", reload);
  ok(reload.rightOk === true && reload.status === "unlocked", "F. the right passcode unlocks the persisted wallet", reload);
  ok(reload.identity === bootInfo.identity, "F. the SAME identity is restored across the reload", { before: bootInfo.identity, after: reload.identity });

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
  srv.kill();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ all served-OPFS CRDT-pipeline checks passed");
process.exit(failed ? 1 : 0);
