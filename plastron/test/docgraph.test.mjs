import { test } from "bun:test";
import assert from "node:assert/strict";
import { createInitialState, precomputeOptional, resolveFn } from "../dist/index.js";

// docgraph — the documentation graph rendered as a wiki window. These
// kernel-level (no-browser) tests boot the segment, open articles via the
// wiki.open handler, and assert: article structure, the inputMap-derived
// function/input links, backlinks, graph-node chips, the lazy window
// creation (frame OMITTED without origin's mount — the no-trap rule), note
// save via metadata-only setCel, and [[link]] rendering.

const find = (node, pred, out = []) => {
  if (!node || typeof node !== "object") return out;
  if (pred(node)) out.push(node);
  for (const k of node.children ?? []) find(k, pred, out);
  return out;
};
const textOf = (node) => find(node, (n) => n.type === "text").map((n) => n.text).join("");
const linksOf = (node) =>
  find(node, (n) => n.tag === "button" && n.events?.click?.dispatch === "wiki.open")
    .map((n) => n.events.click.payload);

const boot = async () => {
  const state = createInitialState();
  await resolveFn(state, "ensureSegments")(state, ["docgraph"]);
  await resolveFn(state, "hydrate")(state, [], []); // compile seeded formulas → inputMap edges exist
  await precomputeOptional(state);
  return state;
};

test("wiki.open assembles an article and lazily creates + opens the window", async () => {
  const state = await boot();
  assert.equal(state.cels.has("win.wiki.state"), false, "window not seeded");
  await resolveFn(state, "wiki.open")(state, "wikidoc");

  assert.equal(state.cels.get("wiki.current")?.v, "wikidoc");
  const article = state.cels.get("wiki.article")?.v;
  assert.ok(article && article.type === "el", "article vnode assembled");
  assert.match(textOf(article), /wikidoc/);
  assert.match(textOf(article), /LockedLambdaCel/);
  assert.match(textOf(article), /passthrough/i, "metadata description rendered as summary");

  const win = state.cels.get("win.wiki.state")?.v;
  assert.equal(win.closed, 0, "window created + opened");
  assert.ok(state.cels.has("win.wiki.content"), "content cel created");
  // no origin loaded → no `mount` → the frame MUST NOT be created (it would
  // trap at runCycle and pollute the error log — the errors-log regression).
  assert.equal(state.cels.has("win.wiki.frame"), false, "frame omitted without origin's mount");
});

test("no docgraph cel ever traps: a runCycle after open adds no log entries", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "wikidoc");
  await resolveFn(state, "runCycle")(state);
  const log = state.cels.get("errors")?.v;
  const entries = Array.isArray(log) ? log : [];
  assert.equal(entries.length, 0, "error log stays empty");
});

test("formula articles link their input cels (inputMap = the AST edges)", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "x"); // creates win.wiki.content first
  await resolveFn(state, "hydrate")(state, [], []); // compile the lazily-created content formula
  await resolveFn(state, "wiki.open")(state, "win.wiki.content");

  const article = state.cels.get("wiki.article")?.v;
  const links = linksOf(article);
  assert.ok(links.includes("wikidoc"), "links the function it calls");
  assert.ok(links.includes("wiki.article"), "links its input cel");
  assert.match(textOf(article), /\(wikidoc wiki\.article\)/, "formula source shown");
});

test("backlinks: wikidoc's article lists win.wiki.content as a user", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "x");
  await resolveFn(state, "hydrate")(state, [], []);
  await resolveFn(state, "wiki.open")(state, "wikidoc");
  const links = linksOf(state.cels.get("wiki.article")?.v);
  assert.ok(links.includes("win.wiki.content"), "backlink present");
});

test("W-button payload (win.X.state ref) articles the layer", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "win.wiki.state");
  assert.equal(state.cels.get("wiki.current")?.v, "win.wiki", "ref normalized to the layer");
  const t = textOf(state.cels.get("wiki.article")?.v);
  assert.match(t, /win\.wiki/, "layer article");
});

test("segment article: docgraph lists its functions", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "docgraph");
  const links = linksOf(state.cels.get("wiki.article")?.v);
  for (const k of ["wiki", "wikidoc", "wiki.open", "wiki.saveNote"]) {
    assert.ok(links.includes(k), `segment article links ${k}`);
  }
});

test("graph view renders edge canvas + clickable node chips", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "x");
  await resolveFn(state, "hydrate")(state, [], []);
  await resolveFn(state, "wiki.open")(state, "win.wiki.content");
  const article = state.cels.get("wiki.article")?.v;
  const canvases = find(article, (n) => n.tag === "canvas");
  assert.equal(canvases.length, 1, "one graph canvas");
  assert.ok(JSON.parse(canvases[0].attrs["data-ops"]).length >= 1, "edge ops present");
  const chips = find(article, (n) => n.attrs?.class === "wk-node");
  assert.ok(chips.length >= 2, "node chips present");
  assert.ok(chips.every((c) => c.events?.click?.dispatch === "wiki.open"), "chips navigate");
});

test("saveNote writes metadata.note (merge — inputMap survives) and [[links]] render", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "x");
  await resolveFn(state, "hydrate")(state, [], []);
  await resolveFn(state, "wiki.open")(state, "win.wiki.content");
  const before = { ...(state.cels.get("win.wiki.content").metadata.inputMap ?? {}) };

  await resolveFn(state, "setValue")(state, "wiki.noteDraft", "see [[wikidoc]] for the render half");
  await resolveFn(state, "wiki.saveNote")(state);

  assert.equal(state.cels.get("win.wiki.content").metadata.note, "see [[wikidoc]] for the render half");
  assert.deepEqual({ ...(state.cels.get("win.wiki.content").metadata.inputMap ?? {}) }, before, "metadata edit merged, inputMap intact");

  // the refreshed article renders the [[wikidoc]] reference as a wiki link
  const article = state.cels.get("wiki.article")?.v;
  const noteLinks = find(article, (n) => n.attrs?.class === "wk-link" && n.events?.click?.payload === "wikidoc");
  assert.ok(noteLinks.length >= 1, "[[wikidoc]] rendered as a link");
});

test("unknown key → a red-link article, not a throw", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "no.such.thing");
  assert.match(textOf(state.cels.get("wiki.article")?.v), /red link/i);
});

test("=wiki(name) renders an opener button; wikidoc placeholder hints", async () => {
  const state = await boot();
  const v = resolveFn(state, "wiki")("runCycle");
  assert.equal(v.events.click.dispatch, "wiki.open");
  assert.equal(v.events.click.payload, "runCycle");
  const ph = resolveFn(state, "wikidoc")(null);
  assert.match(textOf(ph), /no entry open/i);
});
