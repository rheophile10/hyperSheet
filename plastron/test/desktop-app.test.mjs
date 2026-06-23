import { test, beforeAll } from "bun:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as nodepath from "node:path";

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs-desktop";

const { createInitialState, resolveFn } = await import("../dist/index.js");
const origin = await import("../dist/甲骨坑/application/origin/index.js");

const ROOT = createInitialState().cels.get("file-store.root").v;
beforeAll(async () => { await fsp.rm(nodepath.resolve(ROOT, "wallpapers"), { recursive: true, force: true }); });

// origin is parked by default; wake it so the desktop chrome verbs resolve.
const boot = async () => {
  const s = createInitialState();
  await resolveFn(s, "ensureSegments")(s, ["origin"]);
  await resolveFn(s, "hydrate")(s, [], []);
  return s;
};

test("taskbarGenesis rebuilds the taskbar frame, splicing in each window's state cel", async () => {
  const s = await boot();
  const gen = resolveFn(s, "desktop.taskbarGenesis")(["win.a.state", "win.b.state"], "win.a.state");
  assert.equal(gen.genesis, true, "is a genesis request");
  assert.equal(gen.layer, "desktop.taskbar");
  const frame = gen.cels["desktop.taskbar.frame"];
  assert.ok(frame, "frame cel minted");
  assert.match(frame.f, /taskbarBar win\.active/, "renders taskbarBar over win.active");
  assert.match(frame.f, /win\.a\.state/, "references window a's state cel");
  assert.match(frame.f, /win\.b\.state/, "references window b's state cel");
});

test("taskbarGenesis drops non-key refs (formula-injection safe)", async () => {
  const s = await boot();
  const gen = resolveFn(s, "desktop.taskbarGenesis")(["win.ok.state", "evil ref)"], "");
  const f = gen.cels["desktop.taskbar.frame"].f;
  assert.match(f, /win\.ok\.state/, "the valid ref survives");
  assert.doesNotMatch(f, /evil/, "the malformed ref is dropped");
});

test("taskbarBar: a chip per open window; active bordered, min dimmed, closed/docked skipped", async () => {
  const s = await boot();
  const bar = resolveFn(s, "taskbarBar")(
    "win.a.state",
    { ref: "win.a.state", title: "Alpha" },
    { ref: "win.b.state", title: "Beta", min: 1 },
    { ref: "win.c.state", title: "Gamma", closed: 1 },
    { ref: "win.d.state", title: "Delta", dockedIn: "win.a.state" },
  );
  const chips = bar.children;
  assert.equal(chips.length, 2, "only Alpha + Beta render (Gamma closed, Delta docked)");
  const cls = chips.map((c) => String(c.attrs.class));
  assert.ok(cls.some((c) => c.includes("active")), "the active window's chip is .active");
  assert.ok(cls.some((c) => c.includes("min")), "the minimized window's chip is .min");
});

test("buildStateGraphSpec: one node per segment, sized by memory, origin-applications tinted distinctly", async () => {
  const s = await boot();
  const spec = origin.buildStateGraphSpec(s);
  const byKey = new Map(spec.nodes.map((n) => [n.key, n]));

  assert.ok(byKey.has("origin"), "origin is a node");
  const o = byKey.get("origin");
  assert.equal(o.kind, "app", "origin (role application) → kind app");
  assert.equal(o.accent, "#e8923a", "app accent tint");

  const plainSeg = [...byKey.values()].find((n) => n.kind === "segment");
  assert.ok(plainSeg, "at least one non-app (library) segment node");
  assert.equal(plainSeg.accent, "#4a90d9", "non-app accent tint");

  for (const n of spec.nodes) assert.ok(n.size >= 0.7 && n.size <= 2.0001, `${n.key} size in 0.7..2 band`);

  const keys = new Set(spec.nodes.map((n) => n.key));
  for (const [a, b] of spec.edges) assert.ok(keys.has(a) && keys.has(b), "edge endpoints are present nodes");

  // memory ordering: origin (a large segment) outweighs a tiny one → larger node
  const sizes = spec.nodes.map((n) => n.size);
  assert.ok(Math.max(...sizes) > Math.min(...sizes), "memory variation produces size variation");
});

