import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn, setPainter } from "../dist/index.js";

// window — the primitive, content-agnostic, TABBABLE frame
// (docs/1-design/1-under-consideration/windowing-architecture.md).
// A window's state is one cel: { x,y,w,h,z,min,max,closed,title,icon,
//   tabs:[{ref,title,icon}], active }. A tab references a content cel of ANY kind,
// so a sheet can be tabbed next to DOOM. Handlers write the state cel by ref.

const boot = async () => {
  const state = createInitialState();
  setPainter(state, { enqueue: () => {}, drain: () => {}, flush: () => {} });
  await resolveFn(state, "ensureSegments")(state, ["window", "dom"]);
  await resolveFn(state, "hydrate")(state, [], []);
  return state;
};

// vnode walkers
const walk = (n, p, out = []) => { if (n && typeof n === "object") { if (n.type === "el" && p(n)) out.push(n); for (const c of n.children ?? []) walk(c, p, out); } return out; };
const cls = (n, c) => new RegExp(`(^| )${c}( |$)`).test(String(n.attrs?.class ?? ""));
const byClass = (root, c) => walk(root, (n) => cls(n, c));
const vtxt = (n) => (n?.type === "text" ? n.text : (n?.children ?? []).map(vtxt).join(""));

const REF = "win.demo.state";
const seedWindow = async (state, patch = {}) => {
  await resolveFn(state, "setCel")(state, REF, {
    celType: "ValueCel",
    v: { ref: REF, x: 100, y: 80, w: 400, h: 300, z: 5, min: 0, max: 0, closed: 0,
         tabs: [{ ref: "sheet1.view", title: "Sheet", icon: "▦" }, { ref: "wasm.doom.content", title: "DOOM", icon: "🐢" }],
         active: 0, ...patch },
    metadata: { key: REF, segment: "demo" },
  });
};
const st = (state) => state.cels.get(REF)?.v;
const wframe = (state, active, content) => resolveFn(state, "wframe")(st(state), active, content);
const fire = (state, verb, payload, event) => resolveFn(state, verb)(state, payload, event);

test("wframe renders a tabbable frame: titlebar controls, one chip per tab, active content", async () => {
  const state = await boot();
  await seedWindow(state);
  const contentA = resolveFn(state, "dom")("div.tab-a", "SHEET BODY");
  const root = wframe(state, REF, contentA);

  assert.equal(byClass(root, "pl-window").length, 1, "one window frame");
  assert.equal(byClass(root, "pl-titlebar").length, 1, "a titlebar");
  assert.equal(byClass(root, "pl-close-btn").length, 1, "a close (✕) control");
  assert.equal(byClass(root, "pl-resize").length, 1, "a resize grip");
  const chips = byClass(root, "pl-tab");
  assert.equal(chips.length, 2, "two tab chips (heterogeneous: a sheet + DOOM)");
  assert.ok(vtxt(chips[0]).includes("Sheet") && vtxt(chips[1]).includes("DOOM"), "chips show both tab titles");
  assert.ok(byClass(root, "tab-a").length === 1, "the ACTIVE tab's content is rendered in the body");
  // the close control dispatches window.close with this window's ref
  assert.equal(byClass(root, "pl-close-btn")[0].events?.click?.dispatch, "window.close");
  assert.equal(byClass(root, "pl-close-btn")[0].events?.click?.payload, REF);
  // tab chips dispatch window.tab with their index
  assert.equal(chips[1].events?.click?.dispatch, "window.tab");
  assert.deepEqual(chips[1].events?.click?.payload, { ref: REF, index: 1 });
});

test("selecting a tab switches the active content (reactive via the state cel)", async () => {
  const state = await boot();
  await seedWindow(state);
  // a single tab is shown active in the titlebar; switch to DOOM (index 1)
  assert.ok(vtxt(byClass(wframe(state, REF, resolveFn(state, "dom")("div.a", "A")), "pl-titlebar")[0]).includes("Sheet"), "starts on the Sheet tab");

  await fire(state, "window.tab", { ref: REF, index: 1 });
  assert.equal(st(state).active, 1, "active index moved to DOOM");
  const doomContent = resolveFn(state, "dom")("div.tab-doom", "DOOM CANVAS");
  const root = wframe(state, REF, doomContent);
  assert.ok(byClass(root, "tab-doom").length === 1, "now the DOOM content is in the body");
  assert.ok(vtxt(byClass(root, "pl-titlebar")[0]).includes("DOOM"), "titlebar shows the active tab's title");
});

