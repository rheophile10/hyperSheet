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

// the readme renders nested dom vnodes (cards have children); a value-level
// walker over the {type:el} vnode tree finds a node matching a predicate.
const walkV = (n, p, o = []) => { if (n?.type === "el") { if (p(n)) o.push(n); for (const c of n.children ?? []) walkV(c, p, o); } else if (n?.type === "text" && p(n)) o.push(n); return o; };
const vtext = (n) => (n?.type === "text" ? (n.text ?? "") : (n?.children ?? []).map(vtext).join(""));

test("README is a TALL sheet that flows down column A: row 1 is the header (index.html + ⚡/W legend); each example is a description cell with its code cell directly BELOW it", async () => {
  const { state, root } = await boot();
  // the readme flows down column A: A1 is the header card; then every example
  // is TWO stacked A cells — a description (even rows: A2, A4, …) then the code
  // card directly below it (odd rows: A3, A5, …). The code card carries the ⚡,
  // which targets its OWN row's B cell. No side column C anymore.
  const a1 = state.cels.get("readme.A1")?.v;
  assert.equal(a1?.tag, "div", "readme.A1 holds a dom vnode (the header card)");
  assert.equal(a1?.attrs?.class, "readme", "…a .readme card");
  // the header explains the product + the controls
  assert.match(vtext(a1), /ONE index\.html/, "header: this is one index.html (no install/server)");
  assert.match(vtext(a1), /RUNS that formula/, "header legend: the ⚡ runs the formula");
  assert.match(vtext(a1), /wiki/, "header legend: the W wiki button");
  // A2 is the FIRST example's description; A3 is its code card directly below.
  const a2 = state.cels.get("readme.A2")?.v, a3 = state.cels.get("readme.A3")?.v;
  assert.equal(a2?.tag, "div", "readme.A2 is the description card (above the code)");
  assert.ok(walkV(a2, (n) => /(^| )fx-desc( |$)/.test(String(n.attrs?.class ?? "")))[0], "A2 holds a .fx-desc description, not code");
  assert.equal(a3?.tag, "div", "readme.A3 is the example code card");
  assert.ok(walkV(a3, (n) => /(^| )fx-code( |$)/.test(String(n.attrs?.class ?? "")))[0], "A3 holds an .fx-code example");
  // column B holds the ⚡ output target cells (start empty), per CODE row.
  assert.ok(state.cels.has("readme.B3"), "readme.B3 exists — the first code row's own try-it target");
  // each code card's ⚡ targets ITS OWN B row (no shared target). Pull the
  // tryexample payloads out of the rendered buttons and check they're distinct.
  const targetsByRow = (vnode) => walkV(vnode, (n) => n.events?.click?.dispatch === "tryexample")
    .map((b) => b.events.click.payload?.__ex?.target);
  const t3 = targetsByRow(state.cels.get("readme.A3")?.v);
  const t5 = targetsByRow(state.cels.get("readme.A5")?.v);
  assert.deepEqual(t3, ["readme.B3"], "the first code row's ⚡ targets readme.B3 (its own B)");
  assert.deepEqual(t5, ["readme.B5"], "the second code row's ⚡ targets readme.B5 (its own B) — not a shared target");
  // description cells carry NO ⚡ (only the code cells run)
  assert.deepEqual(targetsByRow(a2), [], "the description cell has no try-it button");
  // a yellow-lightning try-it button rendered next to an example
  const tryBtns = walk(root, (n) => String(n.attrs?.class ?? "") === "try-it");
  assert.ok(tryBtns.length > 0, "try-it lightning buttons rendered next to examples");
  const bolt = walk(root, (n) => n.tag === "path" && /M7 2v11h3v9l7-12h-4l4-8z/.test(String(n.attrs?.d ?? "")))[0];
  assert.ok(bolt, "the try-it button uses the formula-bar lightning bolt SVG path");
  // no separate readmedata sheet
  assert.equal(state.cels.get("readmedata.A1"), undefined, "the readmedata sheet is gone (merged into readme)");
  // the readme is its own standalone window, packed by the desktop masonry
  // layout (win.layout="masonry") into a column tile — positioned, not tabbed.
  const g = state.cels.get("win.geom")?.v?.readme;
  assert.ok(g && g.host === undefined, "readme is a standalone window (geom carries no host → not tabbed)");
  assert.ok(typeof g.x === "number" && typeof g.y === "number" && g.w > 0 && g.h > 0, "readme is laid out (x/y/w/h set by masonry)");
  assert.ok(walk(root, (n) => String(n.attrs?.class ?? "") === "readme")[0], "the readme rendered in its cells");
});

