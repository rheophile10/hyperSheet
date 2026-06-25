import type { 甲骨, Cel, Fn, State, VNode } from "../../../types/index.js";
import { bindNativeFns, resolveFn, ensureSegments, hasSegment, getSegmentManifest } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// sheetapp — the worksheet origin-application as a REAL segment (windowing-cutover.md
// Stage 4). It owns the document lifecycle that used to live in the `origin`
// application: open a stored document (opendoc), create a blank one (newsheet),
// render a worksheet window over a document segment's grid (sheetdoc), and the
// save-on-close wiring (wireDocFlush). Documents are origin-user segments stamped
// `applications: ["sheetapp"]`; this segment is their parent program.
//
// Everything cross-segment is reached at runtime via resolveFn (origin.run /
// setValue / window.raise / the user-space-ops lifecycle), so sheetapp does not
// import origin — origin instead depends on sheetapp (loaded at boot; 元 itself
// becomes a sheetapp instance). The verb KEYS keep their historical names
// (origin.opendoc / origin.newsheet / sheetdoc) but are now OWNED here.
// ============================================================================

// worksheet coordinate helpers (copied from origin's grid vocabulary).
const wsCol = (addr: string): number => { const m = addr.match(/^([A-Z]+)/); if (!m) return 0; let n = 0; for (const ch of m[1]!) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const wsRow = (addr: string): number => Number((addr.match(/(\d+)$/) ?? [])[1] ?? 1) - 1;
const addrOf = (key: string): string => key.slice(key.lastIndexOf(".") + 1);

interface WinChip { ref?: string; title?: string; icon?: string; min?: number; closed?: number; dockedIn?: string }

// the user-space segments that make up a document: the primary + its loaded
// user-space deps (e.g. turtle_charts pulls in turtle_data), so a multi-segment
// doc renders all its sheets stacked in one window. Deps first (the data), then
// the primary (e.g. the charts that read it).
const docRenderSegs = (state: State, primary: string): string[] => {
  const m = getSegmentManifest(state, primary) as { dependencies?: string[] } | undefined;
  const deps = (m?.dependencies ?? []).filter((d) => {
    const dm = getSegmentManifest(state, d) as { role?: string } | undefined;
    return dm?.role === "user-space" && [...state.cels.keys()].some((k) => k.startsWith(d + "."));
  });
  return [...deps, primary];
};
const gridKeysOf = (state: State, seg: string): string[] =>
  [...state.cels.keys()].filter((k) => k.startsWith(seg + ".") && /^[A-Z]+\d+$/.test(addrOf(k)))
    .sort((a, b) => wsRow(addrOf(a)) - wsRow(addrOf(b)) || wsCol(addrOf(a)) - wsCol(addrOf(b)));
const singleGrid = (state: State, seg: string): string => {
  const keys = gridKeysOf(state, seg);
  // variadic 'seg.A1', seg.A1, … — infix has no array literal, and each ref makes
  // the grid reactive to that cel. gridopts(元.editing, 元.selected) makes the grid
  // EDITABLE (active cell → inline editor; click → select) and re-render reactively
  // as the editing/selected cell changes (handlers default to origin.* in sheetgrid).
  return `sheetpane(sheetbar(sheet.selected, sheet.draft, writableBy(keystore.identity, ${seg}.writers)), sheetgrid('${seg}', sheetcells(${keys.map((k) => `'${k}', ${k}`).join(", ")}), gridopts(sheet.editing, sheet.selected)))`;
};

// sheetdoc(state, seg, title?, offset?) — open a worksheet window over the cels of
// document segment `seg`. The content formula references each grid cel (reactive).
// `offset` cascades the window position (a multi-sheet doc opens one per segment).
// Idempotent (re-open un-hides + raises). Window (program) is win.<seg>.
const sheetdocFn: Fn = (async (state: State, segArg?: unknown, titleArg?: unknown, offsetArg?: unknown): Promise<State> => {
  const seg = String(segArg ?? "");
  if (!seg) return state;
  await ensureSegments(state, ["sheets", "window"]);
  const sref = `win.${seg}.state`;
  if (!state.cels.get(sref)) {
    const off = (Number(offsetArg) || 0) * 38;
    const title = String(titleArg ?? seg);
    const content = `=${singleGrid(state, seg)}`;
    await (resolveFn(state, "origin.run") as Fn)(state, `${seg}.docwin.元`,
      `=wopen('${seg}', '${title}', "${content}", geom(${140 + off}, ${88 + off}, 600, 420))`);
  } else {
    const cur = (state.cels.get(sref)?.v ?? {}) as WinChip;
    await (resolveFn(state, "setValue") as Fn)(state, sref, { ...cur, closed: 0, min: 0 });
    await (resolveFn(state, "window.raise") as Fn)(state, sref);
  }
  await (resolveFn(state, "view.refresh") as Fn)(state);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
}) as Fn;

// wireDocFlush — make a doc worksheet window SAVE + EVICT its document on close.
// The window segment's close runs each tab's flush cel; sheetdoc's tab content is
// win.<doc>.content, so its flush key is win.<doc>.flush. Install a lambda there
// that saveUserSpace's (records edits) then closeUserSpace's (evicts the closure).
const wireDocFlush = async (state: State, doc: string): Promise<void> => {
  const key = `win.${doc}.flush`;
  if (state.cels.get(key)) return;
  const fn = (async (s: State): Promise<void> => {
    try { const save = resolveFn(s, "saveUserSpace") as Fn | undefined; if (save) await save(s, doc); } catch { /* unsaved beats a thrown close */ }
    try { const close = resolveFn(s, "closeUserSpace") as Fn | undefined; if (close) await close(s, doc); } catch { /* evict best-effort */ }
  }) as Fn;
  await (resolveFn(state, "setCel") as Fn)(state, key, { celType: "LockedLambdaCel", locked: true, fn, metadata: { key, segment: `win.${doc}`, name: "flush", kind: "native" } });
};

// A document segment renders into the LEFT (worksheet) pane by default, or the
// RIGHT (dom-view) pane when its manifest declares `pane: "viz"`. A viz segment's
// grid still shows the dom vnodes its formulas paint (canvases, buttons that
// dispatch cel writes) — it just sits in the view stack instead of the sheet stack.
const paneOf = (state: State, seg: string): string =>
  (getSegmentManifest(state, seg) as { pane?: string } | undefined)?.pane === "viz" ? "viz" : "sheet";

// renderWorkbook — open (or restore) ONE workbook window for document `primary`:
// its render segments split into sheet tabs (left) ‖ view tabs (right), each tab a
// content cel rendering that segment's grid (reactive to its cels). Closing the
// window runs win.<primary>.flush (save + evict). Replaces the old one-window-per-
// segment cascade with a single tabbed two-pane workbook.
const renderWorkbook = async (state: State, primary: string, title: string): Promise<void> => {
  const sref = `win.${primary}.state`;
  if (state.cels.get(sref)) {                          // already open → restore + raise
    const cur = (state.cels.get(sref)?.v ?? {}) as WinChip;
    await (resolveFn(state, "setValue") as Fn)(state, sref, { ...cur, closed: 0, min: 0 });
    await (resolveFn(state, "window.raise") as Fn)(state, sref);
  } else {
    const segs = docRenderSegs(state, primary);
    const setCel = resolveFn(state, "setCel") as Fn;
    const mkTabs = async (list: string[]): Promise<{ ref: string; title: string }[]> => {
      const tabs: { ref: string; title: string }[] = [];
      for (const seg of list) {
        const cref = `win.${primary}.view.${seg}`;
        if (!state.cels.get(cref)) {
          await setCel(state, cref, { celType: "FormulaCel", f: `=${singleGrid(state, seg)}`, metadata: { key: cref, segment: `win.${primary}`, name: `view.${seg}`, parser: "infix" } });
        }
        tabs.push({ ref: cref, title: seg });
      }
      return tabs;
    };
    const sheetTabs = await mkTabs(segs.filter((s) => paneOf(state, s) === "sheet"));
    const vizTabs = await mkTabs(segs.filter((s) => paneOf(state, s) === "viz"));
    const g = (resolveFn(state, "wbopen") as Fn)(primary, title, sheetTabs, vizTabs, { __geom: { x: 120, y: 64, w: 820, h: 540 } }) as { cels: Record<string, { v?: Record<string, unknown> }> };
    const sv = g.cels[`win.${primary}.state`]?.v;       // inject the workbook toolbar (💾 Save)
    if (sv) sv.tools = [
      { icon: "💾", title: "Save this workbook", dispatch: "sheetapp.save" },
      { icon: "🔐", title: "Encrypt + download this workbook (.sealed)", dispatch: "sheetapp.seal" },
      { icon: "🔑", title: "Open an encrypted .sealed file with your key", dispatch: "sheetapp.openSealed" },
      { icon: "📡", title: "Go live — collaborate on this sheet in real time", dispatch: "sheetapp.golive" },
      { icon: "🤝", title: "Grant the connected peer write access + the sheet key", dispatch: "sheetapp.grant" },
    ];
    await (resolveFn(state, "setCelBatch") as Fn)(state, g.cels);
  }
  await wireDocFlush(state, primary);                  // closing the window saves + evicts the doc
  await (resolveFn(state, "view.refresh") as Fn)(state);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
};

// origin.opendoc(state, name) — open a sheetapp DOCUMENT: load the origin-user
// segment from the store (loadUserSpace hydrates BOTH its parent app sheetapp and
// the doc's own cels), then render it as a tabbed two-pane workbook.
const opendocFn: Fn = (async (state: State, nameArg?: unknown): Promise<State> => {
  const name = String(nameArg ?? "");
  if (!name) return state;
  await ensureSegments(state, ["segment-store", "opfs-seeding", "user-space-ops", "origin-lifecycle", "sheets", "window"]);
  if (!hasSegment(state, name)) {
    const load = resolveFn(state, "loadUserSpace") as Fn | undefined;
    if (!load) throw new Error("sheetapp.opendoc: loadUserSpace not installed");
    await load(state, name);
  }
  await renderWorkbook(state, name, name);
  return state;
}) as Fn;

// origin.newsheet(state) — the Sheet app: create a fresh blank worksheet DOCUMENT
// (a new origin-user segment of sheetapp), seed an empty grid, and render it as a
// (one-pane) workbook. Save it later with origin.savedoc; close flushes it.
const newsheetFn: Fn = (async (state: State): Promise<State> => {
  await ensureSegments(state, ["segment-store", "opfs-seeding", "user-space-ops", "sheets", "window"]);
  if (!hasSegment(state, "sheetapp")) await (resolveFn(state, "hydrate-closure") as Fn)(state, "sheetapp");
  const has = resolveFn(state, "store.has") as Fn;
  let n = 1, name = "sheet1";
  while (state.cels.has(`${name}.A1`) || (await (has(state, name) as Promise<boolean>))) name = `sheet${++n}`;
  await (resolveFn(state, "newUserSpace") as Fn)(state, name, "sheetapp", { autoSave: false });
  const specs: Record<string, unknown> = {};
  for (let r = 1; r <= 12; r++) for (let c = 0; c < 7; c++) { const k = `${name}.${String.fromCharCode(65 + c)}${r}`; specs[k] = { celType: "ValueCel", v: "", metadata: { key: k, segment: name } }; }
  await (resolveFn(state, "setCelBatch") as Fn)(state, specs);
  await renderWorkbook(state, name, name);
  return state;
}) as Fn;

// sheetapp.save(state, ref) — the workbook 💾 button: derive the document from the
// window ref (win.<doc>.state) and saveUserSpace it (dehydrate its private closure
// → the OPFS segment store). Reopen from OPFS later with origin.opendoc, or export
// the stored archive for an external-file upload.
const savewbFn: Fn = (async (state: State, refArg?: unknown): Promise<State> => {
  const ref = String(refArg ?? "");
  const doc = ref.replace(/^win\./, "").replace(/\.state$/, "");
  if (!doc) return state;
  await ensureSegments(state, ["segment-store", "user-space-ops"]);
  const save = resolveFn(state, "saveUserSpace") as Fn | undefined;
  if (typeof save === "function") await save(state, doc);
  return state;
}) as Fn;

// sheetapp.seal(state, ref) — the 🔒 button: envelope-encrypt this workbook's
// document to your identity (sheetkeys.sealsheet) and DOWNLOAD it as <doc>.sealed.
// Unlock your identity (👤 Profile) first; if locked, this opens the profile window.
interface DLHost { document?: { createElement(t: string): { href: string; download: string; type?: string; accept?: string; click(): void; onchange?: ((e: unknown) => void) | null; files?: ArrayLike<{ text(): Promise<string> }> } }; URL?: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void }; Blob?: new (parts: unknown[], o: unknown) => unknown }
const sealwbFn: Fn = (async (state: State, refArg?: unknown): Promise<State> => {
  const doc = String(refArg ?? "").replace(/^win\./, "").replace(/\.state$/, "");
  if (!doc) return state;
  await ensureSegments(state, ["sheetkeys", "keystore", "crypto"]);
  if (state.cels.get("keystore.status")?.v !== "unlocked") {
    const pw = resolveFn(state, "profilewin") as Fn | undefined;
    if (pw) await (resolveFn(state, "origin.navOpen") as Fn)(state, "app:profileapp");
    return state;   // unlock, then press 🔒 again
  }
  const r = await (resolveFn(state, "sheetkeys.sealsheet") as Fn)(state, doc) as { ok: boolean; blob?: string };
  const g = globalThis as DLHost;
  if (r.ok && r.blob && g.document && g.URL?.createObjectURL && g.Blob) {
    const url = g.URL.createObjectURL(new g.Blob([r.blob], { type: "application/json" }));
    const a = g.document.createElement("a"); a.href = url; a.download = `${doc}.sealed`; a.click(); g.URL.revokeObjectURL(url);
  }
  return state;
}) as Fn;

