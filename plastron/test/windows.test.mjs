import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// windows — draggable/resizable window frames (windows-segment.md stage 1).
// Geometry lives in cels; the drag/resize dispatch handlers setValue them.
const setCel = (s, k, v) => resolveFn(s, "setCel")(s, k, { celType: "ValueCel", v, metadata: { key: k, segment: "app" } });
const val = (s, k) => s.cels.get(k)?.v;
const cap = { setPointerCapture() {} };

test("window(...) renders a frame with a draggable titlebar bound to win.grab", () => {
  const s = createInitialState();
  const frame = resolveFn(s, "window")("w1", 100, 80, 320, 200, "Sheet", "hello");
  assert.equal(frame.type, "el");
  assert.match(frame.attrs.style, /left:100px/);
  assert.match(frame.attrs.style, /top:80px/);
  const titlebar = frame.children.find((c) => c.attrs?.class === "pl-titlebar");
  assert.equal(titlebar.events.pointerdown.dispatch, "win.grab");
  assert.equal(titlebar.events.pointerdown.payload, "w1");
});

test("dragging the titlebar updates the window's x/y cels, drop ends it", async () => {
  const s = createInitialState();
  await setCel(s, "w1.x", 100); await setCel(s, "w1.y", 80);
  const grab = resolveFn(s, "win.grab"), move = resolveFn(s, "win.move"), drop = resolveFn(s, "win.drop");
  await grab(s, "w1", { clientX: 150, clientY: 120, pointerId: 1, currentTarget: cap });
  assert.deepEqual(val(s, "win.drag"), { key: "w1", ox: 50, oy: 40 });
  await move(s, null, { clientX: 200, clientY: 160 });
  assert.equal(val(s, "w1.x"), 150); assert.equal(val(s, "w1.y"), 120);
  await drop(s);
  assert.equal(val(s, "win.drag"), null);
  await move(s, null, { clientX: 300, clientY: 300 }); // no-op after drop
  assert.equal(val(s, "w1.x"), 150);
});

test("dragging the corner handle resizes (min 120x80)", async () => {
  const s = createInitialState();
  await setCel(s, "w1.w", 320); await setCel(s, "w1.h", 200);
  const grab = resolveFn(s, "win.grabResize"), move = resolveFn(s, "win.resizeMove");
  await grab(s, "w1", { clientX: 500, clientY: 400, pointerId: 1, currentTarget: cap });
  await move(s, null, { clientX: 600, clientY: 450 });
  assert.equal(val(s, "w1.w"), 420); assert.equal(val(s, "w1.h"), 250);
  await move(s, null, { clientX: 100, clientY: 100 }); // clamp
  assert.equal(val(s, "w1.w"), 120); assert.equal(val(s, "w1.h"), 80);
});

test("z-order: win.raise bumps the window's z above the previously-raised one", async () => {
  const s = createInitialState();
  const raise = resolveFn(s, "win.raise");
  await raise(s, "w1"); const z1 = val(s, "w1.z");
  await raise(s, "w2"); const z2 = val(s, "w2.z");
  await raise(s, "w1"); const z1b = val(s, "w1.z");
  assert.ok(z2 > z1, "w2 raised above w1");
  assert.ok(z1b > z2, "raising w1 again puts it on top");
  // the window frame renders the z as z-index
  const frame = resolveFn(s, "window")("w1", 0, 0, 100, 100, "T", "x", z1b);
  assert.match(frame.attrs.style, new RegExp(`z-index:${z1b}`));
});