test("the def + use examples are SEPARATE rows with SEPARATE B targets: running one does NOT overwrite the other (the double bug)", async () => {
  const { state, m } = await boot();
  // the tutorial teaches: define double on one row, call it on the NEXT row.
  // The def example's ⚡ targets readme.B6; the use example's ⚡ targets a
  // DIFFERENT B row. Find them by their code text.
  const exTargets = (rowKey) => walkV(state.cels.get(rowKey)?.v, (n) => n.events?.click?.dispatch === "tryexample")
    .map((b) => b.events.click.payload?.__ex);
  // code row A11 = =def("double", …); code row A13 = =double(21) (their desc
  // cells sit directly above them at A10 / A12).
  const defEx = exTargets("readme.A11")[0];
  const useEx = exTargets("readme.A13")[0];
  assert.match(defEx?.formula ?? "", /def\("double"/, "code row A11 is the def(\"double\") example");
  assert.match(useEx?.formula ?? "", /double\(21\)/, "code row A13 is the =double(21) example");
  assert.notEqual(defEx.target, useEx.target, "def and use write to DIFFERENT B cells");
  // run BOTH ⚡: the use must NOT clobber the def's output (separate B targets).
  await resolveFn(state, "tryexample")(state, { __ex: defEx }); m.run();
  await resolveFn(state, "tryexample")(state, { __ex: useEx }); m.run();
  assert.equal(state.cels.get("double")?.celType, "EditableLambdaCel", "the def created the double function");
  // each landed in its OWN B cell — neither overwrote the other
  assert.match(String(state.cels.get(defEx.target)?.v ?? ""), /double/, "the def's confirmation survives in its B cell");
  assert.equal(state.cels.get(useEx.target)?.v, 42, "=double(21) → 42 in its OWN B cell");
});

test("two try-it clicks on DIFFERENT code rows write DIFFERENT B cells (no shared-target overwrite)", async () => {
  const { state, m } = await boot();
  // two code rows have distinct B targets (readme.B3, readme.B5).
  await resolveFn(state, "tryexample")(state, { __ex: { formula: "=1+1", target: "readme.B3" } }); m.run();
  await resolveFn(state, "tryexample")(state, { __ex: { formula: "=2*3", target: "readme.B5" } }); m.run();
  assert.equal(state.cels.get("readme.B3")?.v, 2, "the first code row's result landed in readme.B3");
  assert.equal(state.cels.get("readme.B5")?.v, 6, "the second code row's result landed in readme.B5 (the first was NOT overwritten)");
});

test("clicking a try-it ⚡ writes the example formula into its target cell, which evaluates", async () => {
  const { state, m } = await boot();
  // run an example whose target is readme.B3 (a code row's own B)
  await resolveFn(state, "tryexample")(state, { __ex: { formula: "=1+1", target: "readme.B3" } }); m.run();
  assert.equal(state.cels.get("readme.B3")?.v, 2, "the formula landed in readme.B3 and evaluated → 2");
  // a real example formula (a grid) also materializes via the target
  await resolveFn(state, "tryexample")(state, { __ex: { formula: "=cels(3, 3)", target: "readme.B3" } }); m.run();
  assert.ok(state.cels.get("g3x3.A1"), "a =cels(3,3) example fired through the ⚡ created the grid");
});

test("Chat is a FEW plain dom() cels (no chatpanel monolith): bots/history/entry built from the clients sheet (tabbed pair)", async () => {
  const { state } = await boot();
  // the chatpanel verb is GONE — the chat is assembled from a few dom() formula cels.
  assert.equal(resolveFn(state, "chatpanel"), undefined, "the chatpanel verb is removed from the registry");
  // the clients sheet armed the client handles; the chat dom cels read them
  assert.ok(state.cels.get("clients.A1")?.v?.__client, "clients.A1 is a captured claude client handle");
  // chat sheet = 3 dom() cels: A1 bots, B1 history, C1 input+send — each a vnode
  assert.equal(state.cels.get("chat.A1")?.v?.attrs?.class, "chat-bots", "chat.A1 is the bots-left dom cel");
  assert.equal(state.cels.get("chat.B1")?.v?.attrs?.class, "chat-history", "chat.B1 is the history dom cel (chathistory)");
  assert.equal(state.cels.get("chat.C1")?.v?.attrs?.class, "chat-entry", "chat.C1 is the input+send dom cel");
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

  // B1/B2 are clientlights (dom spans); C1 is the messages cell (a plain VALUE
  // cell, empty at boot — no FormulaCel that structure-churns on first append);
  // D1 the entry buffer
  assert.equal(state.cels.get("clients.B1")?.v?.tag, "span", "clients.B1 = a clientlight span for claude");
  assert.equal(state.cels.get("clients.B2")?.v?.tag, "span", "clients.B2 = a clientlight span for grok");
  const c1 = state.cels.get("clients.C1");
  assert.ok(c1, "clients.C1 is the messages cell");
  assert.ok(typeof c1?.f !== "string", "clients.C1 is a VALUE cell, not a FormulaCel");
  assert.ok(state.cels.get("clients.D1"), "clients.D1 is the entry buffer cell");

  // CHAT sheet: a FEW dom() formula cels, each referencing the clients data cels —
  // no consolidated chatpanel verb. A1 = bots-left (clientlights), B1 = history
  // (chathistory over the messages cell), C1 = the input + send row.
  const bots = state.cels.get("chat.A1")?.v;
  assert.ok(walkV(bots, (n) => String(n.attrs?.class ?? "") === "chat-bot")[0], "A1 lists the bots");
  assert.ok(walkV(bots, (n) => String(n.attrs?.class ?? "") === "client-light")[0], "…each with a clientlight");
  const history = state.cels.get("chat.B1")?.v;
  assert.equal(history?.attrs?.class, "chat-history", "B1 is a chat history (chathistory clients.C1)");
  const entry = state.cels.get("chat.C1")?.v;
  const input = walkV(entry, (n) => n.tag === "input")[0];
  assert.ok(input, "C1 has a text entry input");
  assert.equal(input.events?.input?.dispatch, "chat.cellinput", "the input syncs the live text into the D1 buffer");
  assert.equal(input.events?.keydown?.dispatch, "chat.cellkey", "Enter in the input fires chat.cellkey");
  const send = walkV(entry, (n) => n.tag === "button" && /send/.test(txt(n)))[0];
  assert.ok(send, "C1 has a send button");
  // the send button dispatches the spreadsheet-native chat handler
  assert.equal(send.events?.click?.dispatch, "chat.cellsend", "send wired to chat.cellsend");
});

test("chat send: clients.C1 is a VALUE cell, every send is a plain setValue (no setCel/structure churn), and clients.D1 survives multiple sends", async () => {
  const { state, m } = await boot();
  // clients.C1 seeds as a plain EMPTY value cell (not a FormulaCel) so every
  // append is a setValue write of the grown array — no structure churn that
  // would re-materialize the clients genesis and sweep the clients.D1 entry
  // cel (the "setValue: unknown cel clients.D1" bug on the 2nd send).
  const before = state.cels.get("clients.C1");
  assert.ok(typeof before?.f !== "string", "clients.C1 starts as a VALUE cell, not a FormulaCel");

  // capture any console.error so an in-handler throw (e.g. unknown cel) surfaces
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => { errs.push(a.map(String).join(" ")); };
  try {
    // three sends in a row. No armed client at boot → each reply is the
    // "(no armed client …)" system line, but each STILL appends with no error,
    // and clients.D1 must survive every send.
    for (const msg of ["hello bots", "again", "and once more"]) {
      assert.ok(state.cels.get("clients.D1"), `clients.D1 exists before sending "${msg}"`);
      await resolveFn(state, "setValue")(state, "clients.D1", msg); m.run();
      await resolveFn(state, "chat.cellsend")(state); m.run();
    }
  } finally { console.error = origErr; }

  assert.ok(!errs.some((e) => /takes a formula source|got object|unknown cel/.test(e)),
    `no FormulaCel / unknown-cel error across sends (saw: ${errs.join(" | ")})`);
  const after = state.cels.get("clients.C1");
  assert.ok(Array.isArray(after?.v), "clients.C1 holds the message ARRAY as a value");
  assert.ok(typeof after?.f !== "string", "clients.C1 stayed a ValueCel (never setCel'd into structure)");
  // three sends → six rows (user line + reply each), and D1 survived to the end
  assert.equal(after.v.length, 6, "three sends appended 2 rows each");
  assert.ok(state.cels.get("clients.D1"), "clients.D1 survived all three sends");
  assert.equal(after.v[0]?.from, "me", "first row is the user");
  assert.equal(after.v[0]?.text, "hello bots", "with the first typed text");
  assert.equal(after.v[4]?.text, "and once more", "the third user line landed");
});

test("chat.cellinput stashes the live typed text into the clients.D1 buffer, then send pushes it onto C1", async () => {
  const { state, m } = await boot();
  // the uncontrolled input dispatches chat.cellinput on every keystroke; the
  // handler reads event.target.value and writes the D1 buffer (no {set} binding,
  // which the on-verb can't author). Then chat.cellsend reads D1 and pushes onto C1.
  await resolveFn(state, "chat.cellinput")(state, undefined, { target: { value: "live typed" } }); m.run();
  assert.equal(state.cels.get("clients.D1")?.v, "live typed", "chat.cellinput wrote the live value to D1");
  await resolveFn(state, "chat.cellsend")(state); m.run();
  const c1 = state.cels.get("clients.C1")?.v;
  assert.ok(Array.isArray(c1), "C1 is the message array");
  assert.equal(c1[0]?.from, "me", "the typed line pushed onto C1 as the user");
  assert.equal(c1[0]?.text, "live typed", "…with the text chat.cellinput captured");
  assert.equal(state.cels.get("clients.D1")?.v, "", "D1 cleared after send");
});
