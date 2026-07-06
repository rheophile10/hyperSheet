import type { 甲骨, Cel, Fn, State, VNode } from "../../../types/index.js";
import { bindNativeFns, resolveFn, ensureSegments, hasSegment, getSegmentManifest, disposeCel, precompute } from "../../../kernel/index.js";
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
  // SPARSE: only POPULATED cels are refs; `<seg>.dims` is the rendered range —
  // referencing it makes the grid auto-react to =addCells (a pure dims write).
  // Legacy docs (pre-sparse, no dims cel) omit the ref — an unresolved bare
  // symbol would trap the whole formula — and fall back to populated extent.
  const dimsArg = ["dims", "colw", "rowh"].map((k) => state.cels.has(`${seg}.${k}`) ? `, ${seg}.${k}` : ", 0").join("").replace(/(, 0)+$/, "");
  return `sheetpane(sheetbar(sheet.selected, sheet.draft, writableBy(keystore.identity, ${seg}.writers), signedIn(sb.default.auth)), sheetgrid('${seg}', sheetcells(${keys.map((k) => `'${k}', ${k}`).join(", ")}), gridopts(sheet.editing, sheet.selected, sheet.draft)${dimsArg}))`;
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
    // PRISTINE docs (no populated address cells — a blank sheet opened and
    // closed) are NOT saved: without this every abandoned "sheetN" persists
    // to the store forever. A doc already in the store still re-saves (its
    // cells were populated once; an emptied doc keeps its last saved state).
    const pristine = gridKeysOf(s, doc).length === 0;
    const stored = await ((resolveFn(s, "store.has") as Fn | undefined)?.(s, doc) as Promise<boolean> | undefined ?? false);
    if (!pristine || stored) {
      try { const save = resolveFn(s, "saveUserSpace") as Fn | undefined; if (save) await save(s, doc); } catch { /* unsaved beats a thrown close */ }
    }
    try { const close = resolveFn(s, "closeUserSpace") as Fn | undefined; if (close) await close(s, doc); } catch { /* evict best-effort */ }
    // Destroy the WINDOW segment too: closeUserSpace evicts the doc's cels,
    // but win.<doc>.* (state/frame/content/view tabs — the frame references
    // every grid cel) would otherwise accumulate in state forever. Dispose
    // (unmounts the painted frame) → delete → precompute rebuilds the graph.
    // window.close tolerates this (it skips its closed:1 write when the state
    // cel is gone) and prunes win.registry.
    const prefix = `win.${doc}.`;
    let swept = 0;
    for (const [k, c] of [...s.cels]) {
      if (!k.startsWith(prefix)) continue;
      try { disposeCel(c, s); } catch { /* dispose is best-effort teardown */ }
      s.cels.delete(k); swept++;
    }
    // Evict this doc's contribution SLOTS from every global view pane
    // (<name>.view cels): panes are shared across documents — two docs whose
    // =view cells name the same pane ("fish") otherwise stack a dead slot
    // (stale ▶ buttons) above the live doc's after one of them closes.
    const docSlot = `${doc}.`;
    for (const [k, c] of [...s.cels]) {
      if (!k.endsWith(".view") || c.celType !== "ValueCel") continue;
      const v = c.v as { children?: Array<{ attrs?: Record<string, unknown> }> } | undefined;
      if (!v || !Array.isArray(v.children)) continue;
      const kept = v.children.filter((ch) => !String(ch?.attrs?.["data-cel"] ?? "").startsWith(docSlot));
      if (kept.length !== v.children.length) {
        try { await (resolveFn(s, "setValue") as Fn)(s, k, { ...v, children: kept }); } catch { /* pane update is best-effort */ }
      }
    }
    if (swept) precompute(s);
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
      { icon: "📂", title: "Open a stored document", dispatch: "sheetapp.open" },
      { icon: "💾", title: "Save this workbook", dispatch: "sheetapp.save" },
      { icon: "🔐", title: "Encrypt + download this workbook (.sealed)", dispatch: "sheetapp.seal" },
      { icon: "🔑", title: "Open an encrypted .sealed file with your key", dispatch: "sheetapp.openSealed" },
      { icon: "🕸️", title: "Go live — collaborate on this sheet in real time", dispatch: "sheetapp.golive" },
      { icon: "🤝", title: "Grant the connected peer write access + the sheet key", dispatch: "sheetapp.grant" },
    ];
    await (resolveFn(state, "setCelBatch") as Fn)(state, g.cels);
    // Raise THIS workbook: fresh wbopen cels mint z:1 (bottom of the stack),
    // and openViewPane targets the ACTIVE workbook (falling back to
    // firstWorkbook) — raise sets win.active AND bumps z above every window,
    // so the opened doc lands on top and its =view panes land on itself.
    await (resolveFn(state, "window.raise") as Fn)(state, `win.${primary}.state`);
  }
  await wireDocFlush(state, primary);                  // closing the window saves + evicts the doc
  await (resolveFn(state, "view.refresh") as Fn)(state);
  // land request→effect formulas (=view contributions) so the doc's view tabs
  // materialize on open; drain LAST, then paint — a runCycle after the drain
  // re-fires the generative cells back to pending requests before the paint.
  const drain = resolveFn(state, "drain") as Fn, runCycle = resolveFn(state, "runCycle") as Fn;
  for (let i = 0; i < 6; i++) {
    await runCycle(state);
    if (state.cels.get("genesis.commit")) await drain(state, "genesis.commit");
    if (state.cels.get("origin.effects")) await drain(state, "origin.effects");
  }
  await (resolveFn(state, "view.refresh") as Fn)(state);  // the =view tabs' content cels enter the scan
  await runCycle(state);
  if (state.cels.get("origin.effects")) await drain(state, "origin.effects");
  // The effects drain just landed the ⧉ tokens, and its cascade recomposed
  // the ROOT view (元.view's vals carry each frame's content cels — origin's
  // rewireView). One more refresh picks up any cels the landing itself
  // birthed (a fresh pane's view cel), then paint.
  await (resolveFn(state, "view.refresh") as Fn)(state);
  await drain(state, "dom.paint");
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
  await renderWorkbook(state, name, name);   // (renderWorkbook settles =view panes)
  return state;
}) as Fn;

