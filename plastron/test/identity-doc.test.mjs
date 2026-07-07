import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as fs from "node:fs/promises";

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-identity-doc";

const { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter, isCelError } = await import("../dist/index.js");

// ============================================================================
// identity (the 👤 Profile sheetapp document) — identity + sign-in as visible
// cells: B1 the PUBLIC supabase config dict (sb.default derives from it — the
// one definer; chat docs reference it), B2 the =view login (loginpane →
// grok.signin → supabase-auth → tokens into the SESSION STORE behind a
// SecretHandle, never a cel), B3 the =view wallet (profileui over keystore —
// private keys module-scope, never a cel), B4 the non-secret auth-status
// probe other sheets may reference. Opened via origin.opendoc — the verb the
// 👤 Profile desktop icon (doc:identity) dispatches.
// ============================================================================

const doc = JSON.parse(readFileSync(new URL("../../plastron-examples/origin/apps/docs/identity.json", import.meta.url), "utf8"));

// ── the kanban-doc mock-DOM harness + the sheetapp-docs store boot ───────────
const mkEl = (tag) => {
  const L = new Map();
  const el = {
    nodeType: 1, tag, tagName: tag.toUpperCase(), value: undefined, childNodes: [], attrs: {},
    style: { props: {}, setProperty(p, v) { this.props[p] = v; }, removeProperty(p) { delete this.props[p]; } },
    get firstChild() { return this.childNodes[0] ?? null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; },
    setAttribute(n, v) { this.attrs[n] = v; }, removeAttribute(n) { delete this.attrs[n]; },
    appendChild(c) { this.childNodes.push(c); return c; },
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; },
    replaceChild(n, o) { const i = this.childNodes.indexOf(o); if (i >= 0) this.childNodes[i] = n; return o; },
    insertBefore(n, r) { const i = r ? this.childNodes.indexOf(r) : -1; if (i >= 0) this.childNodes.splice(i, 0, n); else this.childNodes.push(n); return n; },
    replaceChildren(...c) { this.childNodes = [...c]; },
    addEventListener(t, fn) { (L.get(t) ?? L.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { L.get(t)?.delete(fn); },
  };
  return el;
};
const mockRaf = () => { const q = []; return { raf: (cb) => q.push(cb), caf: () => {}, run: () => { for (const cb of q.splice(0)) cb(); } }; };

const boot = async (opts = {}) => {
  if (!opts.keepStore) {
    const root = createInitialState().cels.get("file-store.root").v;
    await fs.rm(path.resolve(root, "plastron"), { recursive: true, force: true });
    await fs.rm(path.resolve(root, "keystore"), { recursive: true, force: true });
  }
  const app = mkEl("app");
  globalThis.document = {
    createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }),
    querySelector: (s) => (s === "#app" ? app : null),
    addEventListener() {}, removeEventListener() {},
  };
  const m = mockRaf();
  const state = createInitialState();
  setPainter(state, createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: true, doc: globalThis.document, resolveMount: (x) => (x === "#app" ? app : null) }));
  const r = (k) => resolveFn(state, k);
  await r("ensureSegments")(state, ["origin", "sheets", "window", "origin-lifecycle", "user-space-ops", "segment-store", "opfs-seeding"]);
  await r("hydrate")(state, [], []);
  await precomputeOptional(state);
  await r("runCycle")(state);
  await r("origin.run")(state, "元");
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await r("runCycle")(state);
      if (state.cels.get("genesis.commit")) await r("drain")(state, "genesis.commit");
      if (state.cels.get("origin.effects")) await r("drain")(state, "origin.effects");
    }
    await r("drain")(state, "dom.paint");
    m.run();
  };
  if (!opts.keepStore) await r("origin.install")(state, opts.archive ?? doc);
  await r("origin.opendoc")(state, "identity");
  await settle();
  return { state, r, settle };
};

const vfind = (n, pred, out = []) => { if (n && typeof n === "object") { if (pred(n)) out.push(n); (n.children ?? []).forEach((c) => vfind(c, pred, out)); } return out; };

