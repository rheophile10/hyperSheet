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
const isInternal = (key: string): boolean => key === "wiki.article" || key === "wiki.noteDraft";

interface CelLike { celType: string; f?: string; v?: unknown; metadata: Record<string, unknown> }
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
const noteOf = (cel: CelLike | undefined): string => String(cel?.metadata?.note ?? "");

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

// ── deterministic force layout (no Math.random — seeds from index) ──────────

interface LNode { key: string; x: number; y: number }
const forceLayout = (keys: string[], edges: Array<[number, number]>, w: number, h: number): LNode[] => {
  const n = keys.length;
  const cx = w / 2, cy = h / 2;
  const nodes: LNode[] = keys.map((key, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, n);
    const r = 0.30 * Math.min(w, h) * (1 + (i % 3) * 0.22);
    return { key, x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
  const K = Math.sqrt((w * h) / Math.max(1, n)) * 0.7;
  for (let it = 0; it < 120; it++) {
    const fx = new Array(n).fill(0), fy = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = nodes[i]!.x - nodes[j]!.x, dy = nodes[i]!.y - nodes[j]!.y;
      const d2 = Math.max(64, dx * dx + dy * dy), f = (K * K) / d2;
      fx[i] += dx * f; fy[i] += dy * f; fx[j] -= dx * f; fy[j] -= dy * f;
    }
    for (const [a, b] of edges) {
      const dx = nodes[a]!.x - nodes[b]!.x, dy = nodes[a]!.y - nodes[b]!.y;
      const d = Math.max(8, Math.sqrt(dx * dx + dy * dy)), f = (d - K) / d * 0.12;
      fx[a] -= dx * f; fy[a] -= dy * f; fx[b] += dx * f; fy[b] += dy * f;
    }
    const cool = 1 - it / 120;
    for (let i = 0; i < n; i++) {
      nodes[i]!.x += Math.max(-12, Math.min(12, fx[i])) * cool + (cx - nodes[i]!.x) * 0.01;
      nodes[i]!.y += Math.max(-12, Math.min(12, fy[i])) * cool + (cy - nodes[i]!.y) * 0.01;
      nodes[i]!.x = Math.max(14, Math.min(w - 14, nodes[i]!.x));
      nodes[i]!.y = Math.max(12, Math.min(h - 12, nodes[i]!.y));
    }
  }
  return nodes;
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

/** The neighborhood graph: canvas edges under clickable node chips. */
const graphView = (state: State, center: string, w = 520, h = 230): V => {
  // depth-2 BFS over dep edges (both directions), capped.
  const seen = new Set<string>([center]);
  let frontier = [center];
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
  const idx = new Map(keys.map((k, i) => [k, i]));
  const edges: Array<[number, number]> = [];
  for (const k of keys) {
    for (const d of inputKeysOf(celOf(state, k))) {
      const j = idx.get(d);
      if (j !== undefined) edges.push([idx.get(k)!, j]);
    }
  }
  const pos = forceLayout(keys, edges, w, h);
  const ops = edges.map(([a, b]) => ({
    op: "line", points: [[pos[a]!.x, pos[a]!.y], [pos[b]!.x, pos[b]!.y]], stroke: "#8886", lineWidth: 1,
  }));
  const chips = pos.map((p) => {
    const isCenter = p.key === center;
    const label = p.key.length > 18 ? p.key.slice(0, 17) + "…" : p.key;
    return el("button", {
      class: "wk-node", title: p.key,
      style: `position:absolute;left:${Math.round(p.x)}px;top:${Math.round(p.y)}px;transform:translate(-50%,-50%);font:.66rem ui-monospace,monospace;padding:.06rem .35rem;border-radius:.7rem;cursor:pointer;white-space:nowrap;border:1px solid ${isCenter ? "#4a90d9" : "#8885"};background:${isCenter ? "#4a90d922" : "Canvas"};color:CanvasText`,
    }, [T(label)], { pointerdown: { dispatch: "winx.stop" }, click: { dispatch: "wiki.open", payload: p.key } });
  });
  return el("div", { class: "wk-graph", style: `position:relative;width:${w}px;height:${h}px;max-width:100%;border:1px solid #8883;border-radius:.5rem;overflow:hidden;background:#8880` }, [
    { type: "el", tag: "canvas", attrs: { width: w, height: h, "data-ops": JSON.stringify(ops) }, children: [] } as V,
    ...chips,
  ]);
};

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
    if (typeof cel.f === "string" && cel.f) {
      body.push(...section("formula", el("pre", { style: "font:.8rem ui-monospace,monospace;background:#8881;border:1px solid #8883;border-radius:.4rem;padding:.4rem .5rem;white-space:pre-wrap;word-break:break-word;margin:0" }, [T(cel.f)])));
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
  body.push(...section("graph", graphView(state, key)));
  const note = noteOf(cel);
  body.push(...section("note", el("div", {}, [...(note ? [noteBody(note)] : []), noteEditor(note)])));

  return el("div", { class: "wk-article", style: "font:.9rem system-ui;padding:.15rem .3rem" }, [...head, ...body]);
};

// ── native verbs ─────────────────────────────────────────────────────────────

/** wikidoc(article) — win.wiki.content passthrough. */
const wikidocFn: Fn = (article?: unknown): V =>
  isVnode(article) ? article : el("div", { style: "color:GrayText;font:.85rem system-ui;padding:.4rem" }, [
    T("no entry open — click the W on any window's titlebar, or use "),
    el("code", {}, [T('=wiki("name")')]),
  ]);

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
  const note = noteOf(celOf(state, key));
  await ((resolveFn(state, "setValueBatch") as Fn)(state, [
    ["wiki.current", key], ["wiki.article", article], ["wiki.noteDraft", note],
  ]));
};

/** Create the win.wiki window cels on first open. The FRAME (which references
 *  origin's `mount`) is created only when mount resolves — a non-origin host
 *  gets the article state without a window, and NOTHING traps at runCycle. */
const ensureWikiWindow = async (state: State): Promise<void> => {
  const setCel = resolveFn(state, "setCel") as Fn;
  // generatedBy: origin's cellKeys admits only genesis-stamped cels into
  // 元.view's vals — without the stamp, view.refresh rewires right past the
  // window and the frame's mount spec is never lifted into the view.
  if (!state.cels.has("win.wiki.state")) {
    await setCel(state, "win.wiki.state", {
      celType: "ValueCel",
      v: { ref: "win.wiki.state", x: 130, y: 64, w: 580, h: 500, z: 6, min: 0, max: 0, closed: 1, title: "📖 wiki" },
      metadata: { segment: "docgraph", name: "state", generatedBy: "wiki" },
    });
  }
  if (!state.cels.has("win.wiki.content")) {
    await setCel(state, "win.wiki.content", {
      celType: "FormulaCel", f: "(wikidoc wiki.article)",
      metadata: { segment: "docgraph", name: "content", parser: "f", generatedBy: "wiki" },
    });
  }
  if (!state.cels.has("win.wiki.frame") && state.cels.has("mount") && state.cels.has("winframe")) {
    await setCel(state, "win.wiki.frame", {
      celType: "FormulaCel", f: '(mount ".origin" (winframe win.wiki.state win.active win.wiki.content))',
      metadata: { segment: "docgraph", name: "frame", parser: "f", generatedBy: "wiki" },
    });
  }
};

const wikiOpen: Fn = (async (state: State, payload?: unknown): Promise<void> => {
  let key = String(payload ?? "").trim();
  if (!key) key = String(state.cels.get("wiki.current")?.v ?? "") || "origin";
  // the W button passes the window's state ref — article the LAYER it heads.
  if (key.startsWith("win.") && key.endsWith(".state")) key = key.slice(0, -".state".length);
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
  // to include them (view.refresh rebuilds 元.view's vals), and the view must
  // then FIRE against the new wiring — rewire updates inputMap after its own
  // cascade, so the cycle must come AFTER the refresh (origin's commit does
  // exactly rewire → runCycle → drain). A bare paint drain would no-op — the
  // wallet-window lesson, applied.
  const viewRefresh = resolveFn(state, "view.refresh") as Fn | undefined;
  if (viewRefresh) await viewRefresh(state);
  await ((resolveFn(state, "runCycle") as Fn)(state));
  await repaint(state);
}) as Fn;

const wikiSaveNote: Fn = (async (state: State): Promise<void> => {
  const key = String(state.cels.get("wiki.current")?.v ?? "");
  if (!key || !state.cels.has(key)) return; // segment/red-link articles hold no note cel (v1)
  const draft = String(state.cels.get("wiki.noteDraft")?.v ?? "");
  try {
    await ((resolveFn(state, "setCel") as Fn)(state, key, { metadata: { note: draft } }));
  } catch (e) {
    // Layer-1 set policy may refuse (sealed segments) — surface, don't die.
    await ((resolveFn(state, "setValue") as Fn)(state, "wiki.noteDraft",
      `(note refused: ${String((e as Error)?.message ?? e)})`));
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
]));
