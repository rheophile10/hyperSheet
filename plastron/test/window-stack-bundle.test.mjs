import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, canGet, setAccessPolicy } from "../dist/index.js";

// ============================================================================
// window-stack-bundle — "connecting windows into shared memory". Dropping a
// state-cel window ONTO another window's titlebar STACKS them: winx.drop bundles
// the two window SEGMENTS (Layer-1 bundleSegments), so each can now read the
// other's cels, and both titlebars show 🔗. A SEALED segment is never widened —
// stacking a chat onto a sealed secrets window does NOT leak the secret.
// elementsFromPoint is stubbed to report which window the pointer was released over.
// ============================================================================

const mkWin = (s, seg) => resolveFn(s, "setCel")(s, `${seg}.state`, {
  celType: "ValueCel", v: { ref: `${seg}.state`, x: 60, y: 60, w: 380, h: 260, z: 1, title: seg },
  metadata: { segment: seg, name: "state" },
});
const stubDrop = (targetRef) => { globalThis.document = { elementsFromPoint: () => [{ closest: (sel) => sel === ".pl-titlebar" ? {} : sel === ".pl-window" ? { getAttribute: () => targetRef } : null }] }; };
const drop = async (s, draggedRef) => {
  await resolveFn(s, "setCel")(s, "winx.drag", { celType: "ValueCel", v: { ref: draggedRef, ox: 0, oy: 0 }, metadata: { segment: "windows", name: "drag" } });
  await resolveFn(s, "winx.drop")(s, null, { clientX: 100, clientY: 30 });
};
afterEach(() => { delete globalThis.document; });

test("dropping a window onto another STACKS them — bundles the two window segments (shared memory)", async () => {
  const s = createInitialState();
  await mkWin(s, "win.a"); await mkWin(s, "win.b");
  setAccessPolicy(s, "win.b", { get: "private", set: "private" });
  assert.equal(canGet(s, "win.a", "win.b"), false, "before: win.a cannot read private win.b");
  stubDrop("win.b.state");
  await drop(s, "win.a.state");
  assert.equal(canGet(s, "win.a", "win.b"), true, "after stack: win.a reads win.b — bundled memory");
  assert.equal(canGet(s, "win.b", "win.a"), true, "bundles are symmetric");
  assert.ok((s.cels.get("win.a.state").v.linked ?? []).includes("win.b"), "win.a titlebar shows it's linked");
  assert.ok((s.cels.get("win.b.state").v.linked ?? []).includes("win.a"), "win.b titlebar shows it's linked");
});

test("stacking a window onto a SEALED window does NOT open the seal", async () => {
  const s = createInitialState();
  await mkWin(s, "win.chat"); await mkWin(s, "win.secret");
  setAccessPolicy(s, "win.secret", { get: ["owner"], getSealed: true, set: "private" });
  stubDrop("win.secret.state");
  await drop(s, "win.chat.state");
  assert.equal(canGet(s, "win.chat", "win.secret"), false, "bundling never widens a SEALED get — the secret stays unreadable");
});

test("releasing in empty space (no window under the pointer) does NOT bundle", async () => {
  const s = createInitialState();
  await mkWin(s, "win.a"); await mkWin(s, "win.b");
  setAccessPolicy(s, "win.b", { get: "private", set: "private" });
  globalThis.document = { elementsFromPoint: () => [] };
  await drop(s, "win.a.state");
  assert.equal(canGet(s, "win.a", "win.b"), false, "no titlebar under the drop → no stack");
});

test("drop-target GLOW: dragging a window over another sets the target's glow; drop clears it", async () => {
  const s = createInitialState();
  await mkWin(s, "win.a"); await mkWin(s, "win.b");
  // begin a drag of win.a and move it over win.b's titlebar (stubbed)
  await resolveFn(s, "setCel")(s, "winx.drag", { celType: "ValueCel", v: { ref: "win.a.state", ox: 0, oy: 0 }, metadata: { segment: "windows", name: "drag" } });
  stubDrop("win.b.state");
  await resolveFn(s, "winx.move")(s, null, { clientX: 100, clientY: 30 });
  assert.equal(s.cels.get("win.b.state").v.glow, 1, "the window under the pointer GLOWS (drop target)");
  assert.ok(!s.cels.get("win.a.state").v.glow, "the dragged window itself does not glow");
  // drop clears all glow
  await resolveFn(s, "winx.drop")(s, null, { clientX: 100, clientY: 30 });
  assert.ok(!s.cels.get("win.b.state").v.glow, "glow cleared on drop");
});
