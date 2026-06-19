import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } from "../dist/index.js";
import { lockConsent, setConsent } from "../dist/kernel/index.js";

// cdn-consent — =cdn(url) loads code/data from a CDN; it's `dangerous: net`, so in
// a LOCKED (shared/URL) session it must be CONSENTED. Own session → trusted.
// (Closes the gap: originCdn was missing from the drain's consent `verbOf` map.)

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
    for (let i = 0; i < 5; i++) { await resolveFn(state, "runCycle")(state); if (state.cels.get("origin.effects")) await resolveFn(state, "drain")(state, "origin.effects"); }
  };
  const val = () => String(state.cels.get("元")?.v ?? "");
  return { state, put, val };
};

const CDN = '=cdn("https://cdn.jsdelivr.net/npm/canvas-confetti")';

test("own (unlocked) session: =cdn runs without a consent prompt", async () => {
  const { put, val } = await boot();
  await put(CDN);
  assert.match(val(), /^loaded /, "own session is trusted");
});

test("LOCKED (shared/URL) session: =cdn is BLACKLISTED until consented", async () => {
  const { state, put, val } = await boot();
  lockConsent(state); // what bootFromHash does for a #f= / #raw= shared sheet

  await put(CDN);
  assert.match(val(), /#BLACKLISTED\(cdn/, "a pasted formula can't load a CDN without consent");
  assert.match(val(), /consentpanel/, "points the user at the consent panel");

  // the user consents to cdn, then it runs
  setConsent(state, "cdn", { allow: true, category: "net" });
  await put(CDN);
  assert.match(val(), /^loaded /, "after consent, the CDN load proceeds");
});
