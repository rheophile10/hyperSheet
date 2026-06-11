import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import { el as makeEl, text as TT } from "../dom/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// docgraph — the documentation graph, rendered as a wiki window.
//
// The unified-metadata-model contract (1-design/1-under-consideration/
// unified-metadata-model.md): ONE graph — metadata.doc/description (shipped
// facts), the dep graph (inputMap), and user notes (metadata.note for now;
// the annotation plane later) — and every surface is a RENDER of it. This
// segment is the assembler + the human render:
//
//   wiki.open (dispatch)  — assemble the article for a key/segment, stash it
//                           in wiki.article, open the win.wiki window, paint.
//                           The W button in every window titlebar dispatches
//                           it with the window's state ref.
//   wiki.saveNote         — write the note draft to the target's metadata
//                           (metadata-only setCel — merges, never touches
//                           inputMap; Layer-1 refusals surface in-article).
//   wiki(name)            — formula verb: a 📖 button that opens the wiki on
//                           name (formulas render affordances; handlers act).
//   wikidoc(article)      — passthrough for win.wiki.content: the article
//                           vnode the handler assembled, or a hint when none.
//
// The win.wiki window cels are NOT seeded — wiki.open creates them on first
// use, and creates the FRAME cel only when `mount` resolves (origin host).
// Seeding a frame that references origin's mount would trap at runCycle in
// every non-origin boot and pollute the error log — the window is lazy by
// design, not just by thrift.
//
// Navigation is handler re-entry: every link in an article (inputs, called
// functions, backlinks, graph nodes, segment members) dispatches wiki.open
// with the next key. The article is assembled AT OPEN TIME (a snapshot, like
// inspect) — navigating refreshes; live re-render is the annotation plane's
// concern, not v1's.
//
// "If it feels like obsidian it's probably good": article + backlinks pane +
// a force-directed neighborhood graph (canvas edges under absolutely-
// positioned clickable node chips) + an editable note on every entry.
// ============================================================================

type V = { type: "el" | "text"; tag?: string; attrs?: Record<string, unknown>; events?: Record<string, unknown>; children?: V[]; text?: string };
const el = makeEl as unknown as (tag: string, attrs?: Record<string, unknown>, children?: V[], events?: Record<string, unknown>) => V;
const T = TT as unknown as (s: string) => V;
const isVnode = (v: unknown): v is V => !!v && typeof v === "object" && ((v as V).type === "el" || (v as V).type === "text");

// ── graph assembly ───────────────────────────────────────────────────────────

const FN_TYPES = new Set(["LockedLambdaCel", "EditableLambdaCel", "CompilerCel"]);
// our own machinery stays out of the graph (a wiki article about the wiki's
// article buffer is noise, not knowledge).
const isInternal = (key: string): boolean => key === "wiki.article" || key === "wiki.noteDraft" || key === "wiki.notes" || key === "wiki.descDraft";

interface CelLike { celType: string; f?: string; v?: unknown; locked?: boolean; metadata: Record<string, unknown> }
const celOf = (state: State, key: string): CelLike | undefined => state.cels.get(key) as unknown as CelLike | undefined;

/** Flatten a cel's inputMap (values are Key | Key[]) into dep keys. */
const inputKeysOf = (cel: CelLike | undefined): string[] => {
  const im = cel?.metadata?.inputMap as Record<string, unknown> | undefined;
  if (!im) return [];
  const out: string[] = [];
  for (const v of Object.values(im)) {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const k of v) if (typeof k === "string") out.push(k);
  }
  return [...new Set(out)];
};

/** Every cel whose inputMap references `key` (the backlink scan). */
const backlinksOf = (state: State, key: string): string[] => {
  const out: string[] = [];
  for (const [k, c] of state.cels) {
    if (k === key || isInternal(k)) continue;
    if (inputKeysOf(c as unknown as CelLike).includes(key)) out.push(k);
  }
  return out.sort();
};

const segmentOf = (cel: CelLike | undefined): string => String(cel?.metadata?.segment ?? "");
const summaryOf = (cel: CelLike | undefined): string => {
  const doc = cel?.metadata?.doc as Record<string, unknown> | undefined;
  return String(doc?.summary ?? cel?.metadata?.description ?? "");
};
/** Notes live in a docgraph-owned SIDECAR map (wiki.notes: key → text) — the
 *  note points AT the subject instead of editing it (the annotation-plane
 *  shape), so locked natives are annotatable and no lock/Layer-1 policy is
 *  ever in the write path. metadata.note remains a read fallback. */
