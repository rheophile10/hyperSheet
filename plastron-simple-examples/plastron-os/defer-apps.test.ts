import { test } from "bun:test";
import assert from "node:assert/strict";

// deferApps boot — sheets/notepad/doom setup runs on first launch, not at
// boot. Covers:
//   - boot leaves the deferred apps' cels uninstalled (home paints without)
//   - app-types are registered eagerly so file icons/extensions resolve
//   - first os.switch runs the app's setup, then activates it
//   - second os.switch doesn't re-run setup (cels survive, no duplicate work)
//   - os.launch with a doc also ensures the app first (file-open path)

const mkEl = (tag) => {
  const L = new Map();
  const el = {
    nodeType: 1, tag, tagName: tag.toUpperCase(), value: undefined, childNodes: [], attrs: {}, _L: L,
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
    fire(t, ev = {}) { for (const fn of [...(L.get(t) ?? [])]) fn({ type: t, target: el, ...ev }); },
  };
  return el;
};

const tick = () => new Promise((r) => setTimeout(r, 10));

test("deferApps: sheets uninstalled at boot, set up by first os.switch, not re-set-up by the second", async () => {
  const root = mkEl("app");
  globalThis.document = { createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }), querySelector: (s) => (s === "#app" ? root : null) };

  const { bootOS } = await import("./browser-main.ts");
  const { state } = await bootOS({ deferApps: true });
  const { resolveFn } = await import("../../plastron-simple/dist/index.js");
  const r = (k) => resolveFn(state, k);
  const get = (k) => r("getCel")(state, k)?.v;

  // Deferred: no sheets/doom cels yet; shell + explorer are live.
  assert.equal(state.cels.get("sheet.view"), undefined, "sheets view not installed at boot");
  assert.equal(state.cels.get("doom.view"), undefined, "doom view not installed at boot");
  assert.ok(state.cels.get("fe.view") ?? state.cels.get("fe.app-types"), "file-explorer is eager");
  assert.equal(get("os.active"), "home", "boots to home");

  // App-types registered eagerly (file icons/extensions work pre-launch).
  const types = get("fe.app-types");
  assert.equal(types?.sheets?.extension, "csv");
  assert.equal(types?.doom?.icon, "🎮");

  // First switch → setup runs, app activates.
  await r("os.switch")(state, "sheets");
  await tick();
  assert.equal(get("os.active"), "sheets");
  assert.ok(state.cels.get("sheet.view"), "sheets view installed by first launch");
  assert.ok(state.segments.get("sheets"), "sheets manifest hydrated");

  // Second switch → no duplicate setup (cel identity stable).
  const viewCel = state.cels.get("sheet.view");
  await r("os.exit")(state);
  await r("os.switch")(state, "sheets");
  await tick();
  assert.equal(state.cels.get("sheet.view"), viewCel, "second launch reuses the installed cels");

  // Notepad was eagerly ensured only if the README needed seeding; either
  // way os.launch with a doc must work (file-open path ensures the app).
  await r("os.exit")(state);
  const doc = `defer-${Date.now().toString(36)}.txt`;
  await r("os.launch")(state, "notepad", doc);
  await tick();
  assert.equal(get("os.active"), "notepad");
  assert.ok(state.cels.get("notepad.text"), "notepad installed via os.launch");
});
