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

test("wiki.open RAISES + FOCUSES the wiki window: win.active points at it and its z is on top", async () => {
  const state = await boot();
  // seed a couple of other state-cel windows with high z, one already active
  await resolveFn(state, "setCel")(state, "win.other.state", {
    celType: "ValueCel", v: { ref: "win.other.state", z: 42, closed: 0 }, metadata: { segment: "win.other", name: "state" },
  });
  await resolveFn(state, "setValue")(state, "win.active", "win.other.state");

  await resolveFn(state, "wiki.open")(state, "wikidoc");

  // the wiki becomes the ACTIVE/front window (the winx.show / xRaise move):
  assert.equal(state.cels.get("win.active")?.v, "win.wiki.state", "win.active now points at the wiki window");
  const wiki = state.cels.get("win.wiki.state")?.v;
  assert.equal(wiki.closed, 0, "wiki opened");
  assert.ok(wiki.z > 42, "wiki z raised above every other window's z");
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
  assert.match(textOf(article), /\(wikidoc wiki\.article \(fgview/, "formula source shown");
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

test("the graph spec: member-seeded, degree-sized, pinned, navigable", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "x");
  await resolveFn(state, "hydrate")(state, [], []);
  await resolveFn(state, "wiki.open")(state, "win.wiki.content");
  const spec = state.cels.get("fg.wiki.spec")?.v;
  assert.ok(spec && spec.nodes.length >= 2, "spec assembled");
  assert.equal(spec.pin, "win.wiki.content", "subject pinned");
  assert.equal(spec.onNode?.dispatch, "wiki.open", "clicks navigate the wiki");
  assert.ok(new Set(spec.nodes.map((n) => n.size.toFixed(2))).size >= 2, "degree-proportional sizes");
  // article carries the SLOT; wikidoc splices the live fgview in
  const slot = find(state.cels.get("wiki.article")?.v, (n) => n.attrs?.class === "wk-graph-slot");
  assert.equal(slot.length, 1, "graph slot in the article");
  const graph = resolveFn(state, "fgview")("wiki", spec, state.cels.get("fg.wiki.pos")?.v, 1);
  const composed = resolveFn(state, "wikidoc")(state.cels.get("wiki.article")?.v, graph);
  assert.ok(find(composed, (n) => String(n.attrs?.class ?? "").startsWith("fg-node")).length >= 2, "live chips composed in");
  assert.equal(find(composed, (n) => n.attrs?.class === "wk-graph-slot").length, 0, "slot replaced");
});

test("zoom is fg-owned: wheel scales fg.wiki.zoom; a new subject resets it", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "wikidoc");
  assert.equal(state.cels.get("fg.wiki.zoom")?.v, 1);
  await resolveFn(state, "fg.arm")(state, "wiki"); // click into the graph first
  await resolveFn(state, "fg.wheel")(state, "wiki", { deltaY: -100 });
  assert.ok(state.cels.get("fg.wiki.zoom")?.v > 1, "zoomed in");
  await resolveFn(state, "wiki.open")(state, "wiki"); // new subject resets
  assert.equal(state.cels.get("fg.wiki.zoom")?.v, 1, "zoom resets on a new subject");
});

test("the wiki is editable: saveDesc writes metadata.description (unlocked cels)", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "x"); // creates the (unlocked) content cel
  await resolveFn(state, "hydrate")(state, [], []);
  await resolveFn(state, "wiki.open")(state, "win.wiki.content");
  await resolveFn(state, "setValue")(state, "wiki.descDraft", "the wiki window body formula");
  await resolveFn(state, "wiki.saveDesc")(state);
  assert.equal(state.cels.get("win.wiki.content").metadata.description, "the wiki window body formula");
  assert.match(textOf(state.cels.get("wiki.article")?.v), /the wiki window body formula/, "article refreshed with the edit");
});

test("locked natives: no desc editor, but the sidecar note STICKS", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "wikidoc");
  assert.match(textOf(state.cels.get("wiki.article")?.v), /locked — the description ships/i);
  await resolveFn(state, "setValue")(state, "wiki.noteDraft", "great fn, see [[wiki]]");
  await resolveFn(state, "wiki.saveNote")(state);
  assert.equal(state.cels.get("wiki.notes").v["wikidoc"], "great fn, see [[wiki]]");
  assert.equal(state.cels.get("wikidoc").metadata.note, undefined, "locked cel untouched");
  assert.match(textOf(state.cels.get("wiki.article")?.v), /great fn/, "note renders in the article");
});

test("native fns show live source + a github link", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "wikidoc");
  const article = state.cels.get("wiki.article")?.v;
  // the source section heading is the literal text node "Source" (not the old
  // "source (live binding)"); find it exactly so adjacent source text can't
  // mask the change.
  const headings = find(article, (n) => n.type === "text").map((n) => n.text);
  assert.ok(headings.includes("Source"), "the source section heading reads exactly 'Source'");
  assert.ok(!headings.some((t) => /live binding/i.test(t)), "the old 'source (live binding)' label is gone");
  const a = find(article, (n) => n.tag === "a")[0];
  assert.ok(a && /github\.com\/rheophile10\/plastron\/blob\/master/.test(a.attrs.href), "github source link");
});