const noteOf = (state: State, key: string): string => {
  const map = state.cels.get("wiki.notes")?.v as Record<string, string> | undefined;
  return String(map?.[key] ?? celOf(state, key)?.metadata?.note ?? "");
};

/** Member cels of a segment (or a win.<id> layer — genesis stamps segment to
 *  the layer name, but tolerate key-prefix membership too). */
const membersOf = (state: State, seg: string): string[] => {
  const out: string[] = [];
  for (const [k, c] of state.cels) {
    if (isInternal(k)) continue;
    if (segmentOf(c as unknown as CelLike) === seg || k.startsWith(seg + ".")) out.push(k);
  }
  return out.sort();
};

// ── the graph SPEC (forcegraph renders + simulates it) ───────────────────────

/** Build the neighborhood spec for forcegraph: depth-2 BFS over dep edges
 *  (both directions, capped), member-seeded for segment/layer subjects so
 *  the graph is never empty, node size ∝ sqrt(degree), subject pinned,
 *  clicks re-dispatch wiki.open. */
const graphSpec = (state: State, center: string): { nodes: Array<{ key: string; size: number }>; edges: Array<[string, string]>; pin: string; onNode: { dispatch: string } } => {
  const seen = new Set<string>([center]);
  const memberSeeds = celOf(state, center) ? [] : membersOf(state, center).filter((k) => k !== center).slice(0, 14);
  for (const m of memberSeeds) seen.add(m);
  let frontier = memberSeeds.length ? [...memberSeeds] : [center];
  for (let depth = 0; depth < 2 && seen.size < 36; depth++) {
    const next: string[] = [];
    for (const k of frontier) {
      const fwd = inputKeysOf(celOf(state, k)).filter((d) => state.cels.has(d));
      for (const d of [...fwd, ...backlinksOf(state, k)]) {
        if (seen.size >= 36) break;
        if (!seen.has(d) && !isInternal(d)) { seen.add(d); next.push(d); }
      }
    }
    frontier = next;
  }
  const keys = [...seen];
  const edges: Array<[string, string]> = [];
  for (const k of keys) {
    for (const d of inputKeysOf(celOf(state, k))) if (seen.has(d)) edges.push([k, d]);
  }
  for (const m of memberSeeds) edges.push([center, m]);
  const nodes = keys.map((k) => {
    const deg = inputKeysOf(celOf(state, k)).filter((d) => state.cels.has(d)).length + backlinksOf(state, k).length;
    return { key: k, size: Math.min(1.9, 0.85 + 0.16 * Math.sqrt(deg)) };
  });
  return { nodes, edges, pin: center, onNode: { dispatch: "wiki.open" } };
};

// ── article rendering ────────────────────────────────────────────────────────

const LINK = "border:0;background:transparent;padding:0;cursor:pointer;color:LinkText;text-decoration:underline;font:inherit";
const CHIP = "display:inline-block;font:.7rem ui-monospace,monospace;padding:.05rem .4rem;border:1px solid #8884;border-radius:.6rem;background:#8881;color:GrayText;margin-right:.3rem";
const H2 = "font:600 .78rem system-ui;color:GrayText;text-transform:uppercase;letter-spacing:.06em;margin:.8rem 0 .25rem";
const BTN = "font:.78rem ui-monospace,monospace;padding:.15rem .55rem;border:1px solid #8884;border-radius:.3rem;background:#8881;cursor:pointer";

const wlink = (key: string, label?: string): V =>
  el("button", { class: "wk-link", style: LINK, title: key }, [T(label ?? key)],
    { pointerdown: { dispatch: "winx.stop" }, click: { dispatch: "wiki.open", payload: key } });

const linkRow = (keys: string[]): V =>
  el("div", { style: "display:flex;flex-wrap:wrap;gap:.25rem .7rem;font:.85rem ui-monospace,monospace" },
    keys.length ? keys.map((k) => wlink(k)) : [el("span", { style: "color:GrayText;font-style:italic" }, [T("none")])]);

