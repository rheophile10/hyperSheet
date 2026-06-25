// ============================================================================
// e2e: the encrypted-collaborative CRDT change pipeline — file:// (NO-OPFS) mode.
//
// The offline single-file scenario: a user double-clicks index.html. There's no
// origin, so no persistent storage. We SIMULATE the no-OPFS environment by
// removing navigator.storage.getDirectory before boot (headless chromium happens
// to grant file:// OPFS, which a real double-clicked file does not) — file-store
// then probes backend "none". The desktop degrades (boot.run is caught; 元 stays
// visible) instead of white-screening.
//
// Proves, in real chromium, that with NO storage backend:
//   A. backend is "none" + the app still boots (graceful degradation).
//   B–D. the SAME CRDT pipeline runs entirely in memory — fold, sources-only,
//        writers gate — needing no storage.
//   E. seal/open encryption round-trips in memory.
//   F. the wallet is SESSION-ONLY: a reload loses it (no persistence), and the
//      manual export→import key-file path restores the same identity — the file://
//      substitute for OPFS persistence.
//
//   bun e2e/crdt-pipeline-file.mjs
// ============================================================================
import { chromium } from "playwright";

const bundle = new URL("../dist/index.html", import.meta.url).pathname;
const URLP = "file://" + bundle;

let failed = 0;
const ok = (c, m, g) => { console.log(`${c ? "✓" : "✗"} ${m}${c ? "" : "  got: " + JSON.stringify(g)}`); if (!c) failed++; };

// --allow-file-access-from-files: lets the file:// page boot the bundle. It grants
// local-file READS only — NOT storage — so OPFS stays absent (we also strip the API).
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files"] });

const stripOpfs = (page) => page.addInitScript(() => {
  // simulate a browser/context with no OPFS (a real double-clicked file://).
  try { Object.defineProperty(StorageManager.prototype, "getDirectory", { value: undefined, configurable: true }); } catch (e) {}
  try { Object.defineProperty(Navigator.prototype, "storage", { get: () => undefined, configurable: true }); } catch (e) {}
});