test("z-unify: winx.raise and winsheet.raise share win.topz — the later raise wins", async () => {
  const s = createInitialState();
  // a state-cel window (winx.*) and a worksheet window (winsheet.*) raise
  // against the SAME win.topz fountain (seeded 100), so the second wins.
  await resolveFn(s, "setCel")(s, "win.a.state", { celType: "ValueCel", v: { ref: "win.a.state", x: 0, y: 0, w: 200, h: 200, z: 1 }, metadata: { segment: "win.a", name: "state" } });
  await resolveFn(s, "setCel")(s, "win.geom", { celType: "ValueCel", v: { turtles: { x: 0, y: 0 } }, metadata: { segment: "sheet-host", name: "geom" } });
  assert.equal(val(s, "win.topz"), 100, "seeded fountain default");
  await resolveFn(s, "winx.raise")(s, "win.a.state");
  const zX = s.cels.get("win.a.state").v.z;
  assert.equal(zX, 101, "winx.raise bumped win.topz to 101 and used it");
  assert.equal(val(s, "win.topz"), 101, "shared fountain advanced");
  // now a worksheet window raises — must beat the state-cel window
  await resolveFn(s, "winsheet.raise")(s, "turtles");
  const zSheet = s.cels.get("win.geom").v.turtles.z;
  assert.equal(zSheet, 102, "winsheet.raise read the SAME fountain → 102 (above the state-cel window)");
  assert.ok(zSheet > zX, "the later worksheet raise sits above the earlier state-cel raise");
  // and back the other way: a state-cel raise now tops the worksheet
  await resolveFn(s, "winx.raise")(s, "win.a.state");
  assert.equal(s.cels.get("win.a.state").v.z, 103, "state-cel raise climbs above the worksheet");
});

test("min: winframe returns the hidden stub when state.min (not just state.closed)", () => {
  const frame = resolveFn(createInitialState(), "winframe");
  const minned = frame({ ref: "win.x.state", title: "X", min: 1 }, "win.x.state", "body");
  assert.match(String(minned.attrs.style ?? ""), /display:none/, "minimized state-cel window hides");
  assert.equal(minned.attrs.class, "pl-window-min", "renders the same min stub as the worksheet frame");
  // a non-min window renders visibly
  const open = frame({ ref: "win.x.state", title: "X" }, "win.x.state", "body");
  assert.equal(open.attrs.class.includes("pl-window-min"), false, "an un-minimized window renders its frame");
});

import { snapRegion } from "../dist/甲骨坑/library/windows/index.js";
test("snapRegion: edge tiling geometry (half / maximize / quarter / none)", () => {
  assert.deepEqual(snapRegion(5, 300, 1000, 600), { x: 0, y: 0, w: 500, h: 600 }, "left half");
  assert.deepEqual(snapRegion(995, 300, 1000, 600), { x: 500, y: 0, w: 500, h: 600 }, "right half");
  assert.deepEqual(snapRegion(500, 5, 1000, 600), { x: 0, y: 0, w: 1000, h: 600 }, "top → maximize");
  assert.deepEqual(snapRegion(5, 5, 1000, 600), { x: 0, y: 0, w: 500, h: 300 }, "top-left quarter");
  assert.equal(snapRegion(500, 300, 1000, 600), null, "interior → no snap");
  assert.equal(snapRegion(5, 300, 0, 0), null, "no viewport → no snap");
});

test("registry + toolbar: winopen registers + seeds geometry; minimize/restore toggle min", async () => {
  const s = createInitialState();
  await resolveFn(s, "winopen")(s, "w1", "Sheet");
  await resolveFn(s, "winopen")(s, "w2", "Canvas");
  assert.deepEqual(val(s, "win.list"), ["w1", "w2"], "both registered");
  assert.equal(val(s, "w1.w"), 320, "geometry seeded");
  assert.equal(val(s, "w1.title"), "Sheet");
  await resolveFn(s, "win.minimize")(s, "w1");
  assert.equal(val(s, "w1.min"), 1, "minimized");
  // a minimized window renders hidden
  const hidden = resolveFn(s, "window")("w1", 0, 0, 100, 100, "Sheet", "x", 1, 1);
  assert.match(hidden.attrs.style, /display:none/);
  await resolveFn(s, "win.restore")(s, "w1");
  assert.equal(val(s, "w1.min"), 0, "restored");
  // toolbar renders a chip per window → win.restore
  const bar = resolveFn(s, "wintoolbar")(["w1", "w2"], ["Sheet", "Canvas"]);
  assert.equal(bar.children.length, 2);
  assert.equal(bar.children[0].events.click.dispatch, "win.restore");
  await resolveFn(s, "winclose")(s, "w1");
  assert.deepEqual(val(s, "win.list"), ["w2"], "closed");
});