test("dock COMBINES windows: appends a tab and focuses it", async () => {
  const state = await boot();
  await seedWindow(state);
  await fire(state, "window.dock", { into: REF, tab: { ref: "sqlres.view", title: "SQL", icon: "🗄" } });
  assert.equal(st(state).tabs.length, 3, "a third tab docked in");
  assert.equal(st(state).active, 2, "the docked tab is focused");
  assert.equal(byClass(wframe(state, REF, resolveFn(state, "dom")("div", "x")), "pl-tab").length, 3, "three chips render");
});

test("tabClose removes a tab and re-clamps active; closing the last tab closes the window", async () => {
  const state = await boot();
  await seedWindow(state, { active: 1 });
  await fire(state, "window.tabClose", { ref: REF, index: 0 });        // remove the Sheet tab
  assert.equal(st(state).tabs.length, 1, "one tab left");
  assert.equal(st(state).tabs[0].title, "DOOM", "the right tab remained");
  assert.equal(st(state).active, 0, "active re-clamped");
  await fire(state, "window.tabClose", { ref: REF, index: 0 });        // remove the last
  assert.equal(st(state).closed, 1, "closing the last tab closes the window");
});

test("undock TEARS a tab off into its own new window added to win.list", async () => {
  const state = await boot();
  await seedWindow(state);
  await fire(state, "window.undock", { ref: REF, index: 1 });          // tear off DOOM
  assert.equal(st(state).tabs.length, 1, "DOOM left the original window");
  const newRef = "win.wasm_doom_content.state";
  const nw = state.cels.get(newRef)?.v;
  assert.ok(nw, "a new window state cel was minted for the torn-off tab");
  assert.equal(nw.tabs.length, 1, "the new window holds just the torn-off tab");
  assert.equal(nw.tabs[0].title, "DOOM");
  assert.ok((state.cels.get("win.list")?.v ?? []).includes(newRef), "the new window is in win.list");
});

test("wframe is variadic: renders the ACTIVE tab's content from the contents list", async () => {
  const state = await boot();
  await seedWindow(state, { active: 1 });
  const a = resolveFn(state, "dom")("div.body-sheet", "SHEET");
  const b = resolveFn(state, "dom")("div.body-doom", "DOOM");
  const root = resolveFn(state, "wframe")(st(state), REF, a, b);   // one content per tab
  assert.equal(byClass(root, "body-doom").length, 1, "active tab (1) → DOOM content shown");
  assert.equal(byClass(root, "body-sheet").length, 0, "inactive tab's content not rendered");
});

test("wopen genesis: a self-mounting window (content + state + frame that mounts itself)", async () => {
  const state = await boot();
  const g = resolveFn(state, "wopen")("kanban", "📋 Kanban", "=dom('div','hi')", { __geom: { x: 10, y: 20, w: 300, h: 220 } });
  assert.equal(g.genesis, true);
  assert.equal(g.cels["win.kanban.content"].f, "=dom('div','hi')", "content cel holds the body formula");
  const ws = g.cels["win.kanban.state"].v;
  assert.deepEqual([ws.x, ws.y, ws.w, ws.h], [10, 20, 300, 220], "geometry from geom()");
  assert.deepEqual(ws.tabs, [{ ref: "win.kanban.content", title: "📋 Kanban", flush: "win.kanban.flush" }], "one tab = its own content");
  assert.equal(g.cels["win.kanban.frame"].f, '(mount ".origin" (wframe win.kanban.state win.active win.kanban.content))', "frame SELF-MOUNTS and references its content cel");
});