const prep = async (page) => {
  await page.waitForFunction(() => !!globalThis.plastron, { timeout: 12000 });
  await page.waitForTimeout(400);
  return page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    await F("ensureSegments")(s, ["keystore", "crypto", "sheetkeys", "sheetsync", "crdt", "sheets", "file-store"]);
    await F("hydrate")(s, [], []);
    await F("runCycle")(s);
    return { backend: s.cels.get("file-store.backend")?.v, opfsApi: typeof navigator.storage?.getDirectory };
  });
};

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
  await stripOpfs(page);
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).split("\n")[0]));
  page.on("console", (m) => { if (m.type() === "error") { const t = m.text(); if (!/404|Failed to load resource|favicon/.test(t)) errs.push("con:" + t.split("\n")[0]); } });

  await page.goto(URLP);
  const env = await prep(page);
  const bootInfo = await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    const createRes = await F("keystore.create")(s, "file-pass", "Mobile");
    return { createRes, status: s.cels.get("keystore.status")?.v, identity: s.cels.get("keystore.identity")?.v };
  });
  const P = mk(page);

  // ════ A. no storage backend, but the app booted ══════════════════════════
  ok(env.backend === "none", "A. no-OPFS environment → file-store.backend is none", env);
  ok(env.opfsApi === "undefined", "A. navigator.storage.getDirectory is absent", env);
  ok(bootInfo.createRes?.ok === true, "A. keystore.create still mints a wallet (session-only)", bootInfo.createRes);
  ok(bootInfo.createRes?.persisted === false, "A. the wallet is NOT persisted (no storage)", bootInfo.createRes);
  ok(bootInfo.status === "unlocked" && (bootInfo.identity ?? "").length > 0, "A. identity unlocked in memory", bootInfo);

  // ════ B. the LWW pipeline runs entirely in memory ════════════════════════
  const r1 = await P.commit("doc", "doc.A1", "5");
  ok(r1.ok === true && (await P.map("doc"))["doc.A1"]?.val === 5, "B. commit applies with no storage backend", r1);
  ok((await P.cel("doc.A1")) === 5, "B. the edit projected into the source cel (5)", await P.cel("doc.A1"));
  ok(/^[0-9a-f]{64}$/.test(r1.hash ?? ""), "B. a source hash is stamped (in-memory)", r1.hash);
  const r2 = await P.commit("doc", "doc.B1", "=doc.A1*2");
  ok(Object.keys(await P.map("doc")).length === 2 && (await P.cel("doc.B1")) === 10, "B. formula commit derives locally (B1=10)", { cells: Object.keys(await P.map("doc")).length, b1: await P.cel("doc.B1") });
  await P.commit("doc", "doc.A1", "20");
  ok(Object.keys(await P.map("doc")).length === 2 && (await P.cel("doc.B1")) === 40, "B. re-edit re-derives downstream (B1=40)", { cells: Object.keys(await P.map("doc")).length, b1: await P.cel("doc.B1") });

  // ════ C. SOURCES ONLY ════════════════════════════════════════════════════
  const map = await P.map("doc");
  ok(map["doc.B1"]?.kind === "f" && map["doc.B1"]?.val === "=doc.A1*2", "C. the map carries the formula SOURCE text", map["doc.B1"]);
  ok(typeof map["doc.B1"]?.val === "string", "C. the derived value is NOT in the op map", { mapVal: map["doc.B1"]?.val, cellVal: await P.cel("doc.B1") });

  // ════ D. writers GATE ════════════════════════════════════════════════════
  await P.commit("gate", "gate.A1", "1");
  await P.setCel("gate.writers", { celType: "ValueCel", v: ["a-stranger-pubkey"] });
  const gated = await P.commit("gate", "gate.A1", "999");
  ok(gated.ok === false && /writer/i.test(gated.error ?? ""), "D. non-writer commit rejected", gated);
  ok((await P.cel("gate.A1")) === 1, "D. the rejected edit did NOT mutate the cell", await P.cel("gate.A1"));

  // ════ E. encryption round-trips in memory ════════════════════════════════
  const sealed = await P.verb("sheetkeys.sealsheet", "doc");
  ok(sealed.ok === true && !/doc\.A1\*2|"v":\s*20/.test(sealed.blob), "E. sealsheet emits ciphertext (no source leak)", sealed.blob?.slice(0, 60));
  await P.setCel("doc.A1", { celType: "ValueCel", v: 999 });
  const opened = await P.verb("sheetkeys.opensheet", sealed.blob);
  ok(opened.ok === true && (await P.cel("doc.A1")) === 20, "E. opensheet decrypts + restores A1=20", { ok: opened.ok, a1: await P.cel("doc.A1") });

  // ════ F. session-only wallet: reload loses it; export→import restores it ══
  const exported = await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    return F("keystore.export")(s);                          // the portable key-file bytes the user saves
  });
  ok(typeof exported === "string" && exported.length > 100, "F. keystore.export yields a portable encrypted blob", typeof exported);

  await page.reload();                                       // a fresh tab — no OPFS to restore from
  await prep(page);
  const afterReload = await page.evaluate(async () => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    return { had: await F("keystore.has")(s), status: s.cels.get("keystore.status")?.v };
  });
  ok(afterReload.had === false, "F. after reload the wallet is GONE (no persistence without OPFS)", afterReload);

  const reimported = await page.evaluate(async (blob) => {
    const s = globalThis.plastron.state, F = (k) => globalThis.plastron.resolveFn(s, k);
    const wrong = await F("keystore.import")(s, blob, "wrong-pass");
    const right = await F("keystore.import")(s, blob, "file-pass");
    return { wrongOk: wrong.ok, rightOk: right.ok, status: s.cels.get("keystore.status")?.v, identity: s.cels.get("keystore.identity")?.v };
  }, exported);
  ok(reimported.wrongOk === false, "F. importing with a wrong passcode is rejected", reimported);
  ok(reimported.rightOk === true && reimported.status === "unlocked", "F. importing the key file restores the wallet", reimported);
  ok(reimported.identity === bootInfo.identity, "F. the SAME identity is restored from the key file", { before: bootInfo.identity, after: reimported.identity });

  ok(errs.length === 0, `no page errors${errs.length ? ": " + errs[0] : ""}`);
} finally {
  await browser.close();
}
console.log(failed ? `\n✗ ${failed} failed` : "\n✓ all file:// no-OPFS CRDT-pipeline checks passed");
process.exit(failed ? 1 : 0);
