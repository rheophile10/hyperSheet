import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../dist/index.js";

// origin-kanban — the GOLD board for the drag-reassign primitive
// (docs/1-design/1-under-consideration/drag-reassign-primitive.md).
//
// A kanban built ONLY from general formulas: cels() for the task data, LET/LAMBDA
// + FILTER/MAP/INDEX/CONCAT for the board, and the drag.* primitive for movement.
// Nothing here is kanban-specific. Movement is REACTIVE: a drop setValues a task's
// status cel, and because every column FILTERs on tasks!C1:C6 the board re-renders
// the card into its new column through runCycle — no pixels, no manual layout.

// ── a tiny mock DOM that records listeners and can fire() events ─────────────
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
    fire(t, ev = {}) { for (const fn of [...(L.get(t) ?? [])]) fn({ type: t, target: el, currentTarget: el, preventDefault() {}, ...ev }); },
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
  return { state, root, m };
};

const put = async (state, root, m, src, key = "元") => {
  await resolveFn(state, "origin.edit")(state, key); m.run();
  await resolveFn(state, "setValue")(state, "元.draft", src);
  await resolveFn(state, "origin.run")(state, key);
  m.run();
};

// THE SHAREABLE GOLD FORMULA — one segment() call, like the nav formula: a cels()
// sheet of tasks + a winapp() window whose content formula IS the board. Quote
// nesting is one level deep, per the guide convention: top-level args are "…",
// the nested window body is '…' (the parser alternates quote types — no escaping).
const KANBAN = `=segment(
	cels("tasks", 6, 3,
		at("A1", 1), at("B1", "Email Bob"),    at("C1", "To Do"),
		at("A2", 2), at("B2", "Write spec"),   at("C2", "Doing"),
		at("A3", 3), at("B3", "Fix bug"),      at("C3", "To Do"),
		at("A4", 4), at("B4", "Ship release"), at("C4", "Done"),
		at("A5", 5), at("B5", "Plan sprint"),  at("C5", "Doing"),
		at("A6", 6), at("B6", "Review PR"),    at("C6", "To Do")),
	wopen("kanban", "📋 Kanban",
		'=LET(
			cardOf, LAMBDA(id,
				dom("div.kcard",
					attr("draggable", "true"),
					on("dragstart", "drag.grab", CONCAT("tasks.C", id)),
					INDEX(tasks!B1:B6, id))),
			colOf, LAMBDA(name,
				dom("div.kcol",
					attr("data-col", name),
					on("dragover", "drag.over"),
					on("drop", "drag.drop", name),
					dom("h3", name),
					MAP(
						FILTER(tasks!A1:A6, LAMBDA(id, INDEX(tasks!C1:C6, id) = name)),
						cardOf))),
			dom("div.kboard",
				colOf("To Do"),
				colOf("Doing"),
				colOf("Done")))'))`;

// the board vnode is the value of the window's content cel — assert on it directly
// (independent of whether the window mounts in the headless harness).
const boardOf = (state) => state.cels.get("win.kanban.content")?.v;
const colInVnode = (v, name) => { const out = []; const w = (n) => { if (!n || typeof n !== "object") return; if (n.attrs?.["data-col"] === name) out.push(n); (n.children ?? []).forEach(w); }; w(v); return out[0]; };
const cardsInCol = (col) => { const out = []; const w = (n) => { if (!n || typeof n !== "object") return; if (/(^| )kcard( |$)/.test(String(n.attrs?.class ?? ""))) out.push(n); (n.children ?? []).forEach(w); }; w(col); return out; };
const vtxt = (n) => (n?.type === "text" ? n.text : (n?.children ?? []).map(vtxt).join(""));
const titlesIn = (state, name) => { const col = colInVnode(boardOf(state), name); return col ? cardsInCol(col).map(vtxt) : []; };

test("shareable segment() formula materializes a tasks sheet + a kanban window with cards by status", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, KANBAN);

  assert.ok(state.cels.get("tasks.C2"), "tasks sheet materialized");
  assert.ok(state.cels.get("win.kanban.state"), "kanban window state cel created");
  assert.ok(state.cels.get("win.kanban.content"), "kanban window content cel created");
  assert.ok(state.cels.get("win.kanban.frame"), "kanban window frame cel created");

  const board = boardOf(state);
  assert.equal(board?.tag, "div", `content is the board vnode (got ${JSON.stringify(board).slice(0, 100)})`);
  assert.deepEqual(titlesIn(state, "To Do").sort(), ["Email Bob", "Fix bug", "Review PR"].sort(), "To Do cards");
  assert.deepEqual(titlesIn(state, "Doing").sort(), ["Plan sprint", "Write spec"].sort(), "Doing cards");
  assert.deepEqual(titlesIn(state, "Done"), ["Ship release"], "Done cards");
});

test("dragging a card to another column reassigns its status cel and re-renders reactively", async () => {
  const { state, root, m } = await boot();
  await put(state, root, m, KANBAN);

  // "Write spec" (id 2) starts in Doing (tasks.C2). The card's dragstart binding
  // must name its OWN status cel, and the Done column's drop must carry "Done".
  const doingCol = colInVnode(boardOf(state), "Doing");
  const card = cardsInCol(doingCol).find((c) => vtxt(c) === "Write spec");
  assert.ok(card, "found the Write spec card in Doing");
  assert.equal(card.attrs["draggable"], "true", "card is draggable");
  assert.equal(card.events?.dragstart?.dispatch, "drag.grab", "card wires dragstart → drag.grab");
  assert.equal(card.events?.dragstart?.payload, "tasks.C2", "…carrying its own status cel key");
  const doneCol = colInVnode(boardOf(state), "Done");
  assert.equal(doneCol.events?.drop?.dispatch, "drag.drop", "Done column wires drop → drag.drop");
  assert.equal(doneCol.events?.drop?.payload, "Done", "…carrying the value 'Done'");

  // drive the handlers the DOM events would call: grab the card, drop on Done.
  await resolveFn(state, "drag.grab")(state, card.events.dragstart.payload);
  assert.equal(state.cels.get("drag.active")?.v, "tasks.C2", "drag.active names the dragged card's status cel");
  await resolveFn(state, "drag.drop")(state, doneCol.events.drop.payload);
  m.run();

  assert.equal(state.cels.get("tasks.C2")?.v, "Done", "status cel reassigned by the drop");
  assert.equal(state.cels.get("drag.active")?.v, null, "drag.active cleared after drop");
  assert.ok(!titlesIn(state, "Doing").includes("Write spec"), "card left Doing");
  assert.ok(titlesIn(state, "Done").includes("Write spec"), "card reactively re-rendered in Done");
});
