import { test } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// origin — the OPFS desktop phase: the desktop background falls back to the
// shipped data-URI wallpaper (rendered by a formula — the old
// origin.seedWallpaper OPFS-seeding verb is gone), upload/download cels render
// their button/input, and the explorer verb lists OPFS entries as a
// folders-then-files dom value.

process.env.PLASTRON_FILE_STORE_ROOT ??= "./.plastron-fs";

const { createInitialState, precomputeOptional, resolveFn, createPainter, setPainter } =
  await import("../dist/index.js");

const TEST_PREFIX = `__opfs-desk-${process.pid}-${Date.now().toString(36)}`;
const p = (rel) => `/${TEST_PREFIX}/${rel}`;

const mkEl = (tag) => {
  const L = new Map();
  const el = {
    nodeType: 1, tag, tagName: tag.toUpperCase(), value: undefined, childNodes: [], attrs: {},
    style: { props: {}, setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } },
    get firstChild() { return this.childNodes[0] ?? null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; },
    setAttribute(n, v) { this.attrs[n] = v; }, removeAttribute(n) { delete this.attrs[n]; },
    getAttribute(n) { return this.attrs[n] ?? null; },
    appendChild(c) { this.childNodes.push(c); return c; },
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; },
    replaceChild(n, o) { const i = this.childNodes.indexOf(o); if (i >= 0) this.childNodes[i] = n; return o; },
    insertBefore(n, r) { const i = r ? this.childNodes.indexOf(r) : -1; if (i >= 0) this.childNodes.splice(i, 0, n); else this.childNodes.push(n); return n; },
    replaceChildren(...c) { this.childNodes = [...c]; },
    querySelectorAll() { return []; },
    addEventListener(t, fn) { (L.get(t) ?? L.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { L.get(t)?.delete(fn); },
  };
  return el;
};
// these walk the origin VNODE shape ({type:"el"|"text", tag, attrs, events,
// children, text}) returned by the dom verbs — NOT live DOM nodes.
const walkV = (n, pred, o = []) => { if (n && typeof n === "object" && n.type === "el") { if (pred(n)) o.push(n); for (const c of n.children ?? []) walkV(c, pred, o); } return o; };
const txtV = (n) => { if (!n || typeof n !== "object") return ""; if (n.type === "text") return String(n.text ?? ""); return (n.children ?? []).map(txtV).join(""); };
// these walk the LIVE painted DOM (mkEl nodes) for the desktop-render checks.
const walk = (n, pred, o = []) => { if (n?.nodeType === 1) { if (pred(n)) o.push(n); for (const c of n.childNodes) walk(c, pred, o); } return o; };
const txt = (n) => (n.nodeType === 3 ? n.data : (n.childNodes ?? []).map(txt).join(""));
const mockRaf = () => { const q = []; return { raf: (cb) => q.push(cb), caf: () => {}, run: () => { for (const cb of q.splice(0)) cb(); } }; };

const boot = async () => {
  const root = mkEl("app");
  globalThis.document = {
    createElement: mkEl, createTextNode: (s) => ({ nodeType: 3, data: s }),
    querySelector: (s) => (s === "#app" ? root : null),
    addEventListener() {}, removeEventListener() {},
  };
  const m = mockRaf();
  const state = createInitialState();
  setPainter(state, createPainter(state, { raf: m.raf, caf: m.caf, isBrowser: true, doc: globalThis.document, resolveMount: (x) => (x === "#app" ? root : null) }));
  await resolveFn(state, "ensureSegments")(state, ["origin"]);
  await resolveFn(state, "hydrate")(state, [], []);
  await precomputeOptional(state);
  await resolveFn(state, "runCycle")(state);
  await resolveFn(state, "origin.run")(state, "元"); // minimal boot (wallpaper only)
  m.run();
  // the desktop no longer auto-opens the explorer; open it as the 📁 Files launcher
  // does (=explorerwin) so the explorer-window tests have their subject.
  await resolveFn(state, "setValue")(state, "元.draft", "=explorerwin()");
  await resolveFn(state, "origin.run")(state, "explorer.run");
  for (let i = 0; i < 6; i++) { await resolveFn(state, "runCycle")(state); if (state.cels.get("genesis.commit")) await resolveFn(state, "drain")(state, "genesis.commit"); }
  m.run();
  await resolveFn(state, "explorer.refresh")(state); // populate the explorer's initial listing
  m.run();
  return { state, root, m };
};

