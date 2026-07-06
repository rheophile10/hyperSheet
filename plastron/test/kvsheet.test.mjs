import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, setPainter } from "../dist/index.js";

// kvsheet — the key-value worksheet over NAMED cels (kv-sheet.md).
//
// Rows are real named ValueCels/FormulaCels (`p1.rate`, metadata.segment =
// the sheet's segment); the roster lives in `<seg>.keys`; kv.mint / kv.retire
// update the roster AND rewrite every kvsheet view formula so each row's
// value is a spliced live reference (the reactive-set rule — a formula can't
// reference a dynamic key set). `=kvsheet('p1', 0, 0)` bootstraps from
// nothing: the first mint creates the roster and rewires.

const boot = async () => {
  const state = createInitialState();
  setPainter(state, { enqueue: () => {}, drain: () => {}, flush: () => {} });
  await resolveFn(state, "ensureSegments")(state, ["sheets", "sheet", "dom"]);
  await resolveFn(state, "hydrate")(state, [], []);
  return state;
};

const walk = (n, p, out = []) => { if (n && typeof n === "object") { if (n.type === "el" && p(n)) out.push(n); for (const c of n.children ?? []) walk(c, p, out); } return out; };
const cls = (n, c) => new RegExp(`(^| )${c}( |$)`).test(String(n.attrs?.class ?? ""));
const byClass = (root, c) => walk(root, (n) => cls(n, c));
const vtxt = (n) => (n?.type === "text" ? n.text : (n?.children ?? []).map(vtxt).join(""));

// ── the renderer, pure ────────────────────────────────────────────────────────

test("kvsheet renders roster rows (name, live value input, retire) + the composer, from spliced pairs", async () => {
  const state = await boot();
  const pane = resolveFn(state, "kvsheet")("p1", ["rate", "cfg"], "p1.rate", "p1.rate", 5, "p1.cfg", { a: 1 });
  const rows = byClass(pane, "kv-row").filter((r) => !cls(r, "kv-composer"));
  assert.equal(rows.length, 2, "one row per roster name");
  const [rate, cfg] = rows;
  assert.equal(vtxt(byClass(rate, "kv-key")[0]), "rate", "the row shows the SHORT name");
  assert.equal(byClass(rate, "kv-val")[0].attrs.value, "5", "the value input carries the spliced value");
  assert.equal(byClass(cfg, "kv-val")[0].attrs.value, '{"a":1}', "a dict value renders by the collections rules (JSON text)");
  assert.ok(cls(rate, "selected") && /outline/.test(String(rate.attrs.style)), "opts (the selected key) highlights its row");
  // wiring: select → formula bar, edit → kv.set, retire → kv.retire
  assert.deepEqual(byClass(rate, "kv-key")[0].events?.click, { dispatch: "origin.select", payload: "p1.rate" });
  assert.equal(byClass(rate, "kv-val")[0].events?.change?.dispatch, "kv.set");
  assert.equal(byClass(rate, "kv-val")[0].events?.change?.payload, "p1.rate");
  assert.equal(byClass(rate, "kv-val")[0].events?.keydown?.dispatch, "kv.set");
  assert.deepEqual(byClass(rate, "kv-del")[0].events?.click, { dispatch: "kv.retire", payload: { seg: "p1", name: "rate" } });
  // the composer: name/value drafts + ➕ (and Enter) mint
  const composer = byClass(pane, "kv-composer")[0];
  assert.deepEqual(byClass(composer, "kv-name")[0].events?.input, { set: "kv.name", extract: "value" });
  assert.deepEqual(byClass(composer, "kv-value")[0].events?.input, { set: "kv.value", extract: "value" });
  assert.deepEqual(byClass(composer, "kv-value")[0].events?.keydown, { dispatch: "kv.mint", payload: "p1" });
  assert.deepEqual(byClass(composer, "kv-add")[0].events?.click, { dispatch: "kv.mint", payload: "p1" });
  // bootstrap form: no roster yet → composer only
  const empty = resolveFn(state, "kvsheet")("p1", 0, 0);
  assert.equal(byClass(empty, "kv-row").filter((r) => !cls(r, "kv-composer")).length, 0, "0-roster renders composer only");
});

// ── mint: roster + named cel + view-formula rewrite, from a bare bootstrap ────

const VIEW = "p1pane.view";
const wire = async (state) => {
  await resolveFn(state, "setCel")(state, VIEW, {
    celType: "FormulaCel", f: "=kvsheet('p1', 0, 0)",
    metadata: { key: VIEW, segment: "p1pane", name: "view", parser: "infix" },
  });
  await resolveFn(state, "runCycle")(state);
};
const mint = async (state, name, value) => {
  await resolveFn(state, "setValue")(state, "kv.name", name);
  await resolveFn(state, "setValue")(state, "kv.value", value);
  await resolveFn(state, "kv.mint")(state, "p1");
};
const rowFor = (state, key) => byClass(state.cels.get(VIEW).v, "kv-row").find((r) => r.attrs["data-key"] === key);

