import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// ============================================================================
// window-taskbar-group — the taskbar collapses LINKED state-cel windows into
// ONE entry per group (connected components over intersecting `linked` sets),
// and excludes TABBED worksheet windows (those hosted inside another window's
// tab strip via win.geom[seg].host). One entry per group; un-grouped windows
// unchanged.
// ============================================================================

const taskItems = (out) => {
  const acc = [];
  const walk = (n) => { if (n && typeof n === "object") { if (n.attrs?.class === "pl-task" || n.attrs?.class === "pl-task off") acc.push(n); for (const c of (n.children ?? [])) walk(c); } };
  walk(out.vnode);
  return acc.map((i) => ({ label: i.children?.[0]?.text ?? "", win: i.attrs["data-win"], handler: i.events?.click?.dispatch }));
};
const sv = (s, keys, vals, geom = {}) => resolveFn(s, "sheetView")({}, null, "", null, null, keys, vals, keys.map(() => ""), geom);

test("two LINKED state-cel windows collapse to ONE taskbar entry; standalone stays separate", () => {
  const s = createInitialState();
  const keys = ["win.a.state", "win.b.state", "win.c.state"];
  const vals = [
    { ref: "win.a.state", title: "A", linked: ["win.a", "win.b"] },
    { ref: "win.b.state", title: "B", linked: ["win.a", "win.b"] },
    { ref: "win.c.state", title: "C" },
  ];
  const items = taskItems(sv(s, keys, vals));
  // exactly two entries: the {a,b} group + standalone c
  assert.equal(items.length, 2, "linked a+b → one entry, c → one entry");
  const group = items.find((i) => i.win === "win.a.state");
  assert.ok(group, "the group entry acts on its representative (win.a.state) via winx.show");
  assert.equal(group.handler, "winx.show");
  assert.match(group.label, /🔗/, "a grouped entry is marked linked");
  assert.ok(items.some((i) => i.win === "win.c.state" && !/🔗/.test(i.label)), "standalone c is its own plain entry");
});

test("a CHAIN of links (a↔b, b↔c) is one connected group → one entry", () => {
  const s = createInitialState();
  const keys = ["win.a.state", "win.b.state", "win.c.state"];
  const vals = [
    { ref: "win.a.state", title: "A", linked: ["win.a", "win.b"] },
    { ref: "win.b.state", title: "B", linked: ["win.b", "win.c"] },
    { ref: "win.c.state", title: "C", linked: ["win.b", "win.c"] },
  ];
  const items = taskItems(sv(s, keys, vals));
  assert.equal(items.length, 1, "the whole chain collapses to ONE entry (transitive grouping)");
});

test("TABBED worksheet windows (a host in win.geom) get no separate taskbar entry", () => {
  const s = createInitialState();
  // two worksheet layers; `child` is tabbed INTO `host`.
  const keys = ["host.A1", "child.A1"];
  const vals = ["x", "y"];
  const geom = { host: { x: 0, y: 0 }, child: { host: "host" } };
  const items = taskItems(sv(s, keys, vals, geom));
  const wins = items.map((i) => i.win);
  assert.ok(wins.includes("host"), "the host worksheet window shows");
  assert.ok(!wins.includes("child"), "the tabbed child does NOT get its own entry (it rides the host's tab strip)");
});