// sheetapp.openSealed(state) — the 🔓 button: pick a .sealed file, decrypt it with
// your identity (sheetkeys.opensheet), and open it as a workbook.
const openSealedFn: Fn = (async (state: State): Promise<State> => {
  await ensureSegments(state, ["sheetkeys", "keystore", "crypto"]);
  if (state.cels.get("keystore.status")?.v !== "unlocked") { await (resolveFn(state, "origin.navOpen") as Fn)(state, "app:profileapp"); return state; }
  const g = globalThis as DLHost;
  if (!g.document) return state;
  const inp = g.document.createElement("input") as unknown as { type: string; accept: string; click(): void; onchange: ((e: unknown) => void) | null; files?: ArrayLike<{ text(): Promise<string> }> };
  inp.type = "file"; inp.accept = ".sealed,application/json";
  inp.onchange = async () => { const f = inp.files?.[0]; if (!f) return; try { await (resolveFn(state, "sheetkeys.opensheet") as Fn)(state, await f.text()); } catch { /* not a sealed file */ } };
  inp.click();
  return state;
}) as Fn;

// the doc this window ref points at, + a guard that opens the profile window when
// the identity is locked (collaboration needs a signing identity).
const docOf = (ref: unknown): string => String(ref ?? "").replace(/^win\./, "").replace(/\.state$/, "");
const needsUnlock = async (state: State): Promise<boolean> => {
  if (state.cels.get("keystore.status")?.v === "unlocked") return false;
  await (resolveFn(state, "origin.navOpen") as Fn)(state, "app:profileapp");
  return true;
};
const setTitle = async (state: State, doc: string, title: string): Promise<void> => {
  const sref = `win.${doc}.state`; const cur = state.cels.get(sref)?.v as Record<string, unknown> | undefined;
  if (cur) await (resolveFn(state, "setValue") as Fn)(state, sref, { ...cur, title });
};