// origin.newsheet(state) — the Sheet app: create a fresh SPARSE worksheet DOCUMENT
// (a new origin-user segment of sheetapp) and render it as a (one-pane) workbook.
// Sparse: the only minted cel is `<name>.dims` — addresses are keyed into state
// only when committed. Save it later with origin.savedoc; close flushes it.
const newsheetFn: Fn = (async (state: State): Promise<State> => {
  await ensureSegments(state, ["segment-store", "opfs-seeding", "user-space-ops", "sheets", "window"]);
  if (!hasSegment(state, "sheetapp")) await (resolveFn(state, "hydrate-closure") as Fn)(state, "sheetapp");
  const has = resolveFn(state, "store.has") as Fn;
  let n = 1, name = "sheet1";
  while (state.cels.has(`${name}.dims`) || state.cels.has(`${name}.A1`) || (await (has(state, name) as Promise<boolean>))) name = `sheet${++n}`;
  await (resolveFn(state, "newUserSpace") as Fn)(state, name, "sheetapp", { autoSave: false });
  await (resolveFn(state, "setCel") as Fn)(state, `${name}.dims`, {
    celType: "ValueCel", v: { rows: 50, cols: 12 },
    metadata: { key: `${name}.dims`, segment: name, name: "dims", description: "the sheet's RENDERED range {rows, cols} — sparse: addresses render from dims; a cel exists only once a value/formula is committed. =addCells grows this." },
  });
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

// sheetapp.golive(state, ref) — the 🕸️ button: take this workbook LIVE. Make the
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
  // tell the WHOLE mesh the new writer set (so peers other than the grantee accept
  // the new writer's edits) — a signed, grow-only writers update.
  await (resolveFn(state, "sheetsync.announceWriters") as Fn)(state, doc);
  await setTitle(state, doc, `${doc} ● live (${peers.length})`);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
}) as Fn;

