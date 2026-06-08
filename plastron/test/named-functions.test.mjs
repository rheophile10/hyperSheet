import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, buildSheet } from "../dist/index.js";

// named-functions — the binder gesture from named-function-cels.md.
// `=JS(A1, "times100")` / `(js src "times100")` is a BINDER: its value is a
// definition request, committed by the defn segment's drain as an
// EditableLambdaCel named "times100" (metadata.definedBy = the binder,
// metadata.origin = the source cel). Ownership rules + the orphan sweep:
// binders are authoritative for a name's existence.

const v = (state, key) => state.cels.get(key)?.v;
const fns = (state) => ({
  setCel: resolveFn(state, "setCel"),
  setValue: resolveFn(state, "setValue"),
  drain: resolveFn(state, "drain"),
  runCycle: resolveFn(state, "runCycle"),
});
// setCel computes a new formula at the NEXT cycle (affectedFor is strict-
// descendants); cycle, then drain the definition channel.
const cycleAndFlush = async (state) => {
  await resolveFn(state, "runCycle")(state);
  return resolveFn(state, "drain")(state, "defn.commit");
};
const flushDefn = (state) => resolveFn(state, "drain")(state, "defn.commit");
const isErr = (x) => !!x && typeof x === "object" && x.kind === "error";

const seedUser = async (state, key, spec) =>
  resolveFn(state, "setCel")(state, key, { ...spec, metadata: { segment: "user", ...spec.metadata } });

// ── S-expression binder: bind → call → edit source → caller updates ─────────

test("S-expr binder: (js src \"times100\") creates the lambda; callers fire and track edits", async () => {
  const state = createInitialState();
  const { setValue } = fns(state);

  await seedUser(state, "src", { celType: "ValueCel", v: "(x) => x * 100" });
  await seedUser(state, "binder", { celType: "FormulaCel", f: '(js src "times100")' });
  await cycleAndFlush(state);

  const lam = state.cels.get("times100");
  assert.ok(lam, "drain committed the named lambda");
  assert.equal(lam.celType, "EditableLambdaCel");
  assert.equal(lam.metadata.kind, "js");
  assert.equal(lam.metadata.definedBy, "binder", "ownership stamped");
  assert.equal(lam.metadata.origin, "src", "source-cell provenance stamped");
  assert.equal(resolveFn(state, "times100")(7), 700, "registry dispatch works");

  // a formula can call the user symbol
  await seedUser(state, "caller", { celType: "FormulaCel", f: "(times100 7)" });
  await precomputeOptional(state);
  await fns(state).runCycle(state);
  assert.equal(v(state, "caller"), 700, "(times100 7) = 700");

  // editing the SOURCE re-fires the binder; the drain recommits; the
  // defGeneration bump recompiles the caller.
  await setValue(state, "src", "(x) => x * 100 + 1");
  await flushDefn(state);
  assert.equal(v(state, "caller"), 701, "caller tracks redefinition");
});

// ── infix binder on a sheet: the doc's worked example ───────────────────────

const bootSheet = async (cells) => {
  const state = createInitialState();
  const hydrate = resolveFn(state, "hydrate");
  const seg = buildSheet({ rows: 4, cols: 4, cells });
  await hydrate(state, [seg], [seg]);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  return state;
};

test("infix binder: =JS(A1, \"times100\") + =times100(7) on a sheet", async () => {
  const state = await bootSheet({
    A1: "(x) => x * 100",
    B1: '=JS(A1, "times100")',
    C1: "=times100(7)",
  });
  await flushDefn(state);

  const lam = state.cels.get("times100");
  assert.ok(lam, "binder cell committed the definition");
  assert.equal(lam.metadata.definedBy, "sheet.B1");
  assert.equal(lam.metadata.origin, "sheet.A1");
  assert.equal(v(state, "sheet.C1"), 700, "user symbol dispatches in infix");

  // edit the source cell — binder refires, callers recompute
  await fns(state).setValue(state, "sheet.A1", "(x) => x * 200");
  await flushDefn(state);
  assert.equal(v(state, "sheet.C1"), 1400, "caller tracks source edit");
});

test("sheet.commit-cell drains defn.commit itself — bind then call, no manual flush", async () => {
  const state = await bootSheet({ A1: "(x) => x + 1" });
  const commit = resolveFn(state, "sheet.commit-cell");
  await commit(state, { addr: "B1", input: '=JS(A1, "incr")' });
  assert.ok(state.cels.get("incr"), "definition committed by the action itself");
  await commit(state, { addr: "C1", input: "=incr(41)" });
  assert.equal(v(state, "sheet.C1"), 42, "next formula sees the function immediately");
});

test("calling an unbound symbol is a clean undefined-symbol error", async () => {
  const state = await bootSheet({ A1: "=nope(1)" });
  const a1 = v(state, "sheet.A1");
  assert.ok(isErr(a1), "trap-as-value on the caller");
  assert.match(a1.message, /undefined symbol/);
});

// ── ownership rules ──────────────────────────────────────────────────────────

