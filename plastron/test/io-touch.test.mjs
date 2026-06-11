import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// io-touch — a virtual-key overlay producing the SAME io-keys cels.
const v = (s, k) => s.cels.get(k)?.v;

test("touch.press/release write keys.pressed through keys.capture (one code path)", async () => {
  const s = createInitialState();
  await resolveFn(s, "touch.press")(s, "ArrowUp");
  assert.deepEqual(v(s, "keys.pressed"), { ArrowUp: true });
  assert.equal(v(s, "keys.event").type, "down");
  assert.equal(v(s, "keys.event").key, "ArrowUp");
  await resolveFn(s, "touch.press")(s, "KeyA");
  assert.deepEqual(v(s, "keys.pressed"), { ArrowUp: true, KeyA: true }, "holds accumulate");
  await resolveFn(s, "touch.release")(s, "ArrowUp");
  assert.deepEqual(v(s, "keys.pressed"), { KeyA: true }, "release removes");
});

test("touchpad renders hold-buttons bound to touch.press/release", () => {
  const s = createInitialState();
  const pad = resolveFn(s, "touchpad")([{ label: "↑", key: "ArrowUp" }, { label: "A", key: "KeyA" }]);
  assert.equal(pad.children.length, 2);
  assert.equal(pad.children[0].events.pointerdown.dispatch, "touch.press");
  assert.equal(pad.children[0].events.pointerdown.payload, "ArrowUp");
  assert.equal(pad.children[0].events.pointerup.dispatch, "touch.release");
});