const put = async (state, m, src, key) => {
  await resolveFn(state, "origin.edit")(state, key); m.run();
  await resolveFn(state, "setValue")(state, "元.draft", src);
  await resolveFn(state, "origin.run")(state, key);
  m.run();
};

// ── 1. wallpaper loads FROM an OPFS file ─────────────────────────────────────

test("desktop bg renders the shipped wallpaper data-URI as the fallback (no OPFS seeding)", async () => {
  const { state } = await boot();
  // The wallpaper is now rendered by the desktop origin-application's desktop.bg
  // verb (a surface div over an img): a "/path" src loads from OPFS, an empty one
  // falls through to the shipped windows.wallpaper data-URI, painted straight.
  const surface = resolveFn(state, "desktop.bg")("", state.cels.get("windows.wallpaper").v);
  const img = surface.children[0];
  assert.equal(img.tag, "img");
  assert.ok(String(img.attrs?.src ?? "").startsWith("data:"), "empty wallpaper → the shipped data-URI, painted without OPFS");
});

// ── 2. upload + download cels render their controls ──────────────────────────

test("upload() renders a file input; download() renders a download button", async () => {
  const { state } = await boot();
  const up = resolveFn(state, "upload")("/");
  assert.equal(up.tag, "input");
  assert.equal(up.attrs.type, "file");
  assert.equal(up.events.change.dispatch, "explorer.upload");
  assert.equal(up.events.change.payload, "/");

  const dn = resolveFn(state, "download")("/desktop/wallpaper.jpg");
  assert.equal(dn.tag, "button");
  assert.equal(dn.events.click.dispatch, "explorer.download");
  assert.equal(dn.events.click.payload, "/desktop/wallpaper.jpg");
  assert.match(txtV(dn), /wallpaper\.jpg/);
});

// (the boot "files" demo worksheet — files.A1=upload / files.A2=download — was
// dropped from the minimal desktop. The upload()/download() verbs' rendering is
// covered by the direct verb tests above; file management is the 📁 Files explorer.)

// ── 3. explorer verb lists OPFS entries ──────────────────────────────────────

