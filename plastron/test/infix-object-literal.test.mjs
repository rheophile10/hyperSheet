import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn, buildSheet } from "../dist/index.js";

// infix object literal — { key: expr, "hyphen-key": expr }. Evaluates to a
// plain object VALUE; values are full expressions so a cel ref inside stays a
// real dependency (reactive). style()/attr() accept such an object (splat).

const v = (s, k) => s.cels.get(k)?.v;

const boot = async (cells) => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["dom"]);
  const seg = buildSheet({ rows: 6, cols: 4, cells });
  await resolveFn(state, "hydrate")(state, [seg], [seg]);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  return state;
};

test("object literal evaluates, wires cel refs, and feeds style()/dom()", async () => {
  const state = await boot({
    A1: "tomato",
    B1: '={color: "blue", "font-size": "12px"}',     // a bare object value
    B2: "=style({color: A1, margin: '0'})",          // object → style, with a CEL REF
    B3: "=dom('h1', style({color: 'red'}), 'hi')",   // style object inside dom
  });

  // 1) a plain object value (hyphenated key via string).
  assert.deepEqual(v(state, "sheet.B1"), { color: "blue", "font-size": "12px" });

  // 2) style() splats the object; the color came from A1.
  assert.deepEqual(v(state, "sheet.B2").__style, { color: "tomato", margin: "0" });

  // 3) the object feeds dom()'s element style.
  assert.equal(v(state, "sheet.B3").style.color, "red");

  // 4) REACTIVE: a cel ref inside the object literal is a real dependency.
  await resolveFn(state, "setValue")(state, "sheet.A1", "green");
  await resolveFn(state, "runCycle")(state);
  assert.equal(v(state, "sheet.B2").__style.color, "green", "object-value cel ref recomputes");
});
