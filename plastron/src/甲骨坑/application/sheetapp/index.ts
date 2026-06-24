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
  // the grid reactive to that cel.
  return `sheetgrid('${seg}', sheetcells(${keys.map((k) => `'${k}', ${k}`).join(", ")}))`;
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
    if (sv) sv.tools = [{ icon: "💾", title: "Save this workbook", dispatch: "sheetapp.save" }];
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

export const name = "sheetapp" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sheetapp.save",   savewbFn],
  ["sheetdoc",        sheetdocFn],
  ["origin.opendoc",  opendocFn],
  ["origin.newsheet", newsheetFn],
]));

// keep VNode import meaningful for future workbook render verbs (Stage 4b).
export type { VNode };