const section = (title: string, body: V): V[] => [el("div", { style: H2 }, [T(title)]), body];

/** The wiki is editable: the summary (metadata.description) gets the same
 *  buffer + save treatment as the note. Edits are runtime-local until the
 *  document dehydrates — the shipped seed is still the repo's. */
const descEditor = (desc: string): V =>
  el("div", { style: "margin:.25rem 0 .1rem" }, [
    el("textarea", {
      class: "wk-desc", rows: 2, placeholder: "describe this entry (saved to metadata.description — every render reads it: inspect, vocab, wiki, skill)",
      style: "width:100%;box-sizing:border-box;font:.8rem system-ui;padding:.3rem .45rem;border:1px dashed #8884;border-radius:.4rem;background:#8880;color:CanvasText;resize:vertical",
      value: desc,
    }, [T(desc)], { input: { set: "wiki.descDraft", extract: "value" }, pointerdown: { dispatch: "winx.stop" } }),
    el("div", { style: "margin-top:.2rem" }, [
      el("button", { style: BTN }, [T("✎ save description")], { pointerdown: { dispatch: "winx.stop" }, click: { dispatch: "wiki.saveDesc" } }),
    ]),
  ]);

const noteEditor = (note: string): V =>
  el("div", {}, [
    el("textarea", {
      class: "wk-note", rows: 3, placeholder: "your note on this entry — [[links]] welcome (saved to metadata.note)",
      style: "width:100%;box-sizing:border-box;font:.82rem ui-monospace,monospace;padding:.35rem .45rem;border:1px solid #8884;border-radius:.4rem;background:#8881;color:CanvasText;resize:vertical",
      value: note,
    }, [T(note)], { input: { set: "wiki.noteDraft", extract: "value" }, pointerdown: { dispatch: "winx.stop" } }),
    el("div", { style: "margin-top:.25rem" }, [
      el("button", { style: BTN }, [T("save note")], { pointerdown: { dispatch: "winx.stop" }, click: { dispatch: "wiki.saveNote" } }),
    ]),
  ]);

/** `[[link]]` references inside a note become wiki links; plain text passes. */
const noteBody = (note: string): V => {
  const parts: V[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(note))) {
    if (m.index > last) parts.push(T(note.slice(last, m.index)));
    parts.push(wlink(m[1]!.trim()));
    last = m.index + m[0].length;
  }
  if (last < note.length) parts.push(T(note.slice(last)));
  return el("div", { style: "font:.85rem system-ui;white-space:pre-wrap" }, parts);
};

