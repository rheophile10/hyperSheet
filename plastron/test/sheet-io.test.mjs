import { test } from "bun:test";
import assert from "node:assert/strict";
import { toCsv, parseCsv, csvToCells, toJia, jiaToCells } from "../dist/甲骨坑/library/sheet-io/index.js";
import { saveSheet, openAsSheet } from "../dist/甲骨坑/library/sheet-io/index.js";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../dist/index.js";

// sheet-io owns worksheet serialization (extracted from sheet-host). These pin
// the pure serializers: CSV (values-only) + .甲 (the rich archive — cels +
// formulas round-trip). saveSheet/openAsSheet themselves drive genesis.drain +
// the windowing geom, exercised in the origin e2e suites; here we cover the
// format round-trips that don't need a live kernel.

// a minimal State stand-in: just a .cels Map of A1-addressed grid cels.
const mkState = (seg, grid) => {
  const cels = new Map();
  for (const [addr, spec] of Object.entries(grid)) {
    cels.set(`${seg}.${addr}`, { celType: spec.f !== undefined ? "FormulaCel" : "ValueCel", v: spec.v, f: spec.f, metadata: { segment: seg, name: addr } });
  }
  return { cels };
};

test("toCsv lays grid cels out in A1 row×col order with RFC-4180 quoting", () => {
  const state = mkState("s1", { A1: { v: "name" }, B1: { v: "qty" }, A2: { v: "a,b" }, B2: { v: 3 }, A3: { v: 'he"llo' } });
  const csv = toCsv(state, "s1");
  assert.equal(csv, 'name,qty\n"a,b",3\n"he""llo",');
});

test("parseCsv round-trips through csvToCells: numeric fields become numbers, blanks drop", () => {
  const rows = parseCsv('name,qty\n"a,b",3\n,5');
  assert.deepEqual(rows, [["name", "qty"], ["a,b", "3"], ["", "5"]]);
  const cells = csvToCells("s2", rows);
  assert.equal(cells["s2.A1"].v, "name");
  assert.equal(cells["s2.A2"].v, "a,b");
  assert.equal(cells["s2.B2"].v, 3);            // numeric coercion
  assert.equal(cells["s2.A3"], undefined);      // blank field dropped
  assert.equal(cells["s2.B3"].v, 5);
});

test(".甲 archive round-trips cels AND formulas (the rich form CSV can't)", async () => {
  const state = mkState("s3", { A1: { v: "total" }, A2: { v: 6, f: "(+ 1 2 3)" }, B1: { v: 42 } });
  const bytes = await toJia(state, "s3");
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0);
  const cells = await jiaToCells("s3", bytes);
  assert.equal(cells["s3.A1"].celType, "ValueCel");
  assert.equal(cells["s3.A1"].v, "total");
  assert.equal(cells["s3.A2"].celType, "FormulaCel");
  assert.equal(cells["s3.A2"].f, "(+ 1 2 3)");  // formula preserved
  assert.equal(cells["s3.B1"].v, 42);
});

test("jiaToCells rejects an archive with no sheet.json", async () => {
  await assert.rejects(() => jiaToCells("s4", new Uint8Array([1, 2, 3])));
});

// ── live save→open round-trips + explorer integration ─────────────────────────
// The pure serializers above don't need a kernel; saveSheet/openAsSheet drive
// genesis.drain + the windowing geom, so these spin up a minimal kernel (a DOM
// stand-in + a mock painter, mirroring test/sheet-host-save-open.test.mjs) and
// load the segments the round-trips touch. We assert VALUES (csv/xlsx) and
// CELS+FORMULAS (.甲) survive save→open into a fresh standalone sheet window, and
// that file-explorer's explorer.openSheet routes an OPFS file THROUGH sheet-io.

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
const mockRaf = () => { const q = []; return { raf: (cb) => q.push(cb), caf: () => {}, run: () => { for (const cb of q.splice(0)) cb(); } }; };