test("explorer() renders OPFS folders + files from a listing as a dom value", async () => {
  const { state } = await boot();
  // explorer is a PURE render fn: given a listing it builds the vnode.
  const listing = { entries: [{ name: "sub", isDir: true }, { name: "hello.txt", isDir: false }], previewText: "" };
  const val = resolveFn(state, "explorer")("/", "", listing);
  assert.ok(val && typeof val === "object", "explorer returns a vnode");
  const all = txtV(val);
  assert.match(all, /sub\//, "the folder is listed (with a trailing /)");
  assert.match(all, /hello\.txt/, "the file is listed");
  // BOTH row kinds hold a clickable name span + per-row action buttons
  // (dir rows gained a recursive 🗑 — the nav click moved into the name span).
  const dirRow = walkV(val, (n) => String(n.attrs?.class ?? "").includes("fe-dir"))[0];
  const dirName = walkV(dirRow, (n) => String(n.attrs?.class ?? "").includes("fe-name"))[0];
  const fileName = walkV(val, (n) => String(n.attrs?.class ?? "").includes("fe-file"))
    .flatMap((row) => walkV(row, (n) => String(n.attrs?.class ?? "").includes("fe-name")))[0];
  assert.equal(dirName?.events?.click?.dispatch, "explorer.nav", "folders descend");
  assert.equal(fileName?.events?.click?.dispatch, "explorer.open", "files preview");
  // per-row action buttons render: delete / rename / download / rmdir
  const acts = walkV(val, (n) => String(n.attrs?.class ?? "").includes("fe-act"));
  const dispatches = acts.map((a) => a.events?.click?.dispatch);
  assert.ok(dispatches.includes("explorer.delete"), "a 🗑 delete button renders");
  assert.ok(dispatches.includes("explorer.rename"), "a ✎ rename button renders");
  assert.ok(dispatches.includes("explorer.download"), "a ⬇ download button renders");
  assert.ok(dispatches.includes("explorer.rmdir"), "a 🗑 recursive delete renders on the dir row");
});

test("the explorer window lists real OPFS entries + descends reactively", async () => {
  const { state } = await boot();
  // populate an OPFS directory, then drive the navigation handlers (which read
  // OPFS and write explorer.listing → the content formula re-fires).
  await resolveFn(state, "fs.mkdir")(p("sub"));
  await resolveFn(state, "fs.writeText")(p("hello.txt"), "world");

  await resolveFn(state, "explorer.nav")(state, p(""));
  assert.equal(state.cels.get("explorer.cwd")?.v, p(""), "cwd updated");
  const listing = state.cels.get("explorer.listing")?.v;
  const names = (listing?.entries ?? []).map((e) => e.name);
  assert.ok(names.includes("sub"), "fs.list found the folder");
  assert.ok(names.includes("hello.txt"), "fs.list found the file");
  // the window content (a reactive formula over explorer.cwd/listing) re-rendered
  const content = state.cels.get("win.explorer.content")?.v;
  assert.match(txtV(content), /sub\//, "the explorer window now shows the folder");
  assert.match(txtV(content), /hello\.txt/, "the explorer window now shows the file");

  // open the file → preview pane cats it
  await resolveFn(state, "explorer.open")(state, p("hello.txt"));
  assert.equal(state.cels.get("explorer.preview")?.v, p("hello.txt"), "preview path set");
  assert.equal(state.cels.get("explorer.listing")?.v?.previewText, "world", "the file was cat'd into the preview");
  assert.match(txtV(state.cels.get("win.explorer.content")?.v), /world/, "the preview pane shows the file text");
});

test("the boot desktop opens a standalone explorer window wired to explorer.cwd", async () => {
  const { state } = await boot();
  assert.equal(state.cels.get("explorer.cwd")?.v, "/", "explorer.cwd seeded at /");
  assert.equal(state.cels.get("explorer.preview")?.v, "", "explorer.preview seeded empty");
  // the content cel's formula references the nav cels (so click-to-descend
  // re-fires). The explorer fires once at boot, so the cel now holds the
  // rendered vnode VALUE; its inputMap still carries the explorer.cwd dep.
  const content = state.cels.get("win.explorer.content");
  assert.ok(content, "the explorer window has a content cel");
  const im = content.metadata?.inputMap ?? {};
  const deps = Object.values(im).flat().map(String);
  assert.ok(deps.includes("explorer.cwd"), "content reacts to explorer.cwd");
  assert.ok(deps.includes("explorer.preview"), "content reacts to explorer.preview");
  // and it rendered the explorer (a file-explorer vnode), not an error
  assert.match(txtV(content.v), /📂/, "the explorer rendered its current-dir bar");
});

// ── 4. binary-preview guard ──────────────────────────────────────────────────

test("a .wasm file is NOT text-previewed — the preview shows a binary placeholder + download", async () => {
  const { state } = await boot();
  // a real WASM magic-byte header (\0asm) — invalid UTF-8 too, but the .wasm ext
  // alone must already trip the guard so we never decode the bytes.
  const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff, 0xfe]);
  await resolveFn(state, "fs.write")(p("mod.wasm"), wasm);

  await resolveFn(state, "explorer.nav")(state, p(""));
  await resolveFn(state, "explorer.open")(state, p("mod.wasm"));
  const listing = state.cels.get("explorer.listing")?.v;
  assert.equal(listing?.previewBinary, true, "the .wasm preview is flagged binary");
  assert.match(String(listing?.previewText ?? ""), /^binary file/, "the preview is a placeholder, not the decoded bytes");
  assert.match(String(listing?.previewText ?? ""), /wasm/, "the placeholder names the extension");
  // the rendered preview pane shows a download button, not the bytes
  const content = state.cels.get("win.explorer.content")?.v;
  const dl = walkV(content, (n) => String(n.attrs?.class ?? "").includes("fe-dl"))[0];
  assert.ok(dl, "the binary preview renders a download button");
  assert.equal(dl?.events?.click?.dispatch, "explorer.download", "download wired to the per-file download dispatch");
});