test("desktop.bg renders an OPFS-hydrated wallpaper img with a right-click → settings binding", async () => {
  const s = await boot();
  const v = resolveFn(s, "desktop.bg")("/wallpapers/a.png", "data:fallback");
  assert.equal(v.tag, "img");
  assert.equal(v.attrs["data-opfs-src"], "/wallpapers/a.png", "a /path src is an OPFS reference");
  assert.equal(v.events.contextmenu.dispatch, "desktop.bgmenu");
  assert.equal(v.events.contextmenu.prevent, true, "suppresses the native menu");
  // empty src falls back
  const fb = resolveFn(s, "desktop.bg")("", "data:fallback");
  assert.equal(fb.attrs.src, "data:fallback");
});

test("desktop.refreshWallpapers lists /wallpapers/; desktop.setWallpaper points the cel at a path", async () => {
  const s = await boot();
  await resolveFn(s, "ensureSegments")(s, ["file-store"]);
  const write = resolveFn(s, "fs.write");
  await write("/wallpapers/a.png", new Uint8Array([1, 2, 3]));
  await write("/wallpapers/b.png", new Uint8Array([4, 5, 6]));

  await resolveFn(s, "desktop.refreshWallpapers")(s);
  const list = s.cels.get("desktop.wallpapers").v;
  assert.ok(list.includes("/wallpapers/a.png") && list.includes("/wallpapers/b.png"), "both images listed");

  await resolveFn(s, "desktop.setWallpaper")(s, "/wallpapers/a.png");
  assert.equal(s.cels.get("desktop.wallpaper").v, "/wallpapers/a.png", "wallpaper cel points at the picked path");
});

test("desktop.settingsView renders a preview + import button + a chip per image", async () => {
  const s = await boot();
  const v = resolveFn(s, "desktop.settingsView")("/wallpapers/a.png", ["/wallpapers/a.png", "/wallpapers/b.png"]);
  const flat = JSON.stringify(v);
  assert.match(flat, /desktop\.importWallpaper/, "has the file-IO import binding");
  assert.match(flat, /desktop\.setWallpaper/, "chips dispatch setWallpaper");
  // two picker chips
  const chips = (v.children ?? []).flatMap((c) => c.children ?? []).filter((c) => c?.attrs?.class === "pl-wp-chip");
  assert.equal(chips.length, 2, "one chip per listed image");
});

test("desktop.icons: desktop renders draggable positioned tiles; mobile falls back to the nav", async () => {
  const s = await boot();
  const item = resolveFn(s, "item");
  const pos = { "🐢 DOOM": [200, 120] };
  const desk = resolveFn(s, "desktop.icons")(pos, false, item("🐢 DOOM", "=doom()"), item("📁 Files", "=explorerwin()"));
  assert.equal(desk.attrs.class, "pl-desk-icons");
  assert.equal(desk.children.length, 2, "two icon tiles");
  assert.match(String(desk.children[0].attrs.style), /left:200px;top:120px/, "honors persisted position");
  assert.equal(desk.children[0].events.pointerdown.dispatch, "desktop.iconGrab");
  assert.equal(desk.children[0].events.click.dispatch, "desktop.iconClick");

  const mob = resolveFn(s, "desktop.icons")(pos, true, item("🐢 DOOM", "=doom()"));
  assert.equal(mob.tag, "details", "mobile returns the collapsible nav, not desktop tiles");
});

test("desktop icon drag updates desktop.iconpos; a drag past threshold suppresses the click-launch", async () => {
  const s = await boot();
  await resolveFn(s, "desktop.iconGrab")(s, "🐢 DOOM", { clientX: 100, clientY: 100 });
  await resolveFn(s, "desktop.iconMove")(s, null, { clientX: 140, clientY: 130 });
  // default start pos [16,16] → offset [84,84]; new pos = [140-84, 130-84] = [56,46]
  assert.deepEqual(s.cels.get("desktop.iconpos").v["🐢 DOOM"], [56, 46], "icon moved to the dragged position");

  await resolveFn(s, "desktop.iconDrop")(s);
  assert.ok(s.cels.get("desktop.iconLastMoved").v > 3, "a real drag records movement");

  // iconClick after a drag must NOT launch (and resets the guard)
  await resolveFn(s, "desktop.iconClick")(s, "=doom()");
  assert.equal(s.cels.get("desktop.iconLastMoved").v, 0, "the drag guard is consumed; no launch fired");
});