// sheetapp.golive(state, ref) — the 📡 button: take this workbook LIVE. Make the
// doc collaborative (writers = [me] if unset, so edits route through the CRDT
// pipeline + record ops), join a room derived from the doc name via the signaling
// relay (peerjoin), and register the sheetsync inbound routes (sheetsync.connect).
// A peer who opens the same-named sheet + goes live lands in the same room.
const goliveFn: Fn = (async (state: State, refArg?: unknown): Promise<State> => {
  const doc = docOf(refArg); if (!doc) return state;
  await ensureSegments(state, ["peer", "sheetsync", "keystore", "crypto", "sheetkeys", "crdt", "sheets"]);
  if (await needsUnlock(state)) return state;
  const me = String(state.cels.get("keystore.identity")?.v ?? "");
  const writers = state.cels.get(`${doc}.writers`)?.v;
  if (!Array.isArray(writers) || writers.length === 0) {
    await (resolveFn(state, "setCel") as Fn)(state, `${doc}.writers`, { celType: "ValueCel", v: [me], metadata: { key: `${doc}.writers`, segment: doc, name: "writers" } });
  }
  const room = `plastron-${doc}`;
  // relay: respect an explicitly-set sheetsync.relay; but when it's the localhost
  // DEFAULT, derive it from the page's own host so a LAN/second-device client
  // (served from http://<lan-ip>:5174) reaches the relay at ws://<lan-ip>:8787
  // rather than its own localhost.
  const DEFAULT_RELAY = "ws://localhost:8787";
  const relayCel = String(state.cels.get("sheetsync.relay")?.v ?? "");
  const loc = (globalThis as { location?: { hostname?: string } }).location?.hostname;
  const relay = (relayCel && relayCel !== DEFAULT_RELAY) ? relayCel
    : (loc && loc !== "localhost" && loc !== "127.0.0.1" ? `ws://${loc}:8787` : DEFAULT_RELAY);
  if (typeof resolveFn(state, "peerjoin") === "function") (resolveFn(state, "peerjoin") as Fn)(state, room, relay);
  await (resolveFn(state, "sheetsync.connect") as Fn)(state);
  await (resolveFn(state, "setValue") as Fn)(state, "sheetsync.room", room);
  await setTitle(state, doc, `${doc} ● live`);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
}) as Fn;