test("dock pulls a real window in as a tab: marks it dockedIn + rebuilds the host frame", async () => {
  const state = await boot();
  const mk = async (id, title) => resolveFn(state, "setCel")(state, `win.${id}.state`, {
    celType: "ValueCel", metadata: { key: `win.${id}.state`, segment: `win.${id}` },
    v: { ref: `win.${id}.state`, x: 80, y: 60, w: 360, h: 240, z: 1, min: 0, max: 0, closed: 0, title,
         tabs: [{ ref: `win.${id}.content`, title }], active: 0 },
  });
  await mk("a", "Sheet"); await mk("b", "DOOM");

  await fire(state, "window.dock", { into: "win.a.state", win: "win.b.state" });
  const a = state.cels.get("win.a.state").v;
  assert.equal(a.tabs.length, 2, "host now has two tabs");
  assert.equal(a.tabs[1].win, "win.b.state", "the new tab remembers its source window");
  assert.equal(a.active, 1, "docked tab focused");
  assert.equal(state.cels.get("win.b.state").v.dockedIn, "win.a.state", "the docked window self-hides (dockedIn set)");
  assert.match(state.cels.get("win.a.frame").f, /win\.b\.content/, "host frame rebuilt to reference the docked content cel");
  // the docked window's own frame would render nothing
  const hidden = resolveFn(state, "wframe")(state.cels.get("win.b.state").v, "x", resolveFn(state, "dom")("div", "y"));
  assert.equal(byClass(hidden, "pl-win-docked").length, 1, "a dockedIn window self-hides");
});

test("undock restores the docked window (clears dockedIn) and rebuilds the host", async () => {
  const state = await boot();
  const mk = async (id, title) => resolveFn(state, "setCel")(state, `win.${id}.state`, {
    celType: "ValueCel", metadata: { key: `win.${id}.state`, segment: `win.${id}` },
    v: { ref: `win.${id}.state`, x: 80, y: 60, w: 360, h: 240, z: 1, min: 0, max: 0, closed: 0, title, tabs: [{ ref: `win.${id}.content`, title }], active: 0 },
  });
  await mk("a", "Sheet"); await mk("b", "DOOM");
  await fire(state, "window.dock", { into: "win.a.state", win: "win.b.state" });
  await fire(state, "window.undock", { ref: "win.a.state", index: 1 });
  assert.equal(state.cels.get("win.a.state").v.tabs.length, 1, "host back to one tab");
  assert.ok(!state.cels.get("win.b.state").v.dockedIn, "the torn-off window is standalone again (dockedIn cleared)");
});

test("close runs EACH tab's <seg>.flush (a tab is an app with its own teardown), then drops the window", async () => {
  const state = await boot();
  await seedWindow(state);   // tabs: sheet1.view, wasm.doom.content
  // register a contract flush cel per tab's app segment; each bumps a marker.
  const flushed = [];
  for (const [seg, marker] of [["sheet1", "S"], ["wasm.doom", "D"]]) {
    await resolveFn(state, "setCel")(state, `${seg}.flush`, {
      celType: "LockedLambdaCel", locked: true, fn: () => { flushed.push(marker); },
      metadata: { key: `${seg}.flush`, segment: seg, kind: "native" },
    });
  }
  await fire(state, "window.close", REF);
  assert.deepEqual(flushed.sort(), ["D", "S"], "both tabs' flush contract cels fired on close");
  assert.equal(st(state).closed, 1, "window dropped after flushing its tabs");
});

test("tabClose runs only that tab's flush", async () => {
  const state = await boot();
  await seedWindow(state);
  let doomFlushed = 0;
  await resolveFn(state, "setCel")(state, "wasm.doom.flush", {
    celType: "LockedLambdaCel", locked: true, fn: () => { doomFlushed++; },
    metadata: { key: "wasm.doom.flush", segment: "wasm.doom", kind: "native" },
  });
  await fire(state, "window.tabClose", { ref: REF, index: 1 });   // close DOOM
  assert.equal(doomFlushed, 1, "the closed tab's flush ran once");
  assert.equal(st(state).tabs.length, 1, "DOOM tab removed");
});

test("drag writes the window's geometry cel; raise focuses + bumps z", async () => {
  const state = await boot();
  await seedWindow(state);
  await fire(state, "window.grab", REF, { clientX: 150, clientY: 120, pointerId: 1 });  // offset (50,40) from x100/y80
  await fire(state, "window.move", null, { clientX: 300, clientY: 260 });
  assert.equal(st(state).x, 250, "x = clientX - offset");
  assert.equal(st(state).y, 220, "y = clientY - offset");
  await fire(state, "window.drop", null, {});
  assert.equal(state.cels.get("window.drag")?.v, null, "drag state cleared");

  await fire(state, "window.raise", REF);
  assert.equal(state.cels.get("win.active")?.v, REF, "raise focuses the window");
  assert.ok(st(state).z > 100, "raise bumped z above the fountain floor");
});
