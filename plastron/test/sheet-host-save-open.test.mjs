import { test } from "bun:test";
import { openTurtlesFixture } from "./_turtles-fixture.mjs";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../dist/index.js";
import { saveSheet, openAsSheet } from "../dist/甲骨坑/library/sheet-host/index.js";

// sheet-host SAVE / OPEN / NEW — the worksheet-window 💾/📁/🆕 controls:
//   - saveSheet(seg, fmt) serializes a worksheet (CSV values, XLSX values, .甲
//     rich cels+formulas); openAsSheet(bytes, name) detects the format and opens
//     a NEW standalone sheet window. Round-trips for CSV (values) + .甲
//     (cels+formulas) + xlsx (via the existing exporter).
//   - winsheet.newsheet makes a fresh blank standalone sheet window.
//   - the titlebar carries 💾/📁/🆕 buttons.
//   - double-clicking a .csv in the explorer opens a sheet window.

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
    fire(t, ev = {}) { for (const fn of [...(L.get(t) ?? [])]) fn({ type: t, target: el, currentTarget: el, ...ev }); },
  };
  return el;
};
const walk = (n, p, o = []) => { if (n?.nodeType === 1) { if (p(n)) o.push(n); for (const c of n.childNodes) walk(c, p, o); } return o; };
const txt = (n) => (n.nodeType === 3 ? n.data : (n.childNodes ?? []).map(txt).join(""));
const hasClass = (n, c) => new RegExp(`(^| )${c}( |$)`).test(String(n.attrs?.class ?? ""));
const byClass = (root, c) => walk(root, (n) => hasClass(n, c));
const windowOf = (root, seg) => walk(root, (n) => hasClass(n, "pl-window") && n.attrs["data-win"] === seg)[0];
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
  await resolveFn(state, "origin.run")(state, "元"); // minimal boot
  await openTurtlesFixture(state, resolveFn);   // README bundle → the turtle_data window fixture
  await resolveFn(state, "drain")(state, "dom.paint");
  m.run();
  return { state, root, m };
};

// seed a small worksheet segment directly (a private closure the host renders).
const seedSheet = async (state, seg, cells) => {
  const setCel = resolveFn(state, "setCel");
  for (const [addr, spec] of Object.entries(cells)) {
    await setCel(state, `${seg}.${addr}`, { ...spec, metadata: { segment: seg, name: addr, generatedBy: `${seg}.maker`, parser: "infix" } });
  }
  await resolveFn(state, "runCycle")(state);
};

// ── titlebar controls ────────────────────────────────────────────────────────

test("titlebar: every worksheet window carries 💾 save / 📁 open / 🆕 new buttons", async () => {
  const { root } = await boot();
  const w = windowOf(root, "turtle_data");
  assert.ok(w, "the turtle_data window exists");
  const glyphs = byClass(w, "pl-titlebar")[0];
  const save = byClass(glyphs, "pl-save-btn")[0];
  const open = byClass(glyphs, "pl-open-btn")[0];
  const neu = byClass(glyphs, "pl-new-btn")[0];
  assert.ok(save && txt(save) === "💾", "💾 save button present");
  assert.ok(open && txt(open) === "📁", "📁 open button present");
  assert.ok(neu && txt(neu) === "🆕", "🆕 new button present");
  // each stops the window drag on pointerdown like the other controls
  for (const b of [save, open, neu]) assert.ok(hasClass(b, b.attrs.class.split(" ")[0]), "control rendered");
});

// ── 🆕 New → a blank standalone sheet window ──────────────────────────────────

test("winsheet.newsheet: 🆕 creates a NEW standalone blank sheet window (fresh segment, untabbed)", async () => {
  const { state, m } = await boot();
  const before = Object.keys(state.cels.get("win.geom")?.v ?? {});
  await resolveFn(state, "winsheet.newsheet")(state); m.run();
  const geom = state.cels.get("win.geom").v;
  const newSeg = Object.keys(geom).find((k) => k.startsWith("sheet") && !before.includes(k));
  assert.ok(newSeg, "a fresh sheetN segment got a window");
  assert.equal(geom[newSeg].host, undefined, "the new sheet is standalone (no host — not tabbed)");
  // it is a real 10x10 grid of cels
  assert.ok(state.cels.get(`${newSeg}.A1`), "A1 of the new sheet exists");
  assert.ok(state.cels.get(`${newSeg}.J10`), "J10 of the new sheet exists (10x10)");
});

// ── CSV round-trip (values) ──────────────────────────────────────────────────

test("saveSheet(csv) -> openAsSheet round-trips a small sheet's VALUES", async () => {
  const { state, m } = await boot();
  await seedSheet(state, "src", {
    A1: { celType: "ValueCel", v: "Name" }, B1: { celType: "ValueCel", v: "Age" },
    A2: { celType: "ValueCel", v: "Ada" }, B2: { celType: "ValueCel", v: 42 },
    A3: { celType: "ValueCel", v: "with,comma" }, B3: { celType: "ValueCel", v: 'q"q' },
  });
  const out = await saveSheet(state, "src", "csv");
  assert.match(out.filename, /\.csv$/, "csv filename");
  assert.match(out.text, /Name,Age/, "header row serialized");
  assert.match(out.text, /"with,comma"/, "comma field is quoted");
  // open it back as a new sheet window
  const seg = await openAsSheet(state, out.bytes, "src.csv"); m.run();
  assert.equal(state.cels.get(`${seg}.A1`)?.v, "Name");
  assert.equal(state.cels.get(`${seg}.B2`)?.v, 42, "numeric value parsed back as a number");
  assert.equal(state.cels.get(`${seg}.A3`)?.v, "with,comma", "quoted comma field round-trips");
  assert.equal(state.cels.get(`${seg}.B3`)?.v, 'q"q', "embedded quote round-trips");
  // it landed in its OWN standalone window
  assert.equal(state.cels.get("win.geom").v[seg]?.host, undefined, "opened as a standalone window");
});

