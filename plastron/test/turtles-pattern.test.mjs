import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, precomputeOptional, resolveFn,
  createPainter, setPainter, accessPolicyOf, canGet, isDenied,
} from "../dist/index.js";

// ============================================================================
// turtles-pattern — every app is a WINDOW = one or more SHEETS (tabs); each
// window-sheet is a CLOSURE (minted get:["origin"], so only the host view reads
// it — peer formulas can't). A tab/host relationship BUNDLES the segments (the
// one opener of shared memory), so tabbed sheets read each other while separate
// windows stay isolated. The "+" on the tab strip mints a new 10×10 blank sheet
// tabbed into the clicked window.
// ============================================================================

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
const walk = (n, p, o = []) => { if (n?.nodeType === 1) { if (p(n)) o.push(n); for (const c of n.childNodes) walk(c, p, o); } return o; };
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
  await resolveFn(state, "origin.commit")(state, "元"); m.run();
  return { state, root, m };
};

test("each demo sheet is a CLOSURE: minted get:[origin] (host reads, peers don't), set private", async () => {
  const { state } = await boot();
  for (const seg of ["turtles", "turtlecharts"]) {
    const p = accessPolicyOf(state, seg);
    assert.deepEqual(p.get, ["origin"], `${seg} get-list is [origin] — a closure, not public`);
    assert.equal(p.set, "private", `${seg} set is private`);
  }
  // the host view (origin) renders the cells — it reads them
  assert.equal(canGet(state, "origin", "turtles"), true, "the host view reads turtles to render");
});

test("tabbing BUNDLES the segments: turtlecharts reads turtles! and the chart renders", async () => {
  const { state } = await boot();
  // seeded tab: win.geom[turtlecharts].host === turtles → bundled by syncBundles
  assert.equal(state.cels.get("win.geom")?.v?.turtlecharts?.host, "turtles", "turtlecharts tabbed into turtles");
  assert.equal(canGet(state, "turtlecharts", "turtles"), true, "tabbed → bundled → turtlecharts reads turtles");
  const a1 = state.cels.get("turtlecharts.A1")?.v;
  assert.ok(a1 && a1.tag === "canvas", "the chart formula resolved turtles! and produced a canvas (NOT #DENIED)");
  assert.ok(!isDenied(a1), "the chart value is not the #DENIED sentinel");
});

test("an UNRELATED window's formula referencing turtles! resolves to #DENIED", async () => {
  const { state } = await boot();
  await resolveFn(state, "setCel")(state, "win.intruder.probe", {
    celType: "FormulaCel", f: "turtles.A2",
    metadata: { key: "win.intruder.probe", segment: "win.intruder", name: "probe", parser: "f" },
  });
  await resolveFn(state, "runCycle")(state);
  const v = state.cels.get("win.intruder.probe")?.v;
  assert.ok(isDenied(v), `an unrelated window reading turtles! must be #DENIED (got ${JSON.stringify(v)})`);
  assert.notEqual(v, state.cels.get("turtles.A2")?.v, "the turtle data never crosses the closure boundary");
});

test('the "+" newtab handler creates a blank 10×10 sheet TABBED into the clicked window', async () => {
  const { state, m } = await boot();
  // click "+" on the turtles window
  await resolveFn(state, "winsheet.newtab")(state, "turtles"); m.run();
  // a fresh sheet (tab1) of exactly 10×10 cels materialized
  for (const addr of ["tab1.A1", "tab1.J10", "tab1.E5"]) assert.ok(state.cels.get(addr), `${addr} created`);
  assert.equal(state.cels.get("tab1.K1"), undefined, "no 11th column — it's 10 wide");
  assert.equal(state.cels.get("tab1.A11"), undefined, "no 11th row — it's 10 tall");
  const count = [...state.cels.keys()].filter((k) => /^tab1\.[A-J](?:[1-9]|10)$/.test(k)).length;
  assert.equal(count, 100, "exactly 100 cels (10×10)");
  // it's tabbed into turtles' window (NOT a standalone window)
  assert.equal(state.cels.get("win.geom")?.v?.tab1?.host, "turtles", "tab1 hosted by turtles");
});

test("README renders from its data sheet: readme.A1 mounts readmedata.A1 (tabbed pair)", async () => {
  const { state, root } = await boot();
  // the data sheet holds the readme dom; the formula sheet mounts it
  assert.equal(state.cels.get("readmedata.A1")?.v?.tag, "div", "readmedata.A1 holds the readme dom vnode");
  const readmeVal = state.cels.get("readme.A1")?.v;
  assert.equal(readmeVal?.__mount, ".origin", "readme.A1 is a mount of the data sheet's content");
  assert.equal(readmeVal?.vnode?.attrs?.class, "readme", "…mounting the readme div from readmedata");
  // it's tabbed [readmedata | readme] and the readme actually renders in the DOM
  assert.equal(state.cels.get("win.geom")?.v?.readme?.host, "readmedata", "readme tabbed into readmedata");
  assert.equal(canGet(state, "readme", "readmedata"), true, "readme reads its data sheet via the tab bundle");
  assert.ok(walk(root, (n) => String(n.attrs?.class ?? "") === "readme")[0], "the readme rendered (mounted under .origin)");
});

