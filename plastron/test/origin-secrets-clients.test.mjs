import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, precomputeOptional, resolveFn,
  createPainter, setPainter, accessPolicyOf, canGet,
} from "../dist/index.js";

// ============================================================================
// origin window-set restructure (turtles pattern): the boot composes each app as
// SHEETS — a SECRETS sheet (vault), a CLIENTS sheet, and a CHAT sheet tabbed with
// clients — and NO wallet window. The clients sheet keeps its READ-ONLY link to
// the sealed `secrets` segment (apiKey gating), and a non-clients window's read of
// secrets.* is #DENIED. The chat reads clients! via the tab bundle but never the
// sealed secrets (the seal holds — bundling can't open it).
// ============================================================================

const mkEl = (tag) => {
  const el = {
    nodeType: 1, tag, tagName: tag.toUpperCase(), childNodes: [], attrs: {},
    style: { props: {}, setProperty(p, v) { this.props[p] = v; }, removeProperty(p) { delete this.props[p]; } },
    get firstChild() { return this.childNodes[0] ?? null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; },
    setAttribute(n, v) { this.attrs[n] = v; }, removeAttribute(n) { delete this.attrs[n]; },
    appendChild(c) { this.childNodes.push(c); return c; },
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; },
    replaceChild(n, o) { const i = this.childNodes.indexOf(o); if (i >= 0) this.childNodes[i] = n; return o; },
    insertBefore(n, r) { const i = r ? this.childNodes.indexOf(r) : -1; if (i >= 0) this.childNodes.splice(i, 0, n); else this.childNodes.push(n); return n; },
    replaceChildren(...c) { this.childNodes = [...c]; },
    addEventListener() {}, removeEventListener() {},
  };
  return el;
};
const mockRaf = () => { const q = []; return { raf: (cb) => q.push(cb), caf: () => {}, run: () => { for (const cb of q.splice(0)) cb(); } }; };

const boot = async () => {
  const root = mkEl("app");
  globalThis.document = {
    createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }),
    querySelector: (s) => (s === "#app" ? root : null),
    addEventListener() {}, removeEventListener() {},
  };
  const m = mockRaf();
  const state = createInitialState();
  setPainter(state, createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: true, doc: globalThis.document, resolveMount: (x) => (x === "#app" ? root : null) }));
  await resolveFn(state, "ensureSegments")(state, ["origin"]);
  await resolveFn(state, "hydrate")(state, [], []);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "drain")(state, "dom.paint");
  m.run();
  // materialize the boot desktop genesis (the segment(...) batch)
  await resolveFn(state, "origin.commit")(state, "元"); m.run();
  return { state, root, m };
};

test("boot composes a Secrets sheet + a Clients sheet + a Chat sheet and NO wallet window", async () => {
  const { state } = await boot();

  // each app is a SHEET (the turtles pattern): a one-cell vault (secrets panel),
  // a clients sheet (client handles), a chat sheet (the clients/chat panel).
  assert.ok(state.cels.get("vault.A1"), "a Secrets sheet (vault) exists");
  assert.ok(state.cels.get("clients.A1"), "a Clients sheet exists (clients.A1 = claude handle)");
  assert.ok(state.cels.get("clients.A2"), "clients.A2 = grok handle");
  assert.ok(state.cels.get("chat.A1"), "a Chat sheet exists");
  // NO state-cel wallet/secrets windows
  assert.equal(state.cels.get("win.wallet.state"), undefined, "NO wallet window");
  assert.equal(state.cels.get("win.secrets.state"), undefined, "secrets is a sheet, not a state-cel window");

  // chat is tabbed with clients (one window: [clients | chat])
  assert.equal(state.cels.get("win.geom")?.v?.chat?.host, "clients", "chat tabbed into clients");
});

test("the clients sheet is a closure; chat reads it via the tab bundle; secrets stays sealed", async () => {
  const { state } = await boot();
  // the clients sheet is minted as a closure (host-readable only), set private
  const policy = accessPolicyOf(state, "clients");
  assert.deepEqual(policy.get, ["origin"], "clients sheet is a closure (host view reads to render)");
  assert.equal(policy.set, "private", "clients set is private");
  // tabbing chat into clients bundled them, so the chat sheet reads clients!
  assert.equal(canGet(state, "chat", "clients"), true, "chat reads clients! via the tab bundle");
  // a SEPARATE window cannot read the clients sheet
  assert.equal(canGet(state, "win.intruder", "clients"), false, "an unrelated window is denied the clients sheet");
});

test("the clients sheet reads sealed secrets (apiKey); a non-clients window's read of secrets.* is #DENIED", async () => {
  const { state } = await boot();
  const setCel = resolveFn(state, "setCel");
  const cycle = resolveFn(state, "runCycle");
  const call = (k, ...a) => resolveFn(state, k)(state, ...a);

  // bring up + unlock the wallet, store a secret (mirrors wallet-secrets-gate.test)
  await resolveFn(state, "ensureSegments")(state, ["unsafe-wallet"]);
  await call("wallet.unlock", null, { type: "change", target: { value: "hunter2" } });
  await call("wallet.set", "anthropic", { type: "change", target: { value: "sk-ant-TOPSECRET" } });

  // the secrets segment is sealed: get whitelist is [clients], getSealed.
  const secretsPolicy = accessPolicyOf(state, "secrets");
  assert.deepEqual(secretsPolicy.get, ["clients"], "secrets readable ONLY by the clients sheet");
  assert.equal(secretsPolicy.getSealed, true, "secrets get is sealed");

  // a FORMULA in the CLIENTS sheet (segment "clients") reading secrets via apiKey
  // → allowed (the clients sheet is the whitelisted reader). clients.A1 already
  // does exactly this at boot: =makeclient("claude", apiKey("anthropic")).
  await cycle(state);
  const handle = state.cels.get("clients.A1")?.v;
  assert.ok(handle && typeof handle === "object" && handle.__client === true,
    "the clients sheet armed a client handle (it read the sealed key via apiKey)");

  // a FORMULA in a NON-clients window reading secrets.anthropic → #DENIED (seal holds)
  await setCel(state, "win.intruder.probeSecret", {
    celType: "FormulaCel", f: "secrets.anthropic",
    metadata: { key: "win.intruder.probeSecret", segment: "win.intruder", name: "probeSecret", parser: "f" },
  });
  await cycle(state);
  const gotSecret = state.cels.get("win.intruder.probeSecret")?.v;
  assert.ok(gotSecret && typeof gotSecret === "object" && gotSecret["#DENIED"] === true,
    "a non-clients window's read of sealed secrets.* is #DENIED");
  assert.notEqual(gotSecret, "sk-ant-TOPSECRET", "the secret never reaches an outside window");

  await call("wallet.del", "anthropic");
  await resolveFn(state, "wallet.lock")(state);
});
