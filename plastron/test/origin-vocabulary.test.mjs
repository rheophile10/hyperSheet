import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  createInitialState, precomputeOptional, resolveFn, createPainter, setPainter,
} from "../dist/index.js";
import { vnodePath } from "../dist/甲骨坑/application/origin/index.js";

// ============================================================================
// The structure vocabulary — =sheet / =addCells / =rename / =append(xpath) /
// =help. All GENERATIVE (formula survives; token value; idempotent re-fires)
// and all SPARSE (=sheet mints ONE dims cel; =addCells is a pure dims write).
// ============================================================================

const mkEl = (tag) => {
  const L = new Map();
  const el = {
    nodeType: 1, tag, tagName: tag.toUpperCase(), value: undefined, childNodes: [], attrs: {},
    style: { props: {}, setProperty(p, v) { this.props[p] = v; }, removeProperty(p) { delete this.props[p]; } },
    get firstChild() { return el.childNodes[0] ?? null; },
    get lastChild() { return el.childNodes[el.childNodes.length - 1] ?? null; },
    setAttribute(n, v) { el.attrs[n] = v; }, removeAttribute(n) { delete el.attrs[n]; },
    getAttribute(n) { return el.attrs[n] ?? null; },
    getContext() { return { fillRect() {}, strokeRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, clearRect() {}, fillText() {}, save() {}, restore() {}, setLineDash() {}, moveTo() {}, lineTo() {}, closePath() {} }; },
    appendChild(c) { el.childNodes.push(c); return c; },
    removeChild(c) { const i = el.childNodes.indexOf(c); if (i >= 0) el.childNodes.splice(i, 1); return c; },
    replaceChild(n, o) { const i = el.childNodes.indexOf(o); if (i >= 0) el.childNodes[i] = n; return o; },
    insertBefore(n, r) { const i = r ? el.childNodes.indexOf(r) : -1; if (i >= 0) el.childNodes.splice(i, 0, n); else el.childNodes.push(n); return n; },
    replaceChildren(...c) { el.childNodes = [...c]; },
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
  const put = async (src, key = "元") => { await r("origin.edit")(state, key); m.run(); await r("setValue")(state, "元.draft", src); await r("origin.run")(state, key); m.run(); };
  await put("=cels(2, 2)");                       // an active WORKBOOK for the verbs to target
  return { state, r, m, put };
};

test("=sheet is sparse + generative: ONE dims cel, a tab, the ▦ token, idempotent", async () => {
  const { state, r, put } = await boot();
  await put("=sheet('data')", "g2x2.A1");

  // sparse: exactly one cel in the new segment — the dims
  const dataCels = [...state.cels.keys()].filter((k) => k.startsWith("data."));
  assert.deepEqual(dataCels, ["data.dims"], `only data.dims minted (got ${JSON.stringify(dataCels)})`);
  assert.deepEqual(state.cels.get("data.dims").v, { rows: 12, cols: 7 });
  // the tab landed in the active workbook
  const wb = state.cels.get("win.g2x2.state").v;
  assert.ok(wb.sheets.some((t) => t.title === "data"), "data tab added to the workbook");
  // generative: formula survives, token value, ▦ rendering
  const cell = state.cels.get("g2x2.A1");
  assert.equal(cell.celType, "FormulaCel");
  assert.equal(cell.f, "=sheet('data')");
  assert.deepEqual(cell.v, { sheet: "data" });
  assert.equal(r("sheetcell")({ sheet: "data" }).text, "▦ data");
  // idempotent: re-fire adds nothing
  await put("=sheet('data')", "g2x2.A1");
  assert.equal(state.cels.get("win.g2x2.state").v.sheets.filter((t) => t.title === "data").length, 1, "no duplicate tab");
  assert.equal([...state.cels.keys()].filter((k) => k.startsWith("data.")).length, 1, "still just dims");
});

test("=addCells grows dims TO AT LEAST rows×cols — a pure data write, idempotent", async () => {
  const { state, put } = await boot();
  await put("=sheet('data')", "g2x2.A1");
  const before = state.cels.size;
  await put("=addCells('data', 20, 9)", "g2x2.B1");
  assert.deepEqual(state.cels.get("data.dims").v, { rows: 20, cols: 9 }, "dims grew");
  // sparse: no addressed space entered state (only the =addCells cell itself changed)
  assert.equal([...state.cels.keys()].filter((k) => k.startsWith("data.") && k !== "data.dims").length, 0, "no data.* cels born");
  // at-least semantics: re-fire and smaller asks are no-ops
  await put("=addCells('data', 15, 4)", "g2x2.B1");
  assert.deepEqual(state.cels.get("data.dims").v, { rows: 20, cols: 9 }, "smaller ask is a no-op (grow-to-at-least)");
  assert.ok(state.cels.size >= before, "no cel churn");
  const b1 = state.cels.get("g2x2.B1");
  assert.equal(b1.celType, "FormulaCel", "generative — formula survives");
});

test("committing into a sparse address births the cel and the grid formula re-derives", async () => {
  const { state, put } = await boot();
  await put("=sheet('data')", "g2x2.A1");
  assert.equal(state.cels.get("data.B2"), undefined);
  await put("7", "data.B2");
  const born = state.cels.get("data.B2");
  assert.ok(born, "cel born on commit");
  assert.equal(born.v, 7);
  assert.equal(born.metadata.segment, "data", "born into its sheet's segment");
  const contentF = state.cels.get("win.g2x2.view.data")?.f ?? "";
  assert.match(contentF, /data\.B2/, "the sheet's content formula now references the born cel");
  assert.match(contentF, /data\.dims/, "…and stays dims-reactive");
});

test("=rename retitles a sheet tab by alias (keys untouched) and a view tab in place", async () => {
  const { state, put } = await boot();
  await put("=sheet('data')", "g2x2.A1");
  await put("=rename('data', 'facts')", "g2x2.B1");
  const wb = state.cels.get("win.g2x2.state").v;
  assert.ok(wb.sheets.some((t) => t.title === "facts"), "sheet tab retitled");
  assert.equal(state.cels.get("data.alias")?.v, "facts", "alias recorded");
  assert.ok(state.cels.get("data.dims"), "cel keys untouched (still data.*)");
  // view rename
  await put("=view('viz')", "g2x2.A2");
  await put("=rename('viz', 'charts')", "g2x2.B2");
  const wb2 = state.cels.get("win.g2x2.state").v;
  assert.ok(wb2.views.some((t) => t.title === "charts"), "view tab retitled");
  // idempotent re-fire: old name gone, new exists → no-op success
  await put("=rename('data', 'facts')", "g2x2.B1");
  assert.equal(state.cels.get("win.g2x2.state").v.sheets.filter((t) => t.title === "facts").length, 1);
});

test("vnodePath: the xpath subset over vnode trees", () => {
  const t = { type: "el", tag: "div", attrs: {}, children: [
    { type: "el", tag: "ul", attrs: { id: "list", class: "big" }, children: [
      { type: "el", tag: "li", attrs: {}, children: [] },
      { type: "el", tag: "li", attrs: { class: "hot now" }, children: [] },
    ] },
    { type: "el", tag: "div", attrs: {}, children: [{ type: "el", tag: "p", attrs: {}, children: [] }] },
  ] };
  assert.equal(vnodePath(t, "/ul"), t.children[0]);
  assert.equal(vnodePath(t, "//p"), t.children[1].children[0]);
  assert.equal(vnodePath(t, "//*[@id='list']"), t.children[0]);
  assert.equal(vnodePath(t, "//li[@class='hot']"), t.children[0].children[1], "class-contains");
  assert.equal(vnodePath(t, "/ul/li[2]"), t.children[0].children[1], "1-based index");
  assert.equal(vnodePath(t, "//nav"), null);
  assert.equal(vnodePath(t, "not-an-xpath"), null);
});

test("=append targets an xpath; re-fires replace the slot; xpath edits MOVE it", async () => {
  const { state, put } = await boot();
  // pane + a container with an id (a keyed slot holding a div#inner)
  await put("=append('viz', dom('div', attr('id', 'inner'), 'container'))", "g2x2.A1");
  const pane = () => state.cels.get("viz.view").v;
  assert.ok(pane(), "2-arg append opened the pane itself");
  const walk = (n, p, o = []) => { if (n?.type === "el") { if (p(n)) o.push(n); for (const c of n.children ?? []) walk(c, p, o); } return o; };
  assert.equal(walk(pane(), (n) => n.attrs?.id === "inner").length, 1, "container landed at the root");

  // 3-arg: target INSIDE the container
  await put("=append('viz', '//div[@id=\"inner\"]', dom('p', 'X'))", "g2x2.B1");
  const inner = () => walk(pane(), (n) => n.attrs?.id === "inner")[0];
  assert.equal(walk(inner(), (n) => n.tag === "p").length, 1, "item landed inside the xpath target");

  // re-fire → still exactly one slot
  await put("=append('viz', '//div[@id=\"inner\"]', dom('p', 'X'))", "g2x2.B1");
  assert.equal(walk(pane(), (n) => n.attrs?.["data-cel"] === "g2x2.B1").length, 1, "no duplicate slots on re-fire");

  // xpath edit → the slot MOVES to the pane root
  await put("=append('viz', dom('p', 'X'))", "g2x2.B1");
  assert.equal(walk(pane(), (n) => n.attrs?.["data-cel"] === "g2x2.B1").length, 1, "still one slot");
  assert.equal(walk(inner(), (n) => n.attrs?.["data-cel"] === "g2x2.B1").length, 0, "…no longer inside the container");
});

test("=help: the TREE explorer — instant open, expand/collapse, detail, search index", async () => {
  const { state, r, put } = await boot();
  await put("=help()", "g2x2.A1");
  // the tree renders from ONE index cel — no graph, no layout, instant
  const index = state.cels.get("help.index")?.v;
  assert.ok(Array.isArray(index) && index.length > 15, `the vocabulary index built (${index?.length} segments)`);
  const ecsEntry = index.find((s) => s.name === "ecs");
  assert.ok(ecsEntry && ecsEntry.cels.some((c) => c.key === "sysmap"), "index carries each segment's cels");
  assert.ok(ecsEntry.cels.find((c) => c.key === "sysmap").sig?.startsWith("("), "signatures parsed from descriptions");
  assert.deepEqual(state.cels.get("help.open").v, [], "everything collapsed at open");
  assert.ok(state.cels.get("win.g2x2.view.help"), "the help view tab exists");
  assert.deepEqual(state.cels.get("g2x2.A1").v, { view: "help" }, "generative token");

  // folder click: expand + segment description in the detail panel
  await r("help.toggle")(state, "ecs");
  assert.deepEqual(state.cels.get("help.open").v, ["ecs"], "ecs expanded");
  assert.equal(state.cels.get("help.selectedInfo").v.celType, "segment", "segment detail landed");
  // the rendered pane shows the segment's functions as tree rows
  const paneV = state.cels.get("win.g2x2.view.help")?.v;
  const walk = (n, p, o = []) => { if (n?.type === "el") { if (p(n)) o.push(n); for (const c of n.children ?? []) walk(c, p, o); } else if (n?.type === "text" && p(n)) o.push(n); return o; };
  assert.ok(walk(paneV, (n) => n.type === "text" && n.text === "sysmap").length >= 1, "sysmap row rendered in the tree");
  assert.ok(walk(paneV, (n) => n.type === "text" && n.text === "segments").length >= 1, "the tree is titled 'segments'");

  // function click: detail panel
  await r("help.selectNode")(state, "sysmap");
  const info = state.cels.get("help.selectedInfo").v;
  assert.equal(info.key, "sysmap");
  assert.match(String(info.description), /entity/i, "the verb's description landed");

  // collapse
  await r("help.toggle")(state, "ecs");
  assert.deepEqual(state.cels.get("help.open").v, [], "toggle collapses");

  // =help('segment') opens with that segment pre-expanded
  await put("=help('dom')", "g2x2.B2");
  assert.ok(state.cels.get("help.open").v.includes("dom"), "focused help pre-expands the segment");
});