// sheetapp.addsheet(state, {ref, name?, rows?, cols?}) — create a fresh SPARSE
// sheet SEGMENT and add it as a tab to this workbook via the generic
// window.addSheet. Sparse: the ONLY cel minted is `<seg>.dims` ({rows, cols} —
// default 50×12); the grid renders the full range from dims and an address is
// keyed into state only when a value/formula is committed (origin.commit
// births the cel + sheetapp.regrid re-derives the content formula). A `name`
// that already exists is a no-op (idempotent — the =sheet verb re-fires).
const addsheetFn: Fn = (async (state: State, payload?: unknown): Promise<State | string> => {
  const p = (payload ?? {}) as { ref?: string; name?: string; rows?: unknown; cols?: unknown };
  const ref = String(p.ref ?? "");
  const primary = ref.replace(/^win\./, "").replace(/\.state$/, "");
  if (!primary) return state;
  await ensureSegments(state, ["sheets", "window"]);
  const wanted = String(p.name ?? "").trim().replace(/[^\w-]/g, "");
  let seg = wanted;
  if (seg) {
    if ([...state.cels.keys()].some((k) => k.startsWith(seg + "."))) return seg; // exists → no-op
  } else {
    let n = 1; seg = "sheet1";
    while ([...state.cels.keys()].some((k) => k.startsWith(seg + "."))) seg = `sheet${++n}`;   // globally-fresh name
  }
  const rows = Math.max(1, Math.min(500, Math.trunc(Number(p.rows) || 50)));
  const cols = Math.max(1, Math.min(52, Math.trunc(Number(p.cols) || 12)));
  await (resolveFn(state, "setCel") as Fn)(state, `${seg}.dims`, {
    celType: "ValueCel", v: { rows, cols },
    metadata: { key: `${seg}.dims`, segment: seg, name: "dims", description: "the sheet's RENDERED range {rows, cols} — sparse: addresses render from dims; a cel exists only once a value/formula is committed. =addCells grows this." },
  });
  await (resolveFn(state, "window.addSheet") as Fn)(state, { ref, viewRef: `win.${primary}.view.${seg}`, title: seg, f: `=${singleGrid(state, seg)}` });
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return seg;
}) as Fn;