const articleVnode = (state: State, key: string): V => {
  const segments = (state as unknown as { segments?: Map<string, { name: string; description?: string; dependencies?: string[]; role?: string; version?: string } > }).segments;
  const manifest = segments?.get(key);
  const cel = celOf(state, key);
  const head: V[] = [];
  const body: V[] = [];

  if (!cel && !manifest && membersOf(state, key).length === 0) {
    return el("div", { class: "wk-article", style: "font:.9rem system-ui" }, [
      el("h2", { style: "margin:.1rem 0 .4rem;font:700 1.15rem system-ui" }, [T(key)]),
      el("p", { style: "color:#d4453e" }, [T(`no cel, segment, or layer named "${key}" — a red link. Create it, or check the spelling.`)]),
    ]);
  }

  head.push(el("h2", { style: "margin:.1rem 0 .15rem;font:700 1.15rem ui-monospace,monospace;word-break:break-all" }, [T(key)]));

  // ── segment / layer article ────────────────────────────────────────────
  if (manifest || (!cel && membersOf(state, key).length > 0)) {
    const members = membersOf(state, key).filter((k) => k !== key);
    head.push(el("div", {}, [
      el("span", { style: CHIP }, [T(manifest ? `segment · ${manifest.role ?? "library"} v${manifest.version ?? "?"}` : "layer")]),
      el("span", { style: CHIP }, [T(`${members.length} cels`)]),
    ]));
    if (manifest?.description) body.push(el("p", { style: "font:.88rem system-ui;margin:.5rem 0" }, [T(manifest.description)]));
    if (manifest?.dependencies?.length) body.push(...section("depends on", linkRow(manifest.dependencies)));
    const fns = members.filter((k) => FN_TYPES.has(celOf(state, k)?.celType ?? ""));
    const data = members.filter((k) => !FN_TYPES.has(celOf(state, k)?.celType ?? ""));
    if (fns.length) body.push(...section("functions", linkRow(fns)));
    if (data.length) body.push(...section("cels", linkRow(data.slice(0, 60))));
  }

  // ── cel article ────────────────────────────────────────────────────────
  if (cel) {
    head.push(el("div", {}, [
      el("span", { style: CHIP }, [T(cel.celType)]),
      ...(segmentOf(cel) ? [el("span", { style: CHIP }, [wlink(segmentOf(cel), `in ${segmentOf(cel)}`)])] : []),
    ]));
    const summary = summaryOf(cel);
    if (summary) body.push(el("p", { style: "font:.88rem system-ui;margin:.5rem 0" }, [T(summary)]));
    if (cel.locked) {
      body.push(el("div", { style: "font:.72rem system-ui;color:GrayText;margin:.1rem 0" },
        [T("🔒 locked — the description ships with the segment; annotate below instead")]));
    } else {
      body.push(descEditor(summary));
    }
    if (typeof cel.f === "string" && cel.f) {
      body.push(...section("formula", el("pre", { style: "font:.8rem ui-monospace,monospace;background:#8881;border:1px solid #8883;border-radius:.4rem;padding:.4rem .5rem;white-space:pre-wrap;word-break:break-word;margin:0" }, [T(cel.f)])));
    } else if (FN_TYPES.has(cel.celType)) {
      // a NATIVE fn carries no `f` — but the bound _fn is a live JS function,
      // and toString() yields its real (tsc-emitted) source. Show it, plus a
      // link to the segment's source file on GitHub (no iframe: GitHub sends
      // X-Frame-Options deny — a tab is the honest affordance).
      const live = (cel as unknown as { _fn?: unknown })._fn;
      if (typeof live === "function") {
        const src = String(live);
        body.push(...section("source (live binding)", el("pre", {
          style: "font:.74rem ui-monospace,monospace;background:#8881;border:1px solid #8883;border-radius:.4rem;padding:.4rem .5rem;white-space:pre-wrap;word-break:break-word;margin:0;max-height:14rem;overflow:auto",
        }, [T(src.length > 4000 ? src.slice(0, 4000) + "\n…" : src)])));
      }
      const seg = segmentOf(cel);
      const role = (state as unknown as { segments?: Map<string, { role?: string }> }).segments?.get(seg)?.role ?? "library";
      const path = role === "kernel" ? "kernel/index.ts" : `${role === "application" ? "application" : "library"}/${seg}/index.ts`;
      body.push(el("div", { style: "margin:.3rem 0 0;font:.78rem system-ui" }, [
        el("a", {
          href: `https://github.com/rheophile10/plastron/blob/master/plastron/src/甲骨坑/${path}`,
          target: "_blank", style: "color:LinkText",
        }, [T(`view ${seg}/index.ts on github ↗`)]),
      ]));
    } else if (!FN_TYPES.has(cel.celType) && cel.v !== undefined && cel.v !== null && !isVnode(cel.v)) {
      const s = typeof cel.v === "object" ? JSON.stringify(cel.v) : String(cel.v);
      body.push(...section("value", el("pre", { style: "font:.8rem ui-monospace,monospace;background:#8881;border-radius:.4rem;padding:.3rem .5rem;margin:0;white-space:pre-wrap;word-break:break-word" }, [T(s.length > 400 ? s.slice(0, 400) + "…" : s)])));
    }
    // the AST's resolved edges: inputMap, split functions vs inputs.
    const deps = inputKeysOf(cel).filter((d) => state.cels.has(d));
    const fnDeps = deps.filter((d) => FN_TYPES.has(celOf(state, d)?.celType ?? ""));
    const inDeps = deps.filter((d) => !FN_TYPES.has(celOf(state, d)?.celType ?? ""));
    if (fnDeps.length) body.push(...section("functions it calls", linkRow(fnDeps)));
    if (inDeps.length) body.push(...section("input cels", linkRow(inDeps)));
  }

  const back = backlinksOf(state, key);
  body.push(...section(`used by (${back.length})`, linkRow(back.slice(0, 40))));
  body.push(...section("graph (drag nodes · scroll to zoom)",
    el("div", { class: "wk-graph-slot" }, [T("(live graph)")])));
  const note = noteOf(state, key);
  body.push(...section("note", el("div", {}, [...(note ? [noteBody(note)] : []), noteEditor(note)])));

  return el("div", { class: "wk-article", style: "font:.9rem system-ui;padding:.15rem .3rem" }, [...head, ...body]);
};

