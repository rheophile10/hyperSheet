import { test, afterEach } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, canGet, setAccessPolicy } from "../dist/index.js";

// ============================================================================
// window-links — the corner-grip LINK drag (visual-edge twin of titlebar
// stacking). Dragging a window's 🔗 grip onto ANOTHER window LINKS them: it
// bundles the two segments (shared memory — same access bundle as stacking) AND
// records the {a,b} pair in win.links so a persistent edge can be drawn. The
// linkoverlay verb turns win.links + the live window geometry into one <line>
// per pair. A SEALED segment is still never widened by the link.
// elementsFromPoint is stubbed to report which .pl-window the pointer is over.
// ============================================================================

const mkWin = (s, seg, geom = {}) => resolveFn(s, "setCel")(s, `${seg}.state`, {
  celType: "ValueCel",
  v: { ref: `${seg}.state`, x: 60, y: 60, w: 380, h: 260, z: 1, title: seg, ...geom },
  metadata: { segment: seg, name: "state" },
});
// any .pl-window under the pointer reports `targetRef` (link drop hit-tests
// .pl-window directly, unlike the titlebar-only stack drop).
const stubWin = (targetRef) => { globalThis.document = { elementsFromPoint: () => [{ closest: (sel) => sel === ".pl-window" ? { getAttribute: () => targetRef } : null }] }; };
const linkDrop = async (s, fromRef) => {
  await resolveFn(s, "setValue")(s, "win.linkdrag", { from: fromRef, x: 0, y: 0 });
  await resolveFn(s, "winx.linkDrop")(s, null, { clientX: 500, clientY: 400 });
};
afterEach(() => { delete globalThis.document; });

test("linking two windows by the corner grip BUNDLES their segments (shared memory) AND records a win.links pair", async () => {
  const s = createInitialState();
  await resolveFn(s, "setCel")(s, "win.links", { celType: "ValueCel", v: [], metadata: { segment: "win", name: "links" } });
  await mkWin(s, "win.a"); await mkWin(s, "win.b");
  setAccessPolicy(s, "win.b", { get: "private", set: "private" });
  assert.equal(canGet(s, "win.a", "win.b"), false, "before: win.a cannot read private win.b");

  stubWin("win.b.state");
  await linkDrop(s, "win.a.state");

  assert.equal(canGet(s, "win.a", "win.b"), true, "after link: win.a reads win.b — bundled shared memory");
  assert.equal(canGet(s, "win.b", "win.a"), true, "bundles are symmetric");
  const pairs = s.cels.get("win.links").v;
  assert.equal(pairs.length, 1, "exactly one link pair recorded");
  assert.ok(pairs.some((p) => (p.a === "win.a.state" && p.b === "win.b.state") || (p.a === "win.b.state" && p.b === "win.a.state")), "the {a,b} pair is the two window refs");
  assert.ok((s.cels.get("win.a.state").v.linked ?? []).includes("win.b"), "win.a titlebar shows 🔗");
  assert.ok((s.cels.get("win.b.state").v.linked ?? []).includes("win.a"), "win.b titlebar shows 🔗");
});

test("linking is idempotent — a second link of the same pair does not duplicate", async () => {
  const s = createInitialState();
  await resolveFn(s, "setCel")(s, "win.links", { celType: "ValueCel", v: [], metadata: { segment: "win", name: "links" } });
  await mkWin(s, "win.a"); await mkWin(s, "win.b");
  stubWin("win.b.state");
  await linkDrop(s, "win.a.state");
  await linkDrop(s, "win.a.state");
  assert.equal(s.cels.get("win.links").v.length, 1, "the pair is recorded once");
});

test("the linkoverlay verb draws one line per win.links pair from the windows' positions", async () => {
  const s = createInitialState();
  const overlay = resolveFn(s, "linkoverlay");
  const a = { ref: "win.a.state", x: 100, y: 100, w: 200, h: 150 };
  const b = { ref: "win.b.state", x: 500, y: 400, w: 200, h: 150 };
  const out = overlay([{ a: "win.a.state", b: "win.b.state" }], null, [a, b]);
  // out is the <svg> vnode; its children are the edge <line>s
  const lines = (out.children ?? []).filter((c) => c.tag === "line" && (c.attrs?.class === "pl-link-edge"));
  assert.equal(lines.length, 1, "one edge line for one pair");
  const ln = lines[0];
  assert.equal(Number(ln.attrs.x1), 100, "line starts at window a's corner x");
  assert.equal(Number(ln.attrs.y1), 100, "line starts at window a's corner y");
  assert.equal(Number(ln.attrs.x2), 500, "line ends at window b's corner x");
  assert.equal(Number(ln.attrs.y2), 400, "line ends at window b's corner y");
});

test("the linkoverlay draws a transient drag line from the source to the live pointer", async () => {
  const s = createInitialState();
  const overlay = resolveFn(s, "linkoverlay");
  const a = { ref: "win.a.state", x: 100, y: 100, w: 200, h: 150 };
  const out = overlay([], { from: "win.a.state", x: 333, y: 444 }, [a]);
  const drag = (out.children ?? []).find((c) => c.tag === "line" && c.attrs?.class === "pl-link-drag");
  assert.ok(drag, "a transient drag line is drawn");
  assert.equal(Number(drag.attrs.x1), 100, "from the source corner");
  assert.equal(Number(drag.attrs.x2), 333, "to the live pointer x");
  assert.equal(Number(drag.attrs.y2), 444, "to the live pointer y");
});

test("linking onto a SEALED window does NOT widen the seal (the link is a request, the seal is authoritative)", async () => {
  const s = createInitialState();
  await resolveFn(s, "setCel")(s, "win.links", { celType: "ValueCel", v: [], metadata: { segment: "win", name: "links" } });
  await mkWin(s, "win.chat"); await mkWin(s, "win.secret");
  setAccessPolicy(s, "win.secret", { get: ["owner"], getSealed: true, set: "private" });
  stubWin("win.secret.state");
  await linkDrop(s, "win.chat.state");
  // the pair is recorded (a drawn line IS a request) ...
  assert.equal(s.cels.get("win.links").v.length, 1, "the link pair is still recorded");
  // ... but canGet refuses — a sealed get is never opened by a link/bundle.
  assert.equal(canGet(s, "win.chat", "win.secret"), false, "the seal holds: win.chat still cannot read the sealed secret");
});

test("releasing the link over empty desktop does NOT link", async () => {
  const s = createInitialState();
  await resolveFn(s, "setCel")(s, "win.links", { celType: "ValueCel", v: [], metadata: { segment: "win", name: "links" } });
  await mkWin(s, "win.a"); await mkWin(s, "win.b");
  setAccessPolicy(s, "win.b", { get: "private", set: "private" });
  globalThis.document = { elementsFromPoint: () => [] };
  await linkDrop(s, "win.a.state");
  assert.equal(s.cels.get("win.links").v.length, 0, "no window under the pointer → no link");
  assert.equal(canGet(s, "win.a", "win.b"), false, "no bundle formed");
});