test("doc:identity opens as a workbook: usercfg kv sheet + derived sb.default + login/wallet views", async () => {
  const { state, r, settle } = await boot();

  assert.ok(state.cels.get("win.identity.state"), "the identity workbook opened");

  // the usercfg segment: the persistent user KV sheet (public config only)
  assert.deepEqual(state.cels.get("usercfg.keys")?.v, ["supabase_url", "supabase_anonkey"], "the kv roster lists the seeded config rows");
  const url = state.cels.get("usercfg.supabase_url")?.v;
  assert.match(String(url), /^https:\/\//, "the supabase url row is seeded");
  // sb.default DERIVES from the kv rows — the chat-app-expected names (url/anonkey)
  assert.deepEqual(state.cels.get("sb.default")?.v, { url, anonkey: state.cels.get("usercfg.supabase_anonkey")?.v },
    "sb.default = {url, anonkey} derived from the usercfg rows (the ONE definer)");

  // the panes (view names sanitize to ASCII: '⚙ config' → config.view, …)
  assert.deepEqual(state.cels.get("identity.B1")?.v, { view: "config", item: true }, "config cell keeps its kvsheet formula, value is the ⧉ token");
  assert.deepEqual(state.cels.get("identity.B2")?.v, { view: "login", item: true }, "login cell keeps its formula, value is the ⧉ token");
  assert.deepEqual(state.cels.get("identity.B3")?.v, { view: "wallet", item: true }, "wallet cell keeps its formula, value is the ⧉ token");
  assert.ok(state.cels.get("config.view"), "config pane exists");
  assert.ok(state.cels.get("login.view"), "login pane exists");
  assert.ok(state.cels.get("wallet.view"), "wallet pane exists");

  // editing a config row cascades into sb.default (the reference IS the dependency)
  await r("setValue")(state, "usercfg.supabase_url", "https://other.example.co");
  await settle();
  assert.equal(state.cels.get("sb.default")?.v?.url, "https://other.example.co", "editing the kv row re-derives sb.default");

  // B4 probes the NON-SECRET auth cel; before any sign-in it is simply empty —
  // never an error, and never a token.
  const probe = state.cels.get("identity.B4");
  assert.ok(probe, "auth-status probe cell exists");
  assert.ok(!isCelError(probe.v), "probe holds no error before first sign-in");
});

test("the ⚙ config view is a kvsheet over usercfg — rows are live refs, the composer adds keys", async () => {
  const { state } = await boot();
  const pane = state.cels.get("config.view")?.v;
  const rows = vfind(pane, (n) => /kv-row/.test(String(n.attrs?.class ?? "")));
  assert.equal(rows.length, 2, "one row per roster name");
  const composer = vfind(pane, (n) => /kv-composer/.test(String(n.attrs?.class ?? "")))[0];
  assert.ok(composer, "the composer row (name + value + ➕) is how new keys are added");
  const add = vfind(composer, (n) => n.tag === "button")[0];
  assert.equal(add.events?.click?.dispatch, "kv.mint", "➕ mints a new usercfg cel");
  assert.equal(add.events?.click?.payload, "usercfg");
});

test("signed out, the login view renders the email/password card wired to grok.signin", async () => {
  const { state } = await boot();
  const pane = state.cels.get("login.view")?.v;
  const inputs = vfind(pane, (n) => n.tag === "input");
  const email = inputs.find((n) => n.events?.input?.payload === "grok.email");
  const password = inputs.find((n) => n.events?.input?.payload === "grok.password");
  assert.ok(email && password, "email + password inputs write the grok draft cels (grok.field)");
  const signin = vfind(pane, (n) => n.tag === "button" && n.events?.click?.dispatch === "grok.signin")[0];
  assert.ok(signin, "the Sign in button dispatches grok.signin");
  assert.equal(signin.events.click.payload, "default", "…for the default project (identity.B1's authority)");
});

test("the wallet view renders profileui over keystore — fresh profile starts at 'none' (create form)", async () => {
  const { state } = await boot();
  const pane = state.cels.get("wallet.view")?.v;
  const app = vfind(pane, (n) => /profile-app/.test(String(n.attrs?.class ?? "")))[0];
  assert.ok(app, "profileui rendered in the wallet pane");
  const create = vfind(pane, (n) => n.tag === "button" && n.events?.click?.dispatch === "profile.create")[0];
  assert.ok(create, "no wallet yet → the Create identity form shows");
  // the wallet's inputs are DRAFT cels (profile.p1/p2/nm) — passcodes flow
  // through module-scope keystore, never into a formula-visible secret.
  const p1 = vfind(pane, (n) => n.tag === "input" && n.events?.input?.set === "profile.p1")[0];
  assert.ok(p1, "passcode input writes the profile.p1 draft");
});

test("refreshApps stomps only the DEFAULTS: user rows survive a force reinstall, new shipped keys merge in", async () => {
  // session 1: open, edit a config row, close (the flush saves the closure)
  const { state: s1, r: r1, settle: settle1 } = await boot();
  await r1("setValue")(s1, "usercfg.supabase_url", "https://mine.example.co");
  await settle1();
  await r1("saveUserSpace")(s1, "identity");

  // ship a NEW build: the defaults grow a `theme` row; force-reinstall the
  // baked archive — exactly what refreshApps does.
  const next = JSON.parse(JSON.stringify(doc));
  const defs = next.segments.find((s) => s.name === "usercfg_defaults");
  defs.cels.find((c) => c.metadata.name === "keys").v.push("theme");
  defs.cels.push({ key: "usercfg_defaults.theme", celType: "ValueCel", metadata: { key: "usercfg_defaults.theme", segment: "usercfg_defaults", name: "theme" }, v: "dark" });
  const out = await r1("origin.install")(s1, next, true);
  assert.match(String(out), /skipped: \[.*usercfg.*\]/, "install:'once' — the force reinstall SKIPPED the user's usercfg");
  assert.match(String(out), /installed: \[.*usercfg_defaults.*\]/, "…while the defaults segment was stomped to the new build");

  // session 2 (same store, fresh state — the reload): reopen the doc
  const { state: s2 } = await boot({ keepStore: true });
  assert.equal(s2.cels.get("usercfg.supabase_url")?.v, "https://mine.example.co", "the USER'S edited row survived the refresh");
  assert.equal(s2.cels.get("usercfg.theme")?.v, "dark", "the NEW shipped default key merged in via =kvseed");
  assert.deepEqual(s2.cels.get("usercfg.keys")?.v, ["supabase_url", "supabase_anonkey", "theme"], "the roster grew by exactly the new key");
  assert.equal(s2.cels.get("sb.default")?.v?.url, "https://mine.example.co", "sb.default derives from the surviving user value");
});