// ── native verbs ─────────────────────────────────────────────────────────────

/** wikidoc(article, graph) — win.wiki.content composition: the article
 *  snapshot with the LIVE forcegraph vnode spliced into its graph slot.
 *  The content formula passes fg.wiki.* cels to fgview, so drags and zooms
 *  re-render reactively while the prose stays a snapshot. */
const wikidocFn: Fn = (article?: unknown, graph?: unknown): V => {
  if (!isVnode(article)) {
    return el("div", { style: "color:GrayText;font:.85rem system-ui;padding:.4rem" }, [
      T("no entry open — click the W on any window's titlebar, or use "),
      el("code", {}, [T('=wiki("name")')]),
    ]);
  }
  if (!isVnode(graph)) return article;
  const kids = (article.children ?? []).map((c) =>
    (c as V).attrs?.class === "wk-graph-slot" ? (graph as V) : c);
  return { ...article, children: kids };
};

/** wiki(name) — a 📖 affordance; the open happens in the handler. */
const wikiFn: Fn = (name?: unknown): V => {
  const k = String(name ?? "").trim();
  return el("button", { style: BTN, title: k ? `open the wiki on ${k}` : "open the wiki" }, [T(`📖 ${k || "wiki"}`)],
    { click: { dispatch: "wiki.open", payload: k } });
};

// ── handlers (dispatch targets: (state, payload, event)) ────────────────────

const repaint = (state: State): Promise<unknown> =>
  Promise.resolve((resolveFn(state, "drain") as Fn)(state, "dom.paint"));

const refreshArticle = async (state: State, key: string): Promise<void> => {
  const article = articleVnode(state, key);
  const cel = celOf(state, key);
  await ((resolveFn(state, "setValueBatch") as Fn)(state, [
    ["wiki.current", key], ["wiki.article", article],
    ["wiki.noteDraft", noteOf(state, key)], ["wiki.descDraft", summaryOf(cel)],
  ]));
};

/** Create the win.wiki window cels on first open. The FRAME (which references
 *  origin's `mount`) is created only when mount resolves — a non-origin host
 *  gets the article state without a window, and NOTHING traps at runCycle. */
const ensureWikiWindow = async (state: State): Promise<void> => {
  const setCel = resolveFn(state, "setCel") as Fn;
  // segment "win.wiki" (the LAYER, exactly as winapp stamps its windows):
  // the frame references origin's mount while origin's view reads the frame —
  // under segment "docgraph" that is a forbidden two-way code-segment edge
  // (the one-direction rule refused it); window cels belong to their layer.
  // NO generatedBy: a generator stamp with no live genesis request is sweep
  // bait — settleStructural reclaimed the window after first paint. cellKeys
  // admits win.* layer cels by pattern instead (state-cel windows are
  // first-class desktop citizens, per the taskbar).
  if (!state.cels.has("win.wiki.state")) {
    await setCel(state, "win.wiki.state", {
      celType: "ValueCel",
      v: { ref: "win.wiki.state", x: 130, y: 64, w: 580, h: 500, z: 6, min: 0, max: 0, closed: 1, title: "📖 wiki" },
      metadata: { segment: "win.wiki", name: "state" },
    });
  }
  const CONTENT_F = '(wikidoc wiki.article (fgview "wiki" fg.wiki.spec fg.wiki.pos fg.wiki.zoom fg.wiki.armed))';
  const content = state.cels.get("win.wiki.content") as { f?: string } | undefined;
  if (!content || content.f !== CONTENT_F) {
    await setCel(state, "win.wiki.content", {
      celType: "FormulaCel", f: CONTENT_F,
      metadata: { segment: "win.wiki", name: "content", parser: "f" },
    });
  }
  if (!state.cels.has("win.wiki.frame") && state.cels.has("mount") && state.cels.has("winframe")) {
    await setCel(state, "win.wiki.frame", {
      celType: "FormulaCel", f: '(mount ".origin" (winframe win.wiki.state win.active win.wiki.content))',
      metadata: { segment: "win.wiki", name: "frame", parser: "f" },
    });
  }
};

