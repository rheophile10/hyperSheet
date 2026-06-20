import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../dist/index.js";

// segnav — the auto navbar (segment switcher): =segnav() builds a nav from the live
// document segments; each item switches to its segment (origin.navOpen "seg:<name>").

const find = (n, p, o = []) => { if (n && typeof n === "object") { if (p(n)) o.push(n); for (const c of n.children ?? []) find(c, p, o); } return o; };
const mkEl = (t) => ({ nodeType: 1, tag: t, tagName: t.toUpperCase(), childNodes: [], attrs: {}, style: { props: {}, setProperty() {}, removeProperty() {} }, get firstChild() { return this.childNodes[0] ?? null; }, get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }, setAttribute() {}, removeAttribute() {}, appendChild(c) { this.childNodes.push(c); return c; }, removeChild(c) { return c; }, replaceChild(n, o) { return o; }, insertBefore(n) { this.childNodes.push(n); return n; }, replaceChildren(...c) { this.childNodes = [...c]; }, addEventListener() {}, removeEventListener() {} });

const boot = async () => {
  const root = mkEl("app");
  globalThis.document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }), querySelector: (s) => (s === "#app" ? root : null), addEventListener() {}, removeEventListener() {} };
  const q = [];
  const state = createInitialState();
  setPainter(state, createPainter(state, { raf: (cb) => q.push(cb), caf: () => {}, isBrowser: true, doc: globalThis.document, resolveMount: (x) => (x === "#app" ? root : null) }));
  await resolveFn(state, "ensureSegments")(state, ["origin"]);
  await resolveFn(state, "hydrate")(state, [], []);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  const put = async (src, key = "元") => {
    await resolveFn(state, "origin.edit")(state, key);
    await resolveFn(state, "setValue")(state, "元.draft", src);
    await resolveFn(state, "origin.commit")(state, key);
    for (let i = 0; i < 6; i++) { await resolveFn(state, "runCycle")(state); if (state.cels.get("genesis.commit")) await resolveFn(state, "drain")(state, "genesis.commit"); if (state.cels.get("origin.effects")) await resolveFn(state, "drain")(state, "origin.effects"); }
  };
  return { state, put };
};

test("=segnav() builds a switcher navbar over the live document segments", async () => {
  const { state, put } = await boot();
  await put('(cels 2 2 "books")', "books_gen");
  await put('=doom()', "doom_gen");
  await put('=segnav()', "n1");

  const nav = state.cels.get("n1")?.v;
  assert.ok(nav && typeof nav === "object" && nav.type === "el", "segnav returns a nav vnode");
  const switches = find(nav, (n) => n.events?.click?.dispatch === "origin.navOpen" && String(n.events.click.payload).startsWith("seg:"));
  const targets = switches.map((b) => String(b.events.click.payload));
  assert.ok(targets.includes("seg:books"), "an item switches to the books workbook");
  assert.ok(targets.includes("seg:wasm.doom"), "an item switches to the doom wasm window");
  // the substrate is NOT in the switcher
  assert.ok(!targets.some((t) => t === "seg:origin" || t === "seg:net"), "substrate segments are not switcher targets");
});

// NOTE: a full origin boot materialises the desktop's own windows (readme/music),
// which are role:user document segments too — so they appear in =segnav alongside
// user-created ones. Distinguishing boot chrome from user segments is a refinement
// (e.g. a role:"chrome" the desktop seed passes); listing them is acceptable for now.
