import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";
import { layout, relax, separateLabels, labelsOverlap, FG_W, FG_H } from "../dist/甲骨坑/library/forcegraph/index.js";

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

test("label anti-collision: a pass separates two colliding labels until their boxes no longer overlap", () => {
  // two long-labelled nodes dropped on top of each other — their label PILLS
  // collide even though they share a point. separateLabels must spread them.
  const spec = {
    nodes: [
      { key: "wikipedia-the-free-encyclopedia", label: "Wikipedia, the free encyclopedia", size: 1 },
      { key: "encyclopaedia-britannica", label: "Encyclopaedia Britannica", size: 1 },
    ],
    edges: [],
  };
  const pos = { [spec.nodes[0].key]: [500, 230], [spec.nodes[1].key]: [504, 232] };
  assert.equal(labelsOverlap(spec, pos), true, "the two labels start overlapping");
  const ok = separateLabels(spec, pos, new Set(), 200);
  assert.equal(ok, true, "separateLabels reports overlap-free");
  assert.equal(labelsOverlap(spec, pos), false, "the labels no longer overlap after the pass");
  for (const n of spec.nodes) {
    const [x, y] = pos[n.key];
    assert.ok(x >= 16 && x <= FG_W - 16 && y >= 14 && y <= FG_H - 14, `${n.key} stayed in bounds`);
  }
});

test("layout: the full pipeline leaves labels non-overlapping", () => {
  // crowd many long labels; layout() runs relax + the label-separation pass.
  const spec = {
    nodes: Array.from({ length: 8 }, (_, i) => ({ key: `node-${i}`, label: `A long label number ${i}`, size: 1 })),
    edges: Array.from({ length: 7 }, (_, i) => [`node-${i}`, `node-${i + 1}`]),
    pin: "node-0",
  };
  const pos = layout(spec);
  assert.equal(labelsOverlap(spec, pos), false, "no two label boxes overlap after layout");
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

test("the wheel convention: unarmed wheel is ignored; click-to-arm owns it", async () => {
  const state = await boot();
  await resolveFn(state, "fg.set")(state, { id: "t4", spec: SPEC });
  // unarmed: the wheel passes through to the page (zoom untouched)
  await resolveFn(state, "fg.wheel")(state, "t4", { deltaY: -120 });
  assert.equal(state.cels.get("fg.t4.zoom").v, 1, "unarmed wheel ignored");
  // click into the graph → armed → the graph owns the wheel
  await resolveFn(state, "fg.arm")(state, "t4");
  assert.equal(state.cels.get("fg.t4.armed").v, 1, "armed");
  await resolveFn(state, "fg.wheel")(state, "t4", { deltaY: -120 });
  assert.ok(state.cels.get("fg.t4.zoom").v > 1, "zoomed in");
  // armed render claims the default; unarmed render does not
  const armedView = resolveFn(state, "fgview")("t4", SPEC, state.cels.get("fg.t4.pos").v, 1, 1);
  const idleView = resolveFn(state, "fgview")("t4", SPEC, state.cels.get("fg.t4.pos").v, 1, 0);
  assert.equal(armedView.events.wheel.prevent, true, "armed wheel binding claims preventDefault");
  assert.ok(!idleView.events.wheel.prevent, "idle wheel binding leaves scrolling alone");
  // pointer leaves → released
  await resolveFn(state, "fg.disarm")(state, "t4");
  assert.equal(state.cels.get("fg.t4.armed").v, 0, "disarmed on leave");
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