// sheetapp.grant(state, ref) — the 🤝 button: give the connected peer(s) write
// access to this sheet. Add each present peer (sheetsync.peers) to <doc>.writers,
// then ECDH-wrap + send them the sheet data key + writers + current op-log
// (sheetsync.share). After this, both peers' edits flow encrypted over the wire.
const grantFn: Fn = (async (state: State, refArg?: unknown): Promise<State> => {
  const doc = docOf(refArg); if (!doc) return state;
  await ensureSegments(state, ["peer", "sheetsync", "keystore", "crypto", "sheetkeys", "crdt"]);
  if (await needsUnlock(state)) return state;
  const peers = (state.cels.get("sheetsync.peers")?.v ?? []) as { id?: string; ecdh?: string }[];
  if (!Array.isArray(peers) || peers.length === 0) { await setTitle(state, doc, `${doc} ● live (no peer yet)`); return state; }
  const me = String(state.cels.get("keystore.identity")?.v ?? "");
  const cur = (state.cels.get(`${doc}.writers`)?.v ?? []) as string[];
  const writers = [...new Set([me, ...(Array.isArray(cur) ? cur.map(String) : []), ...peers.map((p) => String(p.id ?? "")).filter(Boolean)])];
  await (resolveFn(state, "setCel") as Fn)(state, `${doc}.writers`, { celType: "ValueCel", v: writers, metadata: { key: `${doc}.writers`, segment: doc, name: "writers" } });
  for (const p of peers) if (p.ecdh) await (resolveFn(state, "sheetsync.share") as Fn)(state, doc, p.ecdh);
  await setTitle(state, doc, `${doc} ● live (${peers.length})`);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
}) as Fn;

export const name = "sheetapp" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sheetapp.save",   savewbFn],
  ["sheetapp.seal",   sealwbFn],
  ["sheetapp.openSealed", openSealedFn],
  ["sheetapp.golive", goliveFn],
  ["sheetapp.grant",  grantFn],
  ["sheetdoc",        sheetdocFn],
  ["origin.opendoc",  opendocFn],
  ["origin.newsheet", newsheetFn],
]));

// keep VNode import meaningful for future workbook render verbs (Stage 4b).
export type { VNode };
