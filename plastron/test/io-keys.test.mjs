import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// io-keys — input as data through cels (io-keys.md). A test is just another
// producer: call keys.capture with a fake event, observe keys.event/pressed +
// the routed dispatch.
const cap = (s, e) => resolveFn(s, "keys.capture")(s, null, e);
const v = (s, k) => s.cels.get(k)?.v;

test("keys.capture writes keys.event + maintains keys.pressed (down adds, up removes)", async () => {
  const s = createInitialState();
  await cap(s, { type: "keydown", key: "a", code: "KeyA", target: {} });
  assert.equal(v(s, "keys.event").key, "a");
  assert.equal(v(s, "keys.event").type, "down");
  assert.deepEqual(v(s, "keys.pressed"), { a: true });
  await cap(s, { type: "keydown", key: "b", target: {} });
  assert.deepEqual(v(s, "keys.pressed"), { a: true, b: true });
  await cap(s, { type: "keyup", key: "a", target: {} });
  assert.deepEqual(v(s, "keys.pressed"), { b: true });
  await resolveFn(s, "keys.blur")(s);
  assert.deepEqual(v(s, "keys.pressed"), {}, "blur clears the held set");
});

test("keys.route dispatches the active app's keymap action; skips shortcuts while editable unless inEditable", async () => {
  const s = createInitialState();
  let fired = [];
  await resolveFn(s, "setCel")(s, "app.commit", { celType: "LockedLambdaCel", fn: () => { fired.push("commit"); }, metadata: { segment: "app", kind: "native" } });
  await resolveFn(s, "setCel")(s, "keys.map.app", { celType: "ValueCel", v: [{ key: "Enter", action: "app.commit", inEditable: true }], metadata: { key: "keys.map.app", segment: "app" } });
  await resolveFn(s, "setValue")(s, "keys.active", "app");
  // Enter in an editable target → fires (inEditable: true)
  await cap(s, { type: "keydown", key: "Enter", target: { tagName: "TEXTAREA" } });
  assert.deepEqual(fired, ["commit"], "inEditable binding fires in a textarea");
  // a binding WITHOUT inEditable does not fire while editable
  fired = [];
  await resolveFn(s, "setCel")(s, "keys.map.app", { celType: "ValueCel", v: [{ key: "x", action: "app.commit" }], metadata: { key: "keys.map.app", segment: "app" } });
  await cap(s, { type: "keydown", key: "x", target: { tagName: "INPUT" } });
  assert.deepEqual(fired, [], "non-inEditable shortcut suppressed while typing");
  // …but fires when NOT editable
  await cap(s, { type: "keydown", key: "x", target: {} });
  assert.deepEqual(fired, ["commit"], "fires outside an editable target");
});
