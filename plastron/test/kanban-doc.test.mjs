import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createInitialState, precomputeOptional, resolveFn, createPainter, setPainter,
} from "../dist/index.js";

// ============================================================================
// kanban (the 📋 sheetapp document) — the SHEET is the program, the board and
// the new-task form are =view formulas over it:
//   - the board view FILTERs the task rows into four status columns; a card's
//     dragstart names its OWN status cel and a column's drop assigns its name
//     (the drag-reassign primitive) — movement is a setValue, re-rendered
//     through the graph.
//   - the form view param.sets the H4:H7 draft cells and its button dispatches
//     sheet.addrow with the policy payload (H8 next-id + drafts → columns
//     A..E, then clear) — the id rule is a visible =COUNTA formula cell.
// DERIVED from the shipped archive (apps/docs/kanban.json) at import time, the
// _turtles-fixture pattern, so this suite and the desktop demo can't drift.
// ============================================================================

const doc = JSON.parse(readFileSync(new URL("../../plastron-examples/origin/apps/docs/kanban.json", import.meta.url), "utf8"));

// one at("a1", …) entry per grid cel (dims rides the cels() rows/cols args).
// Formula sources are wrapped in DOUBLE quotes (they use only single quotes
// inside — the no-escapes convention, mirrored from the turtles fixture).
const atEntry = (cel) => {
  const addr = cel.metadata.name.toLowerCase();
  if (cel.celType === "FormulaCel") {
    if (cel.f.includes('"')) throw new Error(`fixture: ${cel.key} formula has double quotes — update the quoting here`);
    return `at("${addr}", "${cel.f}")`;
  }
  const v = cel.v;
  return typeof v === "number" ? `at("${addr}", "${v}")` : `at("${addr}", ${JSON.stringify(String(v))})`;
};
const gridCels = doc.segments[0].cels.filter((c) => /^[A-Z]+\d+$/.test(c.metadata.name));
const dims = doc.segments[0].cels.find((c) => c.metadata.name === "dims").v;
const KANBAN = `=segment(\n\tcels("kanban", ${dims.rows}, ${dims.cols},\n\t\t${gridCels.map(atEntry).join(",\n\t\t")}))`;

// ── a tiny mock DOM (the origin-view harness) ────────────────────────────────
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
  const r = (k) => resolveFn(state, k);
  await r("ensureSegments")(state, ["origin"]);
  await r("hydrate")(state, [], []);
  await precomputeOptional(state);
  await r("runCycle")(state);
  await r("origin.run")(state, "元");
  // a minimal open workbook for the =view panes to attach to
  const g = r("wbopen")("t", "T", [{ ref: "tc.body", title: "S" }], []);
  await r("setCel")(state, "tc.body", { celType: "ValueCel", v: { type: "el", tag: "div", children: [] }, metadata: { segment: "tc" } });
  await r("setCelBatch")(state, g.cels);
  await r("runCycle")(state);
  const cycle = async () => { await r("runCycle")(state); await r("drain")(state, "origin.effects"); await r("drain")(state, "dom.paint"); m.run(); };
  await r("origin.run")(state, "kanbandemo.run", KANBAN);
  await cycle();
  return { state, r, cycle };
};

// ── vnode probes ──────────────────────────────────────────────────────────────
const vtxt = (n) => (n?.type === "text" ? n.text : (n?.children ?? []).map(vtxt).join(""));
const vfind = (n, pred, out = []) => { if (n && typeof n === "object") { if (pred(n)) out.push(n); (n.children ?? []).forEach((c) => vfind(c, pred, out)); } return out; };
// view names are sanitized to ASCII refs ('📋 board' → board.view); the raw
// name (emoji and all) becomes the TAB title.
const boardOf = (state) => state.cels.get("board.view")?.v;
const colInBoard = (state, name) => vfind(boardOf(state), (n) => n.attrs?.["data-col"] === name)[0];
const cardsIn = (col) => vfind(col, (n) => /(^| )kcard( |$)/.test(String(n.attrs?.class ?? "")));
const titlesIn = (state, name) => cardsIn(colInBoard(state, name)).map((c) => vtxt(vfind(c, (n) => /ktitle/.test(String(n.attrs?.class ?? "")))[0]));

// seed-derived expectations, so growing the shipped backlog never breaks this
// suite: task count, per-status counts, and the next id all come from the doc.
const seedIds = gridCels.filter((c) => /^A\d+$/.test(c.metadata.name) && typeof c.v === "number");
const NEXT_ID = seedIds.length + 1;
const NEXT_ROW = Math.max(...seedIds.map((c) => Number(c.metadata.name.slice(1)))) + 1;
const seedStatus = (s) => gridCels.filter((c) => /^C\d+$/.test(c.metadata.name) && c.metadata.name !== "C1" && c.v === s).length;