test("layer articles seed the graph from members (never empty)", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "win.wiki.state"); // creates window cels, articles win.wiki
  await resolveFn(state, "hydrate")(state, [], []);
  await resolveFn(state, "wiki.open")(state, "win.wiki");
  const spec = state.cels.get("fg.wiki.spec")?.v;
  assert.ok(spec.nodes.length >= 3, `layer graph has member nodes (${spec.nodes.length})`);
});

test("saveNote writes metadata.note (merge — inputMap survives) and [[links]] render", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "x");
  await resolveFn(state, "hydrate")(state, [], []);
  await resolveFn(state, "wiki.open")(state, "win.wiki.content");
  const before = { ...(state.cels.get("win.wiki.content").metadata.inputMap ?? {}) };

  await resolveFn(state, "setValue")(state, "wiki.noteDraft", "see [[wikidoc]] for the render half");
  await resolveFn(state, "wiki.saveNote")(state);

  // notes live in the docgraph sidecar map — the subject cel is never edited
  assert.equal(state.cels.get("wiki.notes").v["win.wiki.content"], "see [[wikidoc]] for the render half");
  assert.deepEqual({ ...(state.cels.get("win.wiki.content").metadata.inputMap ?? {}) }, before, "subject untouched, inputMap intact");

  // the refreshed article renders the [[wikidoc]] reference as a wiki link
  const article = state.cels.get("wiki.article")?.v;
  const noteLinks = find(article, (n) => n.attrs?.class === "wk-link" && n.events?.click?.payload === "wikidoc");
  assert.ok(noteLinks.length >= 1, "[[wikidoc]] rendered as a link");
});

test("nodes are classified: kind tints + role accents on the spec", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "x");
  await resolveFn(state, "hydrate")(state, [], []);
  await resolveFn(state, "wiki.open")(state, "win.wiki.content");
  const spec = state.cels.get("fg.wiki.spec")?.v;
  const byKey = Object.fromEntries(spec.nodes.map((n) => [n.key, n]));
  assert.equal(byKey["win.wiki.content"].kind, "formula");
  assert.equal(byKey["wikidoc"].kind, "fn");
  assert.ok(byKey["wikidoc"].tint && byKey["wikidoc"].accent, "fn node carries tint + accent");
  assert.equal(byKey["wikidoc"].accent, "#2a9d8f", "library role accent");
  assert.equal(byKey["win.wiki.content"].accent, "#888888", "layer role accent");
});

test("legend filter: fg.toggleKind hides a kind's nodes + edges (pin survives)", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "x");
  await resolveFn(state, "hydrate")(state, [], []);
  await resolveFn(state, "wiki.open")(state, "win.wiki.content");
  const spec = state.cels.get("fg.wiki.spec")?.v;
  await resolveFn(state, "fg.toggleKind")(state, { id: "wiki", kind: "fn" });
  assert.deepEqual(state.cels.get("fg.wiki.hide").v, ["fn"]);
  const v = resolveFn(state, "fgview")("wiki", spec, state.cels.get("fg.wiki.pos").v, 1, 0, ["fn"]);
  const chips = find(v, (n) => String(n.attrs?.class ?? "").startsWith("fg-node"));
  assert.ok(!chips.some((c) => c.attrs.title.includes("wikidoc")), "fn nodes hidden");
  assert.ok(chips.some((c) => c.attrs.class.includes("fg-node-pin")), "pin survives filtering");
  const legend = find(v, (n) => String(n.attrs?.class ?? "").startsWith("fg-kind"));
  assert.ok(legend.length >= 2, "legend chips present");
  assert.ok(legend.some((c) => c.attrs.class.includes("fg-kind-off")), "hidden kind struck through");
  await resolveFn(state, "fg.toggleKind")(state, { id: "wiki", kind: "fn" });
  assert.deepEqual(state.cels.get("fg.wiki.hide").v, []);
});

test("source window: live source + github link in a lazy window", async () => {
  const state = await boot();
  await resolveFn(state, "wiki.open")(state, "wikidoc");
  await resolveFn(state, "wiki.openSource")(state, "wikidoc");
  const doc = state.cels.get("wiki.srcDoc")?.v;
  assert.equal(doc.key, "wikidoc");
  assert.match(doc.src, /article/i, "live toString source captured");
  assert.ok(/github[.]com\/rheophile10\/plastron/.test(doc.gh) && /docgraph\/index[.]ts/.test(doc.gh), "github path role-aware");
  assert.equal(state.cels.get("win.wikisrc.state").v.closed, 0, "source window opened");
  assert.equal(state.cels.has("win.wikisrc.frame"), false, "frame omitted without origin (no-trap rule)");
  const v = resolveFn(state, "wikisrc")(doc);
  assert.match(textOf(v), /wikidoc/);
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