test("own-name redefinition is flag-free; foreign name is refused; TRUE transfers ownership", async () => {
  const state = createInitialState();
  await seedUser(state, "srcA", { celType: "ValueCel", v: "(x) => x + 1" });
  await seedUser(state, "srcB", { celType: "ValueCel", v: "(x) => x - 1" });
  await seedUser(state, "binderA", { celType: "FormulaCel", f: '(js srcA "shift")' });
  await cycleAndFlush(state);
  assert.equal(resolveFn(state, "shift")(1), 2);

  // own-name redefinition: srcA edit recommits silently
  await fns(state).setValue(state, "srcA", "(x) => x + 10");
  await flushDefn(state);
  assert.equal(resolveFn(state, "shift")(1), 11, "owner redefines without a flag");

  // a second binder claiming the same name is refused
  await seedUser(state, "binderB", { celType: "FormulaCel", f: '(js srcB "shift")' });
  await cycleAndFlush(state);
  const b = v(state, "binderB");
  assert.ok(isErr(b), "collision traps the intruding binder");
  assert.match(b.message, /already defined by binderA/);
  assert.equal(resolveFn(state, "shift")(1), 11, "definition untouched");

  // TRUE takes ownership
  await fns(state).setCel(state, "binderB", {
    celType: "FormulaCel", f: '(js srcB "shift" true)', metadata: { segment: "user" },
  });
  await cycleAndFlush(state);
  assert.equal(resolveFn(state, "shift")(1), 0, "overwrite TRUE transfers the name");
  assert.equal(state.cels.get("shift").metadata.definedBy, "binderB", "ownership moved");

  // ...and now the ORIGINAL binder is the intruder
  await fns(state).setValue(state, "srcA", "(x) => x + 2");
  await flushDefn(state);
  const a = v(state, "binderA");
  assert.ok(isErr(a), "old owner collides after the transfer");
});

test("locked names are refused outright", async () => {
  const state = createInitialState();
  await seedUser(state, "src", { celType: "ValueCel", v: "(x) => x" });
  await seedUser(state, "binder", { celType: "FormulaCel", f: '(js src "setValue" true)' });
  await cycleAndFlush(state);
  const b = v(state, "binder");
  assert.ok(isErr(b), "binder traps");
  assert.match(b.message, /locked/);
  assert.equal(typeof resolveFn(state, "setValue"), "function", "kernel cel untouched");
});

// ── lifetime: binders are authoritative ─────────────────────────────────────

test("rename retires the old name; stale callers get undefined-symbol", async () => {
  const state = await bootSheet({
    A1: "(x) => x * 2",
    B1: '=JS(A1, "dbl")',
    C1: "=dbl(21)",
  });
  await flushDefn(state);
  assert.equal(v(state, "sheet.C1"), 42);

  // rename via the binder cell
  const commit = resolveFn(state, "sheet.commit-cell");
  await commit(state, { addr: "B1", input: '=JS(A1, "double")' });
  assert.ok(state.cels.get("double"), "new name committed");
  assert.equal(state.cels.get("dbl"), undefined, "old name retired in the same drain");

  const c1 = v(state, "sheet.C1");
  assert.ok(isErr(c1), "stale caller traps");
  assert.match(c1.message, /dbl.*undefined symbol|undefined symbol/);

  await commit(state, { addr: "C1", input: "=double(21)" });
  assert.equal(v(state, "sheet.C1"), 42, "caller recovers on the new name");
});

test("orphan sweep: a binder replaced by a plain formula retires its definition", async () => {
  const state = await bootSheet({
    A1: "(x) => x * 3",
    B1: '=JS(A1, "tri")',
  });
  await flushDefn(state);
  assert.ok(state.cels.get("tri"));

  const commit = resolveFn(state, "sheet.commit-cell");
  await commit(state, { addr: "B1", input: "=1+1" });
  assert.equal(state.cels.get("tri"), undefined, "no live binder → definition retired");
  assert.equal(v(state, "sheet.B1"), 2, "cell is an ordinary formula again");
});

test("hand-made EditableLambdaCels (no definedBy) are NOT swept", async () => {
  const state = createInitialState();
  await seedUser(state, "manual", { celType: "EditableLambdaCel", fn: (x) => x * 5, metadata: { kind: "custom" } });
  await flushDefn(state);
  assert.ok(state.cels.get("manual"), "unstamped lambdas are outside binder jurisdiction");
});

// ── persistence: the definition survives dehydrate → hydrate ────────────────

test("save/open round-trip: binder + definition + caller rehydrate and fire", async () => {
  const state = await bootSheet({
    A1: "(x) => x * 100",
    B1: '=JS(A1, "times100")',
    C1: "=times100(7)",
  });
  await flushDefn(state);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  assert.equal(v(state, "sheet.C1"), 700);

  const dehydrate = resolveFn(state, "dehydrate");
  const json = JSON.parse(JSON.stringify(await dehydrate(state)));
  const next = createInitialState();
  const hydrate = resolveFn(next, "hydrate");
  await hydrate(next, json.segments, json.manifests);
  await precomputeOptional(next);
  await resolveFn(next, "runCycle")(next);

  const lam = next.cels.get("times100");
  assert.ok(lam, "definition rehydrated from its own f source");
  assert.equal(lam.metadata.definedBy, "sheet.B1", "ownership survives the round-trip");
  assert.equal(v(next, "sheet.C1"), 700, "caller fires after rehydration");
});