test("Chat renders from the clients sheet: chat.A1 builds the panel from clients.A1/A2 (tabbed pair)", async () => {
  const { state } = await boot();
  // the clients sheet armed the client handles; the chat sheet reads them
  assert.ok(state.cels.get("clients.A1")?.v?.__client, "clients.A1 is a captured claude client handle");
  assert.equal(state.cels.get("chat.A1")?.v?.tag, "div", "chat.A1 built a panel vnode from the clients sheet");
  assert.equal(state.cels.get("win.geom")?.v?.chat?.host, "clients", "chat tabbed into clients");
  assert.equal(canGet(state, "chat", "clients"), true, "chat reads the clients sheet via the tab bundle");
});

test("the chat window composes [clients | chat]: status cells + clientlights + a messages cell, and a bots-left/history/entry/send panel", async () => {
  const { state } = await boot();
  const txt = (n) => (n?.type === "text" ? n.text : (n?.children ?? []).map(txt).join(""));
  const walkV = (n, p, o = []) => { if (n?.type === "el") { if (p(n)) o.push(n); for (const c of n.children ?? []) walkV(c, p, o); } else if (n?.type === "text" && p(n)) o.push(n); return o; };

  // CLIENTS sheet: A1/A2 are status-bearing client handles; grok shows ✗ no key
  // (no xai key set at boot) while claude is also error until a key is set —
  // BOTH are error at boot (no secrets stored). The handles carry a status field.
  const claude = state.cels.get("clients.A1")?.v, grok = state.cels.get("clients.A2")?.v;
  assert.equal(claude?.provider, "claude");
  assert.equal(grok?.provider, "grok");
  assert.ok(["ready", "error"].includes(claude?.status), "claude handle carries a status");
  assert.equal(grok?.status, "error", "grok shows error (no xai key)");
  assert.equal(grok?.error, "✗ no key", "grok's non-secret error reads ✗ no key");

  // B1/B2 are clientlights (dom spans); C1 is the messages list; D1 the entry buffer
  assert.equal(state.cels.get("clients.B1")?.v?.tag, "span", "clients.B1 = a clientlight span for claude");
  assert.equal(state.cels.get("clients.B2")?.v?.tag, "span", "clients.B2 = a clientlight span for grok");
  assert.ok(Array.isArray(state.cels.get("clients.C1")?.v), "clients.C1 is the messages list");
  assert.ok(state.cels.get("clients.D1"), "clients.D1 is the entry buffer cell");

  // CHAT sheet: A1 is the assembled panel — bots LEFT, body = history + entry + send
  const panel = state.cels.get("chat.A1")?.v;
  assert.equal(panel?.tag, "div", "chat.A1 is the chatpanel div");
  assert.ok(walkV(panel, (n) => String(n.attrs?.class ?? "") === "chat-bots")[0], "bots column on the left");
  assert.ok(walkV(panel, (n) => String(n.attrs?.class ?? "") === "chat-history")[0], "a chat history");
  assert.ok(walkV(panel, (n) => n.tag === "input")[0], "a text entry input");
  const send = walkV(panel, (n) => n.tag === "button" && /send/.test(txt(n)))[0];
  assert.ok(send, "a send button");
  // the send button dispatches the spreadsheet-native chat handler
  assert.equal(send.events?.click?.dispatch, "chat.cellsend", "send wired to chat.cellsend");
});

test('the new tab SHARES memory with its host (bundled), but is a closure to others', async () => {
  const { state, m } = await boot();
  await resolveFn(state, "winsheet.newtab")(state, "turtles"); m.run();
  // tab1 is its own closure
  const p = accessPolicyOf(state, "tab1");
  assert.deepEqual(p.get, ["origin"], "the new tab is minted as a closure");
  // tabbed into turtles → bundled with the turtles clique → can read turtles
  assert.equal(canGet(state, "tab1", "turtles"), true, "the new tab shares memory with its host (turtles)");
  assert.equal(canGet(state, "turtles", "tab1"), true, "bundles are symmetric");
  // an unrelated window still cannot read the new tab
  assert.equal(canGet(state, "win.intruder", "tab1"), false, "a separate window is isolated from the new tab");
});