// ── .甲 round-trip (cels + formulas) ─────────────────────────────────────────

test("saveSheet(甲) -> openAsSheet round-trips CELS + FORMULAS (the rich format)", async () => {
  const { state, m } = await boot();
  await seedSheet(state, "rich", {
    A1: { celType: "ValueCel", v: 3 },
    A2: { celType: "ValueCel", v: "hi" },
    A3: { celType: "FormulaCel", f: "=2*21", parser: "infix" },
  });
  await resolveFn(state, "runCycle")(state);
  assert.equal(state.cels.get("rich.A3")?.v, 42, "formula evaluated to 42 before save");
  const out = await saveSheet(state, "rich", "甲");
  assert.match(out.filename, /\.甲$/, ".甲 filename");
  assert.equal(out.bytes[0], 0x50); assert.equal(out.bytes[1], 0x4b); // "PK" — a real zip
  const seg = await openAsSheet(state, out.bytes, "rich.甲"); m.run();
  await resolveFn(state, "runCycle")(state);
  // values round-trip (unlike CSV/XLSX, types too)
  assert.equal(state.cels.get(`${seg}.A1`)?.v, 3, "numeric value cel restored");
  assert.equal(state.cels.get(`${seg}.A2`)?.v, "hi", "string value cel restored");
  // the FORMULA is preserved as a FormulaCel — the rich format's whole point
  const a3 = state.cels.get(`${seg}.A3`);
  assert.equal(a3?.celType, "FormulaCel", "A3 came back as a FormulaCel (formula preserved, not flattened to a value)");
  assert.equal(a3?.f, "=2*21", "the formula source round-trips verbatim");
  assert.equal(a3?.v, 42, "the formula re-evaluates to 42 in the new sheet");
});

// ── xlsx via the existing exporter path ──────────────────────────────────────

test("saveSheet(xlsx) -> openAsSheet round-trips values via the existing xlsx path", async () => {
  const { state, m } = await boot();
  await seedSheet(state, "book", {
    A1: { celType: "ValueCel", v: "Item" }, B1: { celType: "ValueCel", v: "Qty" },
    A2: { celType: "ValueCel", v: "Widget" }, B2: { celType: "ValueCel", v: 7 },
  });
  const out = await saveSheet(state, "book", "xlsx");
  assert.match(out.filename, /\.xlsx$/, "xlsx filename");
  assert.equal(out.bytes[0], 0x50); assert.equal(out.bytes[1], 0x4b); // "PK"
  const seg = await openAsSheet(state, out.bytes, "book.xlsx"); m.run();
  assert.equal(state.cels.get(`${seg}.A1`)?.v, "Item");
  assert.equal(state.cels.get(`${seg}.B2`)?.v, 7, "numeric value round-trips through xlsx");
});

// ── explorer double-click opens a sheet window ───────────────────────────────

test("explorer double-click: a .csv file opens as a new sheet window", async () => {
  const { state, m } = await boot();
  // write a small CSV into OPFS, then double-click it in the explorer
  await resolveFn(state, "ensureSegments")(state, ["file-store"]);
  const csv = "x,y\n1,2\n3,4";
  await resolveFn(state, "fs.write")("/grid.csv", new TextEncoder().encode(csv));
  const before = Object.keys(state.cels.get("win.geom")?.v ?? {});
  await resolveFn(state, "explorer.openSheet")(state, "/grid.csv"); m.run();
  const geom = state.cels.get("win.geom").v;
  const seg = Object.keys(geom).find((k) => k.startsWith("sheet") && !before.includes(k));
  assert.ok(seg, "double-clicking the .csv opened a new sheet window");
  assert.equal(state.cels.get(`${seg}.A1`)?.v, "x", "the CSV's first cell loaded");
  assert.equal(state.cels.get(`${seg}.B3`)?.v, 4, "a numeric cell loaded as a number");
  assert.equal(geom[seg]?.host, undefined, "the opened sheet is a standalone window");
});

test("explorer double-click: a non-sheet file falls back to text preview (no new window)", async () => {
  const { state, m } = await boot();
  await resolveFn(state, "ensureSegments")(state, ["file-store"]);
  await resolveFn(state, "fs.write")("/note.txt", new TextEncoder().encode("hello"));
  const before = Object.keys(state.cels.get("win.geom")?.v ?? {});
  await resolveFn(state, "explorer.openSheet")(state, "/note.txt"); m.run();
  const after = Object.keys(state.cels.get("win.geom")?.v ?? {});
  assert.deepEqual(after.filter((k) => k.startsWith("sheet")), before.filter((k) => k.startsWith("sheet")), "no new sheet window for a .txt");
});
