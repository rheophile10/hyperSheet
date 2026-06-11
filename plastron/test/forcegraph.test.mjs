import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";
import { layout, relax, FG_W, FG_H } from "../dist/甲骨坑/library/forcegraph/index.js";

// forcegraph — force-directed simulations as a reusable segment. Tests pin:
// the layout reaches overlap-free and FREEZES (relax reports settled),
// fg.set creates instance cels, drag handlers move the node under the
// pointer and relax the rest, drop settles to no-overlap, click-after-drag
// is suppressed, wheel zooms per instance.

const SPEC = {
  nodes: [
    { key: "a", size: 1.4 }, { key: "b", size: 1 }, { key: "c", size: 1 },
    { key: "d", size: 0.9 }, { key: "e", size: 1.1 }, { key: "f", size: 1 },
  ],
  edges: [["a", "b"], ["a", "c"], ["b", "d"], ["c", "e"], ["a", "f"]],
  pin: "a",
  onNode: { dispatch: "wiki.open" },
};

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

const fakeEvt = (x, y) => ({
  clientX: x, clientY: y, pointerId: 1,
  target: {
    setPointerCapture() {},
    closest: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: FG_W, height: FG_H }) }),
  },
});

const boot = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["docgraph"]); // pulls forcegraph via deps
  await resolveFn(state, "hydrate")(state, [], []);
  return state;
};

test("layout: overlap-free, pinned center, frozen (relax reports settled)", () => {
  const pos = layout(SPEC);
  assert.deepEqual(pos["a"], [FG_W / 2, FG_H / 2], "pin held at center");
  for (const n of SPEC.nodes) {
    const [x, y] = pos[n.key];
    assert.ok(x > 0 && x < FG_W && y > 0 && y < FG_H, `${n.key} in bounds`);
  }
  // settled: another relax pass with the same positions reports overlap-free
  assert.equal(relax(SPEC, pos, new Set(["a"]), 40), true, "frozen at no-overlap");
  // and no pair sits on top of another
  const keys = SPEC.nodes.map((n) => n.key);
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    assert.ok(dist(pos[keys[i]], pos[keys[j]]) > 20, `${keys[i]}↔${keys[j]} separated`);
  }
});

test("fg.set creates the instance cels and writes a frozen layout", async () => {
  const state = await boot();
  await resolveFn(state, "fg.set")(state, { id: "t1", spec: SPEC });
  assert.deepEqual(state.cels.get("fg.t1.spec").v.pin, "a");
  const pos = state.cels.get("fg.t1.pos").v;
  assert.equal(Object.keys(pos).length, 6);
  assert.equal(state.cels.get("fg.t1.zoom").v, 1);
});

test("drag: grab → move puts the node under the pointer; drop settles + freezes", async () => {
  const state = await boot();
  await resolveFn(state, "fg.set")(state, { id: "t2", spec: SPEC });
  await resolveFn(state, "fg.grab")(state, { id: "t2", key: "b" }, fakeEvt(100, 100));
  assert.equal(state.cels.get("fg.drag").v.key, "b");
  await resolveFn(state, "fg.move")(state, null, fakeEvt(800, 120));
  const mid = state.cels.get("fg.t2.pos").v;
  assert.ok(Math.abs(mid["b"][0] - 800) < 2 && Math.abs(mid["b"][1] - 120) < 2, "node follows the pointer");
  await resolveFn(state, "fg.drop")(state);
  assert.equal(state.cels.get("fg.drag").v, null, "drag cleared");
  const pos = state.cels.get("fg.t2.pos").v;
  assert.equal(relax(state.cels.get("fg.t2.spec").v, structuredClone(pos), new Set(["b"]), 40), true, "settled to no-overlap");
  assert.ok(state.cels.get("fg.lastMoved").v > 6, "travel recorded for click suppression");
});

test("click-after-drag suppressed; clean click re-dispatches onNode", async () => {
  const state = await boot();
  await resolveFn(state, "fg.set")(state, { id: "t3", spec: SPEC });
  await resolveFn(state, "setValue")(state, "fg.lastMoved", 50);
  await resolveFn(state, "fg.click")(state, { id: "t3", key: "b" });
  assert.notEqual(state.cels.get("wiki.current")?.v, "b", "drag-click suppressed");
  assert.equal(state.cels.get("fg.lastMoved").v, 0, "suppression resets");
  await resolveFn(state, "fg.click")(state, { id: "t3", key: "b" });
  assert.equal(state.cels.get("wiki.current")?.v, "b", "clean click dispatched spec.onNode (wiki.open)");
});

test("fg.wheel zooms the instance within bounds", async () => {
  const state = await boot();
  await resolveFn(state, "fg.set")(state, { id: "t4", spec: SPEC });
  await resolveFn(state, "fg.wheel")(state, "t4", { deltaY: -120 });
  assert.ok(state.cels.get("fg.t4.zoom").v > 1, "zoomed in");
  for (let i = 0; i < 30; i++) await resolveFn(state, "fg.wheel")(state, "t4", { deltaY: 120 });
  assert.ok(state.cels.get("fg.t4.zoom").v >= 0.35, "floor respected");
});

test("fgview renders edges canvas + draggable chips with the pin highlighted", async () => {
  const state = await boot();
  await resolveFn(state, "fg.set")(state, { id: "t5", spec: SPEC });
  const v = resolveFn(state, "fgview")("t5", state.cels.get("fg.t5.spec").v, state.cels.get("fg.t5.pos").v, 1);
  const find = (n, pred, out = []) => { if (n && typeof n === "object") { if (pred(n)) out.push(n); for (const k of n.children ?? []) find(k, pred, out); } return out; };
  const canvas = find(v, (n) => n.tag === "canvas")[0];
  assert.ok(JSON.parse(canvas.attrs["data-ops"]).length >= SPEC.edges.length, "edge ops");
  const chips = find(v, (n) => String(n.attrs?.class ?? "").startsWith("fg-node"));
  assert.equal(chips.length, 6);
  assert.ok(chips.every((c) => c.events?.pointerdown?.dispatch === "fg.grab"), "chips draggable");
  const pin = chips.find((c) => c.attrs.class.includes("fg-node-pin"));
  assert.match(pin.attrs.style, /left:50\.00%;top:50\.00%/, "pin at center");
});