test("the doc materializes: tasks on the sheet, board + form panes, every rule a visible cell", async () => {
  const { state } = await boot();

  // the sheet IS the program: data + next-id rule + view formulas all cells
  assert.equal(state.cels.get("kanban.A2")?.v, 1, "task 1 id on the grid");
  assert.equal(state.cels.get("kanban.C3")?.v, "Review", "task 2 status on the grid");
  assert.equal(state.cels.get("kanban.H8")?.v, NEXT_ID, `next-id =COUNTA formula computed (${seedIds.length} tasks → ${NEXT_ID})`);
  assert.deepEqual(state.cels.get("kanban.H1")?.v, { view: "board", item: true }, "board cell holds the ⧉ token, formula survives");
  assert.ok(state.cels.get("board.view"), "board pane exists");
  assert.ok(state.cels.get("newtask.view"), "form pane exists");

  // the board: four status columns, cards where their status cel says
  for (const col of ["To Do", "Doing", "Review", "Done"]) assert.ok(colInBoard(state, col), `${col} column renders`);
  assert.equal(titlesIn(state, "Review").length, seedStatus("Review"), "the shipped tickets await review");
  assert.ok(titlesIn(state, "Review")[0].includes("Rebuild kanban"), "ticket 1 card");
  assert.equal(cardsIn(colInBoard(state, "Done")).length, seedStatus("Done"), "Done matches the seed");

  // a card names its OWN status cel; a column carries its name (drag-reassign)
  const card = cardsIn(colInBoard(state, "Review"))[0];
  assert.equal(card.events?.dragstart?.dispatch, "drag.grab");
  assert.equal(card.events?.dragstart?.payload, "kanban.C2", "id 1 → status cel C2");
  const done = colInBoard(state, "Done");
  assert.equal(done.events?.drop?.dispatch, "drag.drop");
  assert.equal(done.events?.drop?.payload, "Done");
});

test("dragging a card to another column setValues its status cel; the board re-renders", async () => {
  const { state, r, cycle } = await boot();
  await r("drag.grab")(state, "kanban.C2");
  await r("drag.drop")(state, "Done");
  await cycle();
  assert.equal(state.cels.get("kanban.C2")?.v, "Done", "status cel reassigned");
  assert.ok(titlesIn(state, "Done").some((t) => t.includes("Rebuild kanban")), "card re-rendered into Done");
  assert.equal(titlesIn(state, "Review").length, seedStatus("Review") - 1, "…and left Review");
});

test("the form appends through sheet.addrow: drafts → the next row, next-id advances, drafts clear", async () => {
  const { state, r, cycle } = await boot();

  // the form's button carries the POLICY payload (columns, id rule, clears)
  const form = state.cels.get("newtask.view")?.v;
  const btn = vfind(form, (n) => n.tag === "button")[0];
  assert.equal(btn.events?.click?.dispatch, "sheet.addrow", "button dispatches the mechanism verb");
  assert.deepEqual(btn.events?.click?.payload, {
    seg: "kanban",
    from: ["kanban.H8", "kanban.H4", "kanban.H5", "kanban.H6", "kanban.H7"],
    clear: ["kanban.H4", "kanban.H7"],
  }, "…with the authored policy (object + list literals through infix)");
  const input = vfind(form, (n) => n.tag === "input")[0];
  assert.equal(input.events?.change?.dispatch, "param.set", "inputs write the draft cells");

  // type into the form — the real handler; H4/H6 seed as "" so a shared
  // RECIPE doesn't carry them, and param.set's sparse-grid commit births them
  await r("param.set")(state, "kanban.H4", { target: { value: "Wire agents to tickets" } });
  await r("param.set")(state, "kanban.H6", { target: { value: "ian" } });
  await r("sheet.addrow")(state, btn.events.click.payload);

  assert.equal(state.cels.get(`kanban.A${NEXT_ROW}`)?.v, NEXT_ID, `new row lands at row ${NEXT_ROW} with id ${NEXT_ID} (= H8 at click time)`);
  assert.equal(state.cels.get(`kanban.B${NEXT_ROW}`)?.v, "Wire agents to tickets");
  assert.equal(state.cels.get(`kanban.C${NEXT_ROW}`)?.v, "To Do");
  assert.equal(state.cels.get(`kanban.D${NEXT_ROW}`)?.v, "ian");
  assert.equal(state.cels.get("kanban.H4")?.v, "", "title draft cleared");
  assert.equal(state.cels.get("kanban.H6")?.v, "ian", "assignee draft kept (not in clear)");
  assert.equal(state.cels.get("kanban.H8")?.v, NEXT_ID + 1, "next-id recomputed through the =COUNTA range");
  assert.ok(state.cels.get("kanban.dims")?.v.rows >= NEXT_ROW, "dims cover the new row (grow-to-at-least)");

  await cycle();
  assert.ok(titlesIn(state, "To Do").some((t) => t.includes("Wire agents")), "the board picked up the new card");
});
