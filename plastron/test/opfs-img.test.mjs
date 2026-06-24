import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, resolveFn } from "../dist/index.js";

// img — images by OPFS path in formulas. "/path" srcs render as
// data-opfs-src (the painter hydrates them to objectURLs from file-store
// after paint); data:/http srcs pass straight through; string args form a
// fallback chain (first non-empty wins) so (img desktop.wallpaper
// windows.wallpaper …) falls through an empty user path to the shipped
// default.

const boot = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["dom"]);
  return state;
};

test("opfs path → data-opfs-src; direct srcs pass through", async () => {
  const state = await boot();
  const img = resolveFn(state, "img");
  const opfs = img("/plastron/assets/me.jpg");
  assert.equal(opfs.tag, "img");
  assert.equal(opfs.attrs["data-opfs-src"], "/plastron/assets/me.jpg");
  assert.equal(opfs.attrs.src, undefined, "no src until the painter hydrates");
  const direct = img("data:image/png;base64,AAAA");
  assert.equal(direct.attrs.src, "data:image/png;base64,AAAA");
  assert.equal(direct.attrs["data-opfs-src"], undefined);
});

test("fallback chain: first non-empty string wins; children fold", async () => {
  const state = await boot();
  const img = resolveFn(state, "img");
  const style = resolveFn(state, "style");
  const attr = resolveFn(state, "attr");
  const v = img("", "data:image/png;base64,BBBB", attr("class", "desktop-bg"), style("object-fit", "cover"));
  assert.equal(v.attrs.src, "data:image/png;base64,BBBB", "empty user path falls through");
  assert.equal(v.attrs.class, "desktop-bg");
  assert.equal(v.style["object-fit"], "cover");
});

test("the shipped wallpaper: windows.wallpaper is locked data", async () => {
  const state = await boot();
  await resolveFn(state, "ensureSegments")(state, ["dom"]);
  const wp = state.cels.get("windows.wallpaper");
  assert.ok(wp?.locked, "default wallpaper is locked library data");
  assert.match(String(wp.v).slice(0, 20), /^data:image/);
  // The wallpaper rendering moved to the `desktop` origin-application
  // (desktop.bg / desktop.bg.frame over desktop.wallpaper with windows.wallpaper
  // as fallback); the gen-1 windows `desktop()` genesis verb was retired. The
  // desktop-app's behavior is covered by desktop-app.test.mjs.
});