const wikiOpen: Fn = (async (state: State, payload?: unknown): Promise<void> => {
  let key = String(payload ?? "").trim();
  if (!key) key = String(state.cels.get("wiki.current")?.v ?? "") || "origin";
  // the W button passes the window's state ref — article the LAYER it heads.
  if (key.startsWith("win.") && key.endsWith(".state")) key = key.slice(0, -".state".length);
  // the graph instance: spec + layout-to-frozen via forcegraph (fg.set);
  // a NEW subject resets the instance zoom
  const newSubject = key !== String(state.cels.get("wiki.current")?.v ?? "");
  await ((resolveFn(state, "fg.set") as Fn)(state, { id: "wiki", spec: graphSpec(state, key) }));
  if (newSubject && state.cels.has("fg.wiki.zoom")) {
    await ((resolveFn(state, "setValue") as Fn)(state, "fg.wiki.zoom", 1));
  }
  await ensureWikiWindow(state);
  await refreshArticle(state, key);
  // open + raise the wiki window above every other win.*.state z.
  const sref = "win.wiki.state";
  const cur = (state.cels.get(sref)?.v ?? {}) as Record<string, unknown>;
  let top = 10;
  for (const [k, c] of state.cels) {
    if (k.startsWith("win.") && k.endsWith(".state")) {
      const z = Number((c.v as Record<string, unknown> | undefined)?.z ?? 0);
      if (Number.isFinite(z) && z > top) top = z;
    }
  }
  await ((resolveFn(state, "setValue") as Fn)(state, sref, { ...cur, closed: 0, min: 0, z: top + 1 }));
  // Lazily-created cels are OUT-OF-BAND structure. The host view must rewire
  // to include them (view.refresh rebuilds 元.view's vals) — but the rewire's
  // inputMap edit recompiles the view at its NEXT fire, so the first cycle
  // after a rewire still renders the old wiring. refresh → cycle → refresh
  // makes the recompiled view fire against the new vals and paints it
  // (empirically pinned by the e2e probe; a bare drain no-ops — the
  // wallet-window lesson, applied).
  const viewRefresh = resolveFn(state, "view.refresh") as Fn | undefined;
  const runCycle = resolveFn(state, "runCycle") as Fn;
  if (viewRefresh) await viewRefresh(state);
  await runCycle(state); // fire 1: view recompiles against the rewired vals
  await runCycle(state); // fire 2: the recompiled view computes WITH them
  await repaint(state);
}) as Fn;

const wikiSaveNote: Fn = (async (state: State): Promise<void> => {
  const key = String(state.cels.get("wiki.current")?.v ?? "");
  if (!key) return;
  const draft = String(state.cels.get("wiki.noteDraft")?.v ?? "");
  const cur = (state.cels.get("wiki.notes")?.v ?? {}) as Record<string, string>;
  const next = { ...cur };
  if (draft.trim()) next[key] = draft; else delete next[key];
  await ((resolveFn(state, "setValue") as Fn)(state, "wiki.notes", next));
  await refreshArticle(state, key);
  await repaint(state);
}) as Fn;

const wikiSaveDesc: Fn = (async (state: State): Promise<void> => {
  const key = String(state.cels.get("wiki.current")?.v ?? "");
  if (!key || !state.cels.has(key)) return;
  const draft = String(state.cels.get("wiki.descDraft")?.v ?? "");
  try {
    await ((resolveFn(state, "setCel") as Fn)(state, key, { metadata: { description: draft } }));
  } catch (e) {
    await ((resolveFn(state, "setValue") as Fn)(state, "wiki.descDraft",
      `(edit refused: ${String((e as Error)?.message ?? e)})`));
  }
  await refreshArticle(state, key);
  await repaint(state);
}) as Fn;

export const name = "docgraph" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["wikidoc", wikidocFn],
  ["wiki", wikiFn],
  ["wiki.open", wikiOpen],
  ["wiki.saveNote", wikiSaveNote],
  ["wiki.saveDesc", wikiSaveDesc],
]));