test("kv.mint bootstraps the roster, mints the named cel in the SHEET's segment, and rewires the view formula", async () => {
  const state = await boot();
  await wire(state);
  assert.equal(state.cels.get("p1.keys"), undefined, "no roster before the first mint");
  await mint(state, "rate", "0.5");
  const roster = state.cels.get("p1.keys");
  assert.deepEqual(roster.v, ["rate"], "the roster appended the short name");
  assert.equal(roster.metadata.segment, "p1", "the roster archives with the sheet's segment");
  const cel = state.cels.get("p1.rate");
  assert.equal(cel.v, 0.5, "numeric entry → a number ValueCel");
  assert.equal(cel.metadata.segment, "p1", "the row cel archives with the sheet's segment");
  assert.equal(state.cels.get(VIEW).f, "=kvsheet('p1', p1.keys, 0, 'p1.rate', p1.rate)",
    "the view formula now references the roster + the row cel (the reactive-set rewrite)");
  assert.equal(byClass(rowFor(state, "p1.rate"), "kv-val")[0].attrs.value, "0.5", "the pane re-derived with the row");
  assert.equal(state.cels.get("kv.name").v, "", "composer name draft cleared");
  assert.equal(state.cels.get("kv.value").v, "", "composer value draft cleared");
});

test("entry rules: { / [ parse as JSON data; = mints a live FormulaCel row", async () => {
  const state = await boot();
  await wire(state);
  await mint(state, "rate", "0.5");
  await mint(state, "cfg", '{"fps": 30, "trail": [1, 2]}');
  assert.deepEqual(state.cels.get("p1.cfg").v, { fps: 30, trail: [1, 2] }, "JSON entry → the parsed object IS the value");
  assert.equal(state.cels.get("p1.cfg").celType, "ValueCel", "JSON entry is DATA tier (writable), not a formula");
  await mint(state, "twice", "=p1.rate * 2");
  assert.equal(state.cels.get("p1.twice").celType, "FormulaCel");
  assert.equal(state.cels.get("p1.twice").v, 1, "the minted formula fired (0.5 * 2)");
  assert.deepEqual(state.cels.get("p1.keys").v, ["rate", "cfg", "twice"]);
  assert.equal(byClass(rowFor(state, "p1.cfg"), "kv-val")[0].attrs.value, '{"fps":30,"trail":[1,2]}', "dict row renders as JSON text");
});

test("kv.set commits by the entry rules; same-tier edits cascade through the spliced refs", async () => {
  const state = await boot();
  await wire(state);
  await mint(state, "rate", "0.5");
  await mint(state, "twice", "=p1.rate * 2");
  // a change-event commit (no .key on the event)
  await resolveFn(state, "kv.set")(state, "p1.rate", { target: { value: "0.75" } });
  assert.equal(state.cels.get("p1.rate").v, 0.75);
  assert.equal(state.cels.get("p1.twice").v, 1.5, "the dependent formula row re-derived");
  assert.equal(byClass(rowFor(state, "p1.twice"), "kv-val")[0].attrs.value, "1.5", "…and the pane shows it (the ref cascade)");
  // keydown guard: only Enter commits
  await resolveFn(state, "kv.set")(state, "p1.rate", { key: "a", target: { value: "999" } });
  assert.equal(state.cels.get("p1.rate").v, 0.75, "a non-Enter keydown is a no-op");
  await resolveFn(state, "kv.set")(state, "p1.rate", { key: "Enter", target: { value: "2" } });
  assert.equal(state.cels.get("p1.rate").v, 2, "Enter commits");
  // tier swaps: value → formula → value
  await resolveFn(state, "kv.set")(state, "p1.rate", { target: { value: "=3 * 3" } });
  assert.equal(state.cels.get("p1.rate").celType, "FormulaCel");
  assert.equal(state.cels.get("p1.rate").v, 9, "promoted to a formula and fired");
  await resolveFn(state, "kv.set")(state, "p1.rate", { target: { value: "42" } });
  assert.equal(state.cels.get("p1.rate").celType, "ValueCel");
  assert.equal(state.cels.get("p1.rate").v, 42, "demoted back to data");
});

test("kv.retire removes the row everywhere; a surviving consumer traps undefined-symbol (no guardrails)", async () => {
  const state = await boot();
  await wire(state);
  await mint(state, "rate", "0.5");
  await mint(state, "cfg", "7");
  await mint(state, "twice", "=p1.rate * 2");
  await resolveFn(state, "kv.retire")(state, { seg: "p1", name: "cfg" });
  assert.equal(state.cels.get("p1.cfg"), undefined, "the cel is GONE");
  assert.deepEqual(state.cels.get("p1.keys").v, ["rate", "twice"], "the roster dropped the name");
  assert.ok(!state.cels.get(VIEW).f.includes("p1.cfg"), "the view formula dropped the pair");
  assert.equal(rowFor(state, "p1.cfg"), undefined, "the pane dropped the row");
  assert.ok(rowFor(state, "p1.rate") && rowFor(state, "p1.twice"), "other rows survive");
  // deletion doctrine: retiring a cel a FORMULA still references is allowed —
  // the survivor RE-FIRES against the defanged ref, honestly (its compiled
  // closure sees undefined: arithmetic coerces to 0 today; a recompile traps
  // undefined-symbol). Either way it no longer derives from the dead cel.
  await resolveFn(state, "kv.retire")(state, { seg: "p1", name: "rate" });
  assert.equal(state.cels.get("p1.rate"), undefined);
  const tv = state.cels.get("p1.twice").v;
  const honest = tv === 0 || (tv && typeof tv === "object" && tv.kind === "error");
  assert.ok(honest, `the orphaned =p1.rate*2 row re-derived from the missing ref (${JSON.stringify(tv)?.slice(0, 80)})`);
});