test("a .wad file is never read as text either (extension guard)", async () => {
  const { state } = await boot();
  await resolveFn(state, "fs.write")(p("level.wad"), new Uint8Array([0x49, 0x57, 0x41, 0x44, 0x00, 0x01]));
  await resolveFn(state, "explorer.nav")(state, p(""));
  await resolveFn(state, "explorer.open")(state, p("level.wad"));
  const listing = state.cels.get("explorer.listing")?.v;
  assert.equal(listing?.previewBinary, true, ".wad flagged binary");
  assert.match(String(listing?.previewText ?? ""), /binary file/, ".wad shows the placeholder");
});

test("a small valid-UTF-8 text file IS previewed (the guard doesn't over-block)", async () => {
  const { state } = await boot();
  await resolveFn(state, "fs.writeText")(p("notes.txt"), "hello world");
  await resolveFn(state, "explorer.nav")(state, p(""));
  await resolveFn(state, "explorer.open")(state, p("notes.txt"));
  const listing = state.cels.get("explorer.listing")?.v;
  assert.equal(listing?.previewBinary, false, "a small text file is not binary");
  assert.equal(listing?.previewText, "hello world", "the text file IS previewed");
});

// ── 5. per-file delete / rename ──────────────────────────────────────────────

test("explorerDelete removes a file and refreshes the listing", async () => {
  const { state } = await boot();
  await resolveFn(state, "fs.writeText")(p("doomed.txt"), "x");
  await resolveFn(state, "explorer.nav")(state, p(""));
  let names = (state.cels.get("explorer.listing")?.v?.entries ?? []).map((e) => e.name);
  assert.ok(names.includes("doomed.txt"), "the file is listed before delete");

  await resolveFn(state, "explorer.delete")(state, p("doomed.txt"));
  assert.equal(await resolveFn(state, "fs.exists")(p("doomed.txt")), false, "the file was removed from OPFS");
  names = (state.cels.get("explorer.listing")?.v?.entries ?? []).map((e) => e.name);
  assert.ok(!names.includes("doomed.txt"), "the listing refreshed — the file is gone");
});

test("explorerRename moves a file (prompt-driven) and refreshes", async () => {
  const { state } = await boot();
  globalThis.prompt = () => "renamed.txt"; // stub the browser prompt
  try {
    await resolveFn(state, "fs.writeText")(p("orig.txt"), "data");
    await resolveFn(state, "explorer.nav")(state, p(""));
    await resolveFn(state, "explorer.rename")(state, p("orig.txt"));
    assert.equal(await resolveFn(state, "fs.exists")(p("orig.txt")), false, "old name gone");
    assert.equal(await resolveFn(state, "fs.exists")(p("renamed.txt")), true, "new name exists");
    assert.equal(await resolveFn(state, "fs.readText")(p("renamed.txt")), "data", "bytes preserved");
    const names = (state.cels.get("explorer.listing")?.v?.entries ?? []).map((e) => e.name);
    assert.ok(names.includes("renamed.txt"), "the listing refreshed with the new name");
  } finally { delete globalThis.prompt; }
});

// (seedIndexHtml removed — the explorer shows real user files, not the page's
//  own served HTML; nothing is seeded into OPFS at boot.)

// cleanup the test subtree
test("cleanup", async () => {
  const { state } = await boot();
  const root = state.cels.get("file-store.root").v;
  if (root) await fs.rm(path.resolve(root, TEST_PREFIX), { recursive: true, force: true });
});