// sheetapp.regrid(state, seg) — re-derive a sheet's content formula after a cel
// is BORN into (or removed from) the segment: swap the sheetcells(...) ref list
// inside every workbook tab formula that renders `seg`. Regex surgery is safe —
// sheetcells args are only quoted keys + bare refs, never nested parens.
const regridFn: Fn = (async (state: State, segArg?: unknown): Promise<State> => {
  const seg = String(segArg ?? "");
  if (!seg) return state;
  const refs = gridKeysOf(state, seg).map((k) => `'${k}', ${k}`).join(", ");
  const pat = new RegExp(`^win\\..+\\.view\\.${seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  for (const k of [...state.cels.keys()]) {
    if (!pat.test(k)) continue;
    const f = (state.cels.get(k) as { f?: string } | undefined)?.f;
    if (typeof f !== "string" || !f.includes("sheetcells(")) continue;
    const next = f.replace(/sheetcells\([^)]*\)/, `sheetcells(${refs})`);
    if (next !== f) await (resolveFn(state, "setValue") as Fn)(state, k, next);
  }
  return state;
}) as Fn;

// the seg behind a workbook sheet tab (win.<wb>.view.<seg>).
const segOfTab = (ref: unknown): string => { const r = String(ref ?? ""); return r.includes(".view.") ? r.split(".view.").slice(1).join(".view.") : ""; };

// sheetapp.renamesheet(state, {ref, index, name}) — rename a sheet by ALIAS, NOT by
// re-keying cels (re-keying every cell on a name change is expensive + fragile). The
// tab's display title becomes `name` and the segment records a `<seg>.alias` cel (so
// a later save can name the file that). The cell keys stay <seg>.A1 — formulas are
// untouched. (A formula-resolvable alias is a separate, opt-in step.)
const renamesheetFn: Fn = (async (state: State, payload?: unknown): Promise<State> => {
  const p = payload as { ref?: string; index?: number; name?: string };
  const ref = String(p?.ref ?? ""); const idx = Number(p?.index ?? -1); const name = String(p?.name ?? "").trim();
  if (!ref || idx < 0 || !name) return state;
  const st = state.cels.get(ref)?.v as { sheets?: Array<{ ref: string; title?: string }> } | undefined;
  const sheets = Array.isArray(st?.sheets) ? [...st!.sheets!] : [];
  const tab = sheets[idx]; if (!tab) return state;
  sheets[idx] = { ...tab, title: name };
  await (resolveFn(state, "setValue") as Fn)(state, ref, { ...st, sheets });
  const seg = segOfTab(tab.ref);
  if (seg) await (resolveFn(state, "setCel") as Fn)(state, `${seg}.alias`, { celType: "ValueCel", v: name, metadata: { key: `${seg}.alias`, segment: seg, name: "alias" } });
  await (resolveFn(state, "runCycle") as Fn)(state); await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
}) as Fn;

// sheetapp.tabmenu(state, {ref,index}, event) — right-click / double-click a worksheet
// tab: open the floating rename box (renameOverlay) seeded with the current name.
const tabmenuFn: Fn = (async (state: State, payload?: unknown, event?: unknown): Promise<State> => {
  const e = event as { preventDefault?: () => void; clientX?: number; clientY?: number } | undefined;
  e?.preventDefault?.();
  const p = payload as { ref?: string; index?: number };
  const ref = String(p?.ref ?? ""); const idx = Number(p?.index ?? 0);
  if (!ref) return state;
  const st = state.cels.get(ref)?.v as { sheets?: Array<{ title?: string }> } | undefined;
  const title = String(st?.sheets?.[idx]?.title ?? "");
  const setCel = resolveFn(state, "setCel") as Fn;
  await setCel(state, "sheetapp.renameui", { celType: "ValueCel", v: { open: true, ref, index: idx, x: Math.round(Number(e?.clientX) || 240), y: Math.round(Number(e?.clientY) || 160) }, metadata: { key: "sheetapp.renameui", segment: "sheetapp", name: "renameui" } });
  await setCel(state, "sheetapp.renamedraft", { celType: "ValueCel", v: title, metadata: { key: "sheetapp.renamedraft", segment: "sheetapp", name: "renamedraft" } });
  // the overlay mounts itself into .origin via a win.*.frame cel (cellKeys whitelists
  // win.*.frame, so the compositor paints it); view.refresh adds it to the view scan.
  if (!state.cels.get("win.renamebox.frame")) await setCel(state, "win.renamebox.frame", { celType: "FormulaCel", f: "=mount('.origin', renameOverlay(sheetapp.renameui, sheetapp.renamedraft))", metadata: { key: "win.renamebox.frame", segment: "win.renamebox", name: "frame", parser: "infix" } });
  await (resolveFn(state, "view.refresh") as Fn)(state);
  await (resolveFn(state, "runCycle") as Fn)(state); await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
}) as Fn;

// sheetapp.applyrename(state, _, event) — commit the rename box (the ✓ button, or
// Enter in the input). Ignores other keys so typing doesn't fire on every keystroke.
const applyrenameFn: Fn = (async (state: State, _payload?: unknown, event?: unknown): Promise<State> => {
  const e = event as { key?: string } | undefined;
  if (e && typeof e.key === "string" && e.key !== "Enter") return state;
  const ui = state.cels.get("sheetapp.renameui")?.v as { ref?: string; index?: number } | undefined;
  const name = String(state.cels.get("sheetapp.renamedraft")?.v ?? "").trim();
  if (ui?.ref && name) await renamesheetFn(state, { ref: ui.ref, index: ui.index, name });
  await (resolveFn(state, "setValue") as Fn)(state, "sheetapp.renameui", { open: false });
  await (resolveFn(state, "runCycle") as Fn)(state); await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
}) as Fn;

export const name = "sheetapp" as const;
// sheetapp.open — the workbook 📂 button: a picker window over the OPFS segment
// store's DOCUMENTS (store.list entries carrying an `app` field). Clicking a row
// dispatches sheetapp.pick, which closes the picker and origin.opendoc's the doc.
const V = (tag: string, attrs: Record<string, unknown>, children: unknown[], events?: Record<string, unknown>): Record<string, unknown> =>
  ({ type: "el", tag, attrs, children, ...(events ? { events } : {}) });
const TX = (t: string): Record<string, unknown> => ({ type: "text", text: t });
const openPickerFn: Fn = (async (state: State): Promise<State> => {
  await ensureSegments(state, ["segment-store", "window"]);
  const entries = await ((resolveFn(state, "store.list") as Fn)(state) as Promise<Array<{ name: string; app?: string }>>);
  const docs = entries.filter((e) => e.app).map((e) => e.name).sort();
  const rows = docs.length
    ? docs.map((n) => V("div", { style: "display:flex;align-items:center;gap:.2rem" }, [
        V("button", { style: "flex:1 1 auto;text-align:left;padding:.35rem .6rem;border:0;background:transparent;cursor:pointer;color:CanvasText;font:.85rem ui-monospace,monospace" }, [TX(`📄 ${n}`)], { click: { dispatch: "sheetapp.pick", payload: n } }),
        V("button", { title: `delete ${n} from the store`, style: "flex:0 0 auto;border:0;background:transparent;cursor:pointer;font-size:.8rem;padding:0 .4rem" }, [TX("🗑")], { click: { dispatch: "sheetapp.delete", payload: n } }),
      ]))
    : [V("div", { style: "padding:.6rem;opacity:.7" }, [TX("(no stored documents yet)")])];
  const g = (resolveFn(state, "wopen") as Fn)("sheetopen", "📂 Open a document", "", { __geom: { x: 200, y: 120, w: 340, h: 380 } }) as { cels: Record<string, unknown> };
  (g.cels as Record<string, unknown>)["win.sheetopen.content"] =
    { celType: "ValueCel", v: V("div", { style: "display:flex;flex-direction:column;padding:.3rem" }, rows), metadata: { key: "win.sheetopen.content", segment: "win.sheetopen", name: "content" } };
  await (resolveFn(state, "setCelBatch") as Fn)(state, g.cels);
  // Bring the picker to the TOP of the window stack — a fresh wopen state cel
  // mints z:1, which leaves it BEHIND any open workbook. window.raise bumps z
  // above every window and marks it active (same as clicking its titlebar).
  await (resolveFn(state, "window.raise") as Fn)(state, "win.sheetopen.state");
  await (resolveFn(state, "view.refresh") as Fn)(state);
  await (resolveFn(state, "runCycle") as Fn)(state);
  await (resolveFn(state, "drain") as Fn)(state, "dom.paint");
  return state;
}) as Fn;
// sheetapp.delete — the picker row's 🗑: confirm (when a DOM confirm exists),
// store.del EVERY stored version of the doc, then rebuild the picker list.
// NOTE: deleting a doc that is currently OPEN does not evict its live cels —
// and closing that window re-saves it (wireDocFlush). Delete closed docs.
const deleteDocFn: Fn = (async (state: State, nameArg?: unknown): Promise<State> => {
  const name = String(nameArg ?? "");
  if (!name) return state;
  const confirm = (globalThis as { confirm?: (m: string) => boolean }).confirm;
  if (typeof confirm === "function" && !confirm(`Delete stored document "${name}"? (baked demo docs reinstall on next boot)`)) return state;
  const has = resolveFn(state, "store.has") as Fn, del = resolveFn(state, "store.delete") as Fn;
  for (let i = 0; i < 32 && await (has(state, name) as Promise<boolean>); i++) await del(state, name);
  return (openPickerFn as (s: State) => Promise<State>)(state);   // refresh the list
}) as Fn;
const pickFn: Fn = (async (state: State, nameArg?: unknown): Promise<State> => {
  const cur = (state.cels.get("win.sheetopen.state")?.v ?? {}) as Record<string, unknown>;
  await (resolveFn(state, "setValue") as Fn)(state, "win.sheetopen.state", { ...cur, closed: 1 });
  await (resolveFn(state, "origin.opendoc") as Fn)(state, String(nameArg ?? ""));
  return state;
}) as Fn;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sheetapp.addsheet", addsheetFn],
  ["sheetapp.regrid", regridFn],
  ["sheetapp.renamesheet", renamesheetFn],
  ["sheetapp.tabmenu", tabmenuFn],
  ["sheetapp.applyrename", applyrenameFn],
  ["sheetapp.open",   openPickerFn],
  ["sheetapp.pick",   pickFn],
  ["sheetapp.delete", deleteDocFn],
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
