import { test } from "bun:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// origin — the OPFS desktop phase: the wallpaper loads FROM an OPFS file
// (origin.seedWallpaper writes /desktop/wallpaper.<ext> and points desktop.A2
// at it), upload/download cels render their button/input, and the explorer verb
// lists OPFS entries as a folders-then-files dom value.

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
  await resolveFn(state, "origin.commit")(state, "元"); // materialize the boot desktop genesis
  m.run();
  await resolveFn(state, "origin.explorerRefresh")(state); // populate the explorer's initial listing
  m.run();
  return { state, root, m };
};

const put = async (state, m, src, key) => {
  await resolveFn(state, "origin.edit")(state, key); m.run();
  await resolveFn(state, "setValue")(state, "元.draft", src);
  await resolveFn(state, "origin.commit")(state, key);
  m.run();
};

// ── 1. wallpaper loads FROM an OPFS file ─────────────────────────────────────

test("seedWallpaper writes the wallpaper to OPFS and points desktop.A2 at the file", async () => {
  const { state } = await boot();
  const root = state.cels.get("file-store.root").v;

  // the boot desktop bg is a formula over the wallpaper-path cell + the constant
  const bg = state.cels.get("desktop.A1");
  assert.match(String(bg?.f ?? ""), /\(img desktop\.A2 windows\.wallpaper/, "bg img reads the wallpaper-path cell first");
  assert.equal(state.cels.get("desktop.A2")?.v, "", "wallpaper-path cell ships empty (uses the constant fallback)");

  await resolveFn(state, "origin.seedWallpaper")(state);

  const a2 = state.cels.get("desktop.A2")?.v;
  assert.match(String(a2), /^\/desktop\/wallpaper\./, "desktop.A2 now points at an OPFS file path");

  // the file really exists in the store, and is the decoded image bytes (non-empty)
  const onDisk = path.resolve(root, a2.replace(/^\//, ""));
  const bytes = await fs.readFile(onDisk);
  assert.ok(bytes.length > 100, "the wallpaper file holds real image bytes");

  // and the bg img now references a "/..." OPFS path → painter hydrates it
  const img = resolveFn(state, "img")(a2, state.cels.get("windows.wallpaper").v);
  assert.equal(img.attrs["data-opfs-src"], a2, "the wallpaper img is an OPFS reference now, not a constant");
});

// ── 2. upload + download cels render their controls ──────────────────────────

test("upload() renders a file input; download() renders a download button", async () => {
  const { state } = await boot();
  const up = resolveFn(state, "upload")("/");
  assert.equal(up.tag, "input");
  assert.equal(up.attrs.type, "file");
  assert.equal(up.events.change.dispatch, "origin.upload");
  assert.equal(up.events.change.payload, "/");

  const dn = resolveFn(state, "download")("/desktop/wallpaper.jpg");
  assert.equal(dn.tag, "button");
  assert.equal(dn.events.click.dispatch, "origin.download");
  assert.equal(dn.events.click.payload, "/desktop/wallpaper.jpg");
  assert.match(txtV(dn), /wallpaper\.jpg/);
});

test("the boot desktop seeds a files sheet whose cels render an upload input + download button", async () => {
  const { state, root } = await boot();
  // files.A1 = =upload("/"), files.A2 = =download("/desktop/wallpaper.jpg")
  assert.match(String(state.cels.get("files.A1")?.f ?? ""), /upload/, "files.A1 is an upload cel");
  assert.match(String(state.cels.get("files.A2")?.f ?? ""), /download/, "files.A2 is a download cel");
  const inputs = walk(root, (n) => n.tag === "input" && String(n.attrs.class ?? "").includes("opfs-upload"));
  const btns = walk(root, (n) => n.tag === "button" && String(n.attrs.class ?? "").includes("opfs-btn"));
  assert.ok(inputs.length >= 1, "an OPFS upload input rendered on the desktop");
  assert.ok(btns.length >= 1, "an OPFS download button rendered on the desktop");
});

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
  const dirRow = walkV(val, (n) => String(n.attrs?.class ?? "").includes("fe-dir"))[0];
  const fileRow = walkV(val, (n) => String(n.attrs?.class ?? "").includes("fe-file"))[0];
  assert.equal(dirRow?.events?.click?.dispatch, "origin.explorerNav", "folders descend");
  assert.equal(fileRow?.events?.click?.dispatch, "origin.explorerOpen", "files preview");
});

test("the explorer window lists real OPFS entries + descends reactively", async () => {
  const { state } = await boot();
  // populate an OPFS directory, then drive the navigation handlers (which read
  // OPFS and write explorer.listing → the content formula re-fires).
  await resolveFn(state, "fs.mkdir")(p("sub"));
  await resolveFn(state, "fs.writeText")(p("hello.txt"), "world");

  await resolveFn(state, "origin.explorerNav")(state, p(""));
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
  await resolveFn(state, "origin.explorerOpen")(state, p("hello.txt"));
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

// cleanup the test subtree
test("cleanup", async () => {
  const { state } = await boot();
  const root = state.cels.get("file-store.root").v;
  if (root) await fs.rm(path.resolve(root, TEST_PREFIX), { recursive: true, force: true });
});
