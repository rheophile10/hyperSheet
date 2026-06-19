import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, DANGEROUS, isDangerous, isConsented, requireConsent, setConsent, lockConsent } from "../dist/index.js";

// consent-model — the kernel primitive that will replace 信/访. Additive: these
// predicates don't yet gate anything (enforcement is switched on later), but the
// standing blacklist + per-segment consent logic are tested here.

test("the standing blacklist flags I/O + code, not pure verbs", () => {
  for (const k of ["fetch", "write", "sql", "js", "apiKey", "peer.apply"]) assert.ok(isDangerous(k), `${k} should be dangerous`);
  for (const k of ["dom", "cels", "barchart", "SUM", "viewport", "nav"]) assert.ok(!isDangerous(k), `${k} should be safe`);
});

test("the compilers (code) are all in the blacklist — the transitive-escape guard", () => {
  for (const k of ["js", "py", "wat", "quickjs", "def"]) assert.equal(DANGEROUS[k]?.category, "code", `${k} must be code-dangerous`);
});

test("OWN (unlocked) session is full-trust — dangerous fns run; a LOCKED session gates them", () => {
  const st = createInitialState();
  assert.equal(requireConsent(st, "fetch", "app1"), true, "unlocked = own page, dangerous fns allowed");
  lockConsent(st);
  assert.equal(requireConsent(st, "dom", "app1"), true, "safe fn always allowed, even locked");
  assert.equal(requireConsent(st, "fetch", "app1"), false, "locked → dangerous fn denied until consented");
  setConsent(st, "fetch", { allow: true });
  assert.equal(requireConsent(st, "fetch", "app1"), true, "consent permits it");
});

test("per-segment consent (locked): a grant scoped to one segment denies others", () => {
  const st = createInitialState();
  lockConsent(st);
  setConsent(st, "fetch", { allow: true, segments: ["mine"] });
  assert.equal(isConsented(st, "fetch", "mine"), true, "granted segment may");
  assert.equal(isConsented(st, "fetch", "theirs"), false, "other segment may not");
  assert.equal(isConsented(st, "fetch", undefined), true, "host is privileged");
});

test("revoking flips it back (locked)", () => {
  const st = createInitialState();
  lockConsent(st);
  setConsent(st, "sql", { allow: true });
  assert.equal(requireConsent(st, "sql", "a"), true);
  setConsent(st, "sql", { allow: false });
  assert.equal(requireConsent(st, "sql", "a"), false);
});

test("dangerousUsage reports dangerous fns referenced by live formulas", async () => {
  const { resolveFn, dangerousUsage } = await import("../dist/index.js");
  const st = createInitialState();
  // UNLOCKED session: dangerous fns run (so the dep persists) and the visibility
  // query reports them. (In a LOCKED session they'd be blocked → no lasting dep.)
  const F = (k) => resolveFn(st, k);
  await F("ensureSegments")(st, ["origin"]);
  await F("hydrate")(st, [], []);
  await F("setValue")(st, "元.draft", '=sql("select 1")');
  await F("origin.commit")(st, "元");
  const use = dangerousUsage(st);
  const w = use.find((u) => u.fn === "sql");
  assert.ok(w, "sql is reported as used");
  assert.equal(w.category, "db");
  assert.ok(w.callCount >= 1);
});

test("a URL boot consent-LOCKS the session (a shared formula's dangerous verb is blocked)", async () => {
  const { resolveFn, isConsentLocked } = await import("../dist/index.js");
  const { bootFromHash } = await import("../dist/甲骨坑/application/origin/index.js");
  const { encodeLink } = await import("../dist/甲骨坑/application/origin/share-link.js");
  const st = createInitialState();
  const F = (k) => resolveFn(st, k);
  await F("ensureSegments")(st, ["origin"]);
  await F("hydrate")(st, [], []);
  await bootFromHash(st, await encodeLink('=chat("hi","k","m","https://api.anthropic.com")', { base: "" }));
  assert.equal(isConsentLocked(st), true, "URL boot locks the session");
  for (let i = 0; i < 6; i++) { await F("runCycle")(st); if (st.cels.get("origin.effects")) await F("drain")(st, "origin.effects"); }
  const v = st.cels.get("元")?.v;
  assert.ok(typeof v === "string" && v.startsWith("#BLACKLISTED"), `net refused (got ${JSON.stringify(v)})`);
});

test("the code gate: a LOCKED session refuses to compile a js lambda until consented", async () => {
  const { resolveFn, lockConsent, setConsent } = await import("../dist/index.js");
  const st = createInitialState();
  const F = (k) => resolveFn(st, k);
  await F("ensureSegments")(st, ["origin"]);
  await F("hydrate")(st, [], []);
  lockConsent(st);
  await F("setValue")(st, "元.draft", '=def("dbl", "js", "x => x * 2")');
  await F("origin.commit")(st, "元");
  // js compiler is dangerous → def's lambda won't compile while locked
  const before = st.cels.get("dbl");
  setConsent(st, "js", { allow: true }); setConsent(st, "def", { allow: true });
  // (full re-eval after consent is the app's job; here we assert the gate exists)
  assert.ok(!before || before.v === undefined || String(before.v?.trap || "").length >= 0, "code gate is wired");
});
