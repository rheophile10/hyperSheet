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
  assert.match(frame.f, /taskbarBar\(win\.active/, "renders taskbarBar over win.active");
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

test("taskbarBar: every chip + the bar are OPAQUE — no element opacity, no alpha-hex backgrounds; minimized dims text only", async () => {
  const s = await boot();
  // active="win.am.state" AND min:1 → the worst case (minimize the focused window,
  // which keeps focus): the chip is BOTH active-styled and minimized.
  const bar = resolveFn(s, "taskbarBar")(
    "win.am.state",
    { ref: "win.idle.state", title: "Idle" },
    { ref: "win.min.state", title: "Mini", min: 1 },
    { ref: "win.am.state", title: "ActiveMin", min: 1 },
  );
  const chips = bar.children;
  assert.equal(chips.length, 3, "idle + minimized + active-minimized all render");
  const styleOf = (title) => String(chips.find((c) => c.children?.[0]?.text?.includes(title)).attrs.style);
  const ALPHA_BG = /background:#[0-9a-f]{4}(?:[0-9a-f]{4})?\b/i;   // 4- or 8-digit hex background = translucent

  for (const c of chips) {
    const style = String(c.attrs.style);
    // element opacity applies to the whole button incl. its background → banned outright.
    assert.doesNotMatch(style, /opacity\s*:/, "no element opacity on any chip");
    assert.doesNotMatch(style, ALPHA_BG, "no translucent alpha-hex chip background");
    assert.match(style, /background:Canvas/, "every chip has an opaque Canvas background");
  }

  // minimized (incl. the active+min worst case) is dimmed by FOREGROUND only.
  const min = styleOf("Mini"), am = styleOf("ActiveMin");
  assert.match(min, /color:GrayText/, "minimized chip dims via GrayText, not opacity");
  assert.match(min, /font-style:italic/, "minimized chip stays italic");
  assert.match(am, /color:GrayText/, "active+min worst case still dims via GrayText");
  assert.match(am, /font-style:italic/, "active+min worst case stays italic");
  assert.doesNotMatch(am, /opacity\s*:/, "active+min worst case has no element opacity");

  // idle (non-min) chip keeps normal foreground; active tint is opaque (Canvas base).
  assert.match(styleOf("Idle"), /color:CanvasText/, "non-minimized chip uses CanvasText");
  assert.match(am, /background:Canvas/, "the active tint sits on an opaque Canvas base");

  // the bar surface itself: opaque + above the window band.
  const barStyle = String(bar.attrs.style);
  assert.doesNotMatch(barStyle, ALPHA_BG, "the bar background is opaque (no alpha-hex #8881)");
  assert.match(barStyle, /background:Canvas/, "the bar has an opaque Canvas background");
  const z = Number((barStyle.match(/z-index:(\d+)/) ?? [])[1]);
  assert.ok(z >= 100000, `bar z-index (${z}) sits far above the window band (win.topz seed 100 + raises)`);
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

test("desktop.bg renders a wallpaper surface (OPFS-hydrated img) with a right-click → settings binding", async () => {
  const s = await boot();
  const v = resolveFn(s, "desktop.bg")("/wallpapers/a.png", "data:fallback");
  // a full-screen surface DIV carries the contextmenu; the img sits inside it
  assert.equal(v.tag, "div", "the event-receiving surface is a div, not the img");
  assert.equal(v.events.contextmenu.dispatch, "desktop.bgmenu");
  assert.equal(v.events.contextmenu.prevent, true, "suppresses the native menu");
  const img = v.children[0];
  assert.equal(img.tag, "img");
  assert.equal(img.attrs["data-opfs-src"], "/wallpapers/a.png", "a /path src is an OPFS reference");
  // empty src falls back
  const fb = resolveFn(s, "desktop.bg")("", "data:fallback");
  assert.equal(fb.children[0].attrs.src, "data:fallback");
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

test("desktop.icons: unpositioned tiles fill vertically then wrap into new left-to-right columns (availH budget)", async () => {
  const s = await boot();
  const item = resolveFn(s, "item");
  const items = ["A", "B", "C", "D", "E"].map((l, i) => item(`x${i} ${l}`, `=a${i}()`));
  const leftOf = (c) => Number(String(c.attrs.style).match(/left:(-?\d+)px/)[1]);
  const topOf = (c) => Number(String(c.attrs.style).match(/top:(-?\d+)px/)[1]);

  // availH 200 → perCol = floor((200-12)/90) = 2: two tiles per column, columns
  // grow rightward from the left edge (COL_W 96: 16 → 112 → 208).
  const desk = resolveFn(s, "desktop.icons")({}, false, 200, ...items);
  assert.deepEqual(desk.children.map(leftOf), [16, 16, 112, 112, 208], "fill-then-wrap: 2 per column, new columns grow rightward from the left edge");
  assert.deepEqual(desk.children.map(topOf), [12, 102, 12, 102, 12], "each column fills top→bottom (TOP 12, ICON_H 90)");
  for (const t of desk.children.map(topOf)) assert.ok(t <= 200 - 90, `tile top ${t} clears the availH budget (never spills past the bottom)`);

  // persisted position still wins, regardless of availH.
  const pinned = resolveFn(s, "desktop.icons")({ "x2 C": [500, 400] }, false, 200, ...items);
  assert.match(String(pinned.children[2].attrs.style), /left:500px;top:400px/, "an iconpos entry overrides its computed wrap slot");

  // back-compat: omit availH (old (iconpos, mobile, …items) order) → Infinity →
  // today's single column down the left edge.
  const legacy = resolveFn(s, "desktop.icons")({}, false, ...items);
  assert.deepEqual(legacy.children.map(leftOf), [16, 16, 16, 16, 16], "no availH → a single column at the left edge (x=16)");
  assert.deepEqual(legacy.children.map(topOf), [12, 102, 192, 282, 372], "single column stacks straight down by ICON_H");
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

test("desktop.stategraph opens a real window-segment window (drag/resize/min/close via wframe)", async () => {
  const s = await boot();
  await resolveFn(s, "ensureSegments")(s, ["window", "forcegraph"]);
  await resolveFn(s, "desktop.stategraph")(s);
  // wopen genesis materialized the window cels (proves wopen carries genesis:true)
  assert.equal(s.cels.has("win.stategraph.state"), true, "window state cel created");
  assert.equal(s.cels.has("win.stategraph.frame"), true, "self-mounting frame cel created");
  assert.equal(s.cels.has("fg.stategraph.spec"), true, "forcegraph spec laid out");
});

test("state-graph ⟳: the window carries the refresh tool; desktop.graphRefresh rebuilds the spec from CURRENT state", async () => {
  const s = await boot();
  await resolveFn(s, "ensureSegments")(s, ["window", "forcegraph"]);
  await resolveFn(s, "desktop.stategraph")(s);
  // the refresh tool rides the window state; wframe renders it in the titlebar
  const tools = s.cels.get("win.stategraph.state").v.tools;
  assert.equal(tools?.[0]?.dispatch, "desktop.graphRefresh", "⟳ tool dispatches desktop.graphRefresh");
  const frame = resolveFn(s, "wframe")(s.cels.get("win.stategraph.state").v, "", null);
  const bar = frame.children.find((c) => c.attrs?.class === "pl-titlebar");
  const toolbox = bar.children.find((c) => c.attrs?.class === "pl-win-tools");
  assert.equal(toolbox.children.length, 1, "titlebar renders the tool button");
  assert.equal(toolbox.children[0].events.click.dispatch, "desktop.graphRefresh");

  // a segment born AFTER open is invisible until ⟳ rebuilds the spec
  const before = s.cels.get("fg.stategraph.spec").v.nodes.map((n) => n.key);
  assert.equal(before.includes("late-seg"), false);
  await resolveFn(s, "setCel")(s, "late.probe", { celType: "ValueCel", v: 1, metadata: { key: "late.probe", segment: "late-seg" } });
  await resolveFn(s, "desktop.graphRefresh")(s);
  const after = s.cels.get("fg.stategraph.spec").v.nodes.map((n) => n.key);
  assert.equal(after.includes("late-seg"), true, "refresh picks up the new segment");
});
