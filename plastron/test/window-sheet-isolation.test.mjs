import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, setAccessPolicy, bundleSegments, isDenied, canGet, canSet } from "../dist/index.js";

// ============================================================================
// window-sheet-isolation — the demo-level proof of the Layer-1 closure model.
// Each window's sheet is its own private segment (a closure). A formula in one
// window's sheet CANNOT get OR set a cel in another window's sheet: the kernel
// substitutes #DENIED at input resolution and refuses the cross-segment write.
// TABBING / LINKING the windows (bundleSegments — exactly what winsheet.drop and
// winx.drop do) is the ONLY thing that opens shared memory between them.
// ============================================================================
const seg = (state, key, spec) => resolveFn(state, "setCel")(state, key, { ...spec, metadata: { key, ...spec.metadata } });
const cycle = (state) => resolveFn(state, "runCycle")(state);

const twoWindows = async () => {
  const state = createInitialState();
  await seg(state, "winB.A1", { celType: "ValueCel", v: 42, metadata: { segment: "winB", name: "A1" } });
  setAccessPolicy(state, "winB", { get: "private", set: "private" }); // window B's sheet is a closure
  setAccessPolicy(state, "winA", { get: "private", set: "private" }); // so is window A's
  return state;
};

test("a formula in window A's sheet CANNOT read a cel in window B's sheet", async () => {
  const state = await twoWindows();
  await seg(state, "winA.B1", { celType: "FormulaCel", f: "winB.A1", metadata: { segment: "winA", name: "B1", parser: "f" } });
  await cycle(state);
  const v = state.cels.get("winA.B1")?.v;
  assert.ok(isDenied(v), `winA reading winB.A1 must be #DENIED (got ${JSON.stringify(v)})`);
  assert.notEqual(v, 42, "the value never crosses the window boundary");
});

test("window A CANNOT set a cel in window B's sheet (and vice-versa)", async () => {
  const state = await twoWindows();
  assert.equal(canSet(state, "winA", "winB"), false, "cross-window write refused");
  assert.equal(canGet(state, "winA", "winB"), false, "cross-window read refused");
  assert.equal(canSet(state, "winB", "winB"), true, "a window writes its OWN sheet");
});

test("TABBING / LINKING the windows opens shared memory — the only opener", async () => {
  const state = await twoWindows();
  assert.equal(canGet(state, "winA", "winB"), false, "before: isolated closures");
  bundleSegments(state, ["winA", "winB"]); // what winsheet.drop / winx.drop do on a stack
  assert.equal(canGet(state, "winA", "winB"), true, "after tab/link: winA reads winB");
  await seg(state, "winA.B1", { celType: "FormulaCel", f: "winB.A1", metadata: { segment: "winA", name: "B1", parser: "f" } });
  await cycle(state);
  assert.equal(state.cels.get("winA.B1")?.v, 42, "linked windows share cels");
});