const boot = async (segs = []) => {
  const root = mkEl("app");
  globalThis.document = {
    createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }),
    querySelector: (s) => (s === "#app" ? root : null),
    addEventListener() {}, removeEventListener() {},
  };
  const m = mockRaf();
  const state = createInitialState();
  setPainter(state, createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: true, doc: globalThis.document, resolveMount: (x) => (x === "#app" ? root : null) }));
  await resolveFn(state, "ensureSegments")(state, ["origin", "sheet-io", "window", "sheets", "file-store", "file-explorer", ...segs]);
  await resolveFn(state, "hydrate")(state, [], []);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "origin.run")(state, "元"); // minimal boot
  await resolveFn(state, "drain")(state, "dom.paint");
  m.run();
  return { state, root, m };
};

// seed a small worksheet segment directly (the host renders such a closure).
const seedSheet = async (state, seg, cells) => {
  const setCel = resolveFn(state, "setCel");
  for (const [addr, spec] of Object.entries(cells)) {
    await setCel(state, `${seg}.${addr}`, { ...spec, metadata: { segment: seg, name: addr, generatedBy: `${seg}.maker`, parser: "infix" } });
  }
  await resolveFn(state, "runCycle")(state);
};

const sheetSegs = (state) => Object.keys(state.cels.get("win.geom")?.v ?? {}).filter((k) => k.startsWith("sheet"));

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
  const seg = await openAsSheet(state, out.bytes, "src.csv"); m.run();
  assert.equal(state.cels.get(`${seg}.A1`)?.v, "Name");
  assert.equal(state.cels.get(`${seg}.B2`)?.v, 42, "numeric value parsed back as a number");
  assert.equal(state.cels.get(`${seg}.A3`)?.v, "with,comma", "quoted comma field round-trips");
  assert.equal(state.cels.get(`${seg}.B3`)?.v, 'q"q', "embedded quote round-trips");
  assert.equal(state.cels.get("win.geom").v[seg]?.host, undefined, "opened as a standalone window");
});

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
  assert.equal(state.cels.get(`${seg}.A1`)?.v, 3, "numeric value cel restored");
  assert.equal(state.cels.get(`${seg}.A2`)?.v, "hi", "string value cel restored");
  const a3 = state.cels.get(`${seg}.A3`);
  assert.equal(a3?.celType, "FormulaCel", "A3 came back as a FormulaCel (formula preserved, not flattened)");
  assert.equal(a3?.f, "=2*21", "the formula source round-trips verbatim");
  assert.equal(a3?.v, 42, "the formula re-evaluates to 42 in the new sheet");
});

test("saveSheet(xlsx) -> openAsSheet round-trips values via the xlsx path", async () => {
  const { state, m } = await boot(["xlsx"]);
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

test("explorer.openSheet: an OPFS .csv opens as a new sheet window THROUGH sheet-io", async () => {
  const { state, m } = await boot();
  const csv = "x,y\n1,2\n3,4";
  await resolveFn(state, "fs.write")("/grid.csv", new TextEncoder().encode(csv));
  const before = sheetSegs(state);
  await resolveFn(state, "explorer.openSheet")(state, "/grid.csv"); m.run();
  const seg = sheetSegs(state).find((k) => !before.includes(k));
  assert.ok(seg, "double-clicking the .csv opened a new sheet window");
  assert.equal(state.cels.get(`${seg}.A1`)?.v, "x", "the CSV's first cell loaded");
  assert.equal(state.cels.get(`${seg}.B3`)?.v, 4, "a numeric cell loaded as a number");
  assert.equal(state.cels.get("win.geom").v[seg]?.host, undefined, "opened as a standalone window");
});

test("explorer.openSheet: a non-sheet .txt falls back to preview (no new sheet window)", async () => {
  const { state, m } = await boot();
  await resolveFn(state, "fs.write")("/note.txt", new TextEncoder().encode("hello"));
  const before = sheetSegs(state);
  await resolveFn(state, "explorer.openSheet")(state, "/note.txt"); m.run();
  assert.deepEqual(sheetSegs(state), before, "no new sheet window materialized for a .txt");
});
