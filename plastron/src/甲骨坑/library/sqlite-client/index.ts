import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import { el as makeEl, text as T } from "../dom/index.js";
import seed from "./甲骨.json" with { type: "json" };

// sqlite-client — a SQLite client WINDOW authored the plastron way: a native-fn
// panel (sqlclientui) referenced by a one-line content formula inside a winframe,
// wired to dispatch handlers. Query editor on top, a tables sidebar on the left,
// and the result rows below — rendered as a grid AND materialized into real,
// addressable `sqlres.*` cels (so a formula can read =sqlres.B2, chart them,
// etc.). Mirrors the windows `chatapp`/`chat` pattern.

type V = unknown;
const el = makeEl as unknown as (tag: string, attrs?: Record<string, unknown>, children?: V[], events?: Record<string, unknown>) => V;

const repaint = (state: State): Promise<unknown> =>
  Promise.resolve((resolveFn(state, "drain") as Fn)(state, "dom.paint"));
const setV = (state: State, k: string, v: unknown): Promise<unknown> =>
  Promise.resolve((resolveFn(state, "setValue") as Fn)(state, k, v));

const colLetter = (n: number): string => {
  let s = ""; let x = n + 1;
  while (x > 0) { x--; s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26); }
  return s;
};

// ── the panel (pure render fn) ───────────────────────────────────────────────
// (sqlclientui db query tablesData results error) → vnode
interface ResultV { cols?: string[]; rows?: Record<string, unknown>[] }
interface SchemaV { tables?: { name: string }[] }

const PANEL = "display:flex;flex-direction:column;height:100%;gap:.4rem;font:12px/1.45 ui-monospace,monospace";
const BTN_RUN = "padding:.4rem .9rem;border:1px solid #8884;border-radius:.4rem;cursor:pointer;background:#4a90d9;color:white;font:inherit;font-weight:600";
const TA = "flex:1;min-height:3.2rem;resize:vertical;padding:.4rem;border:1px solid #8884;border-radius:.4rem;background:Canvas;color:CanvasText;font:inherit";
const SIDE = "flex:0 0 9.5rem;overflow:auto;border-right:1px solid #8883;padding-right:.3rem;display:flex;flex-direction:column;gap:.1rem";
const TBTN = "text-align:left;padding:.25rem .45rem;border:none;background:transparent;color:CanvasText;cursor:pointer;border-radius:.3rem;font:inherit";
const CELL = "border:1px solid #8883;padding:.18rem .4rem;white-space:nowrap;max-width:18rem;overflow:hidden;text-overflow:ellipsis";
const HEAD = "border:1px solid #8883;padding:.18rem .4rem;background:#8881;font-weight:600;position:sticky;top:0";
const RHEAD = "border:1px solid #8883;padding:.18rem .35rem;background:#8881;opacity:.7;text-align:right";

const resultsGrid = (results: ResultV): V => {
  const cols = results.cols ?? [];
  const rows = results.rows ?? [];
  if (!cols.length) return el("div", { style: "opacity:.55;padding:.6rem" }, [T("Run a query above to see rows here.")]);
  // header: corner + A,B,C column letters atop the column names
  const head = el("tr", {}, [
    el("th", { style: RHEAD }, [T("")]),
    ...cols.map((c, i) => el("th", { style: HEAD }, [T(`${colLetter(i)}  ${c}`)])),
  ]);
  const body = rows.map((r, ri) => el("tr", {}, [
    el("td", { style: RHEAD }, [T(String(ri + 1))]),
    ...cols.map((c) => {
      const v = r[c];
      return el("td", { style: CELL }, [T(v === null || v === undefined ? "∅" : String(v))]);
    }),
  ]));
  return el("div", { style: "overflow:auto;height:100%" }, [
    el("table", { style: "border-collapse:collapse;font:inherit" }, [
      el("thead", {}, [head]), el("tbody", {}, body),
    ]),
  ]);
};

const sqlclientui: Fn = ((db: unknown, query: unknown, tablesData: unknown, results: unknown, error: unknown): V => {
  const d = String(db ?? "main");
  const q = query == null ? "" : String(query);
  const names = ((tablesData as SchemaV)?.tables ?? []).map((t) => t.name);
  const res = (results as ResultV) ?? {};
  const err = error == null ? "" : String(error);

  const sidebar = el("div", { style: SIDE }, [
    el("div", { style: "font-size:.66rem;opacity:.55;padding:.2rem .1rem;letter-spacing:.08em" }, [T(`▦ ${d}`)]),
    ...(names.length
      ? names.map((t) => el("button", { style: TBTN }, [T(`▦ ${t}`)],
          { pointerdown: { dispatch: "winx.stop" }, click: { dispatch: "sqlc.selectTable", payload: `${d}::${t}` } }))
      : [el("div", { style: "opacity:.45;padding:.2rem;font-size:.7rem" }, [T("(no tables)")])]),
  ]);

  const resultPane = el("div", { style: "flex:1 1 auto;overflow:auto;min-width:0" }, [
    err ? el("div", { style: "color:#d4453e;padding:.5rem;white-space:pre-wrap" }, [T("⚠ " + err)]) : resultsGrid(res),
  ]);

  return el("div", { style: PANEL }, [
    el("div", { style: "flex:0 0 auto;display:flex;gap:.35rem;align-items:stretch" }, [
      el("textarea", { value: q, placeholder: "SELECT * FROM …   (⌘/Ctrl+Enter to run)", style: TA }, [],
        { input: { set: `sqlc.${d}.query`, extract: "value" }, keydown: { dispatch: "sqlc.key", payload: d } }),
      el("button", { style: BTN_RUN }, [T("▶ Run")],
        { pointerdown: { dispatch: "winx.stop" }, click: { dispatch: "sqlc.run", payload: d } }),
    ]),
    el("div", { style: "flex:1 1 auto;display:flex;gap:.4rem;min-height:0" }, [sidebar, resultPane]),
  ]);
}) as Fn;

// ── handlers ─────────────────────────────────────────────────────────────────

const cmd = (state: State, op: string, db: string, query?: string): Promise<unknown> =>
  Promise.resolve((resolveFn(state, "sqlite.command") as Fn)(state, op, db, query ?? ""));

// materialize the rows into a real `sqlres` cel grid (header row + data),
// capped at 100, so the records are addressable cels (=sqlres.B2, charts, …).
const materialize = async (state: State, cols: string[], rows: Record<string, unknown>[]): Promise<void> => {
  const batch: Record<string, unknown> = {};
  const put = (addr: string, v: unknown): void => {
    batch[`sqlres.${addr}`] = { celType: "ValueCel", v, metadata: { key: `sqlres.${addr}`, segment: "sqlres", name: addr } };
  };
  cols.forEach((c, i) => put(`${colLetter(i)}1`, c));
  rows.forEach((r, ri) => cols.forEach((c, ci) => put(`${colLetter(ci)}${ri + 2}`, r[c] ?? null)));
  try { await Promise.resolve((resolveFn(state, "setCelBatch") as Fn)(state, batch)); } catch { /* best-effort */ }
};

// refresh the sidebar's table list from the live schema (imperative + reliable —
// schema-as-a-formula re-fires unpredictably across the effect drain).
const refreshTables = async (state: State, d: string): Promise<void> => {
  try { await setV(state, `sqlc.${d}.tables`, await cmd(state, "schema", d)); } catch { /* keep prior */ }
};

const sqlcRun: Fn = (async (state: State, db: unknown): Promise<void> => {
  const d = String(db ?? "main");
  await refreshTables(state, d);                       // populate / refresh the sidebar
  const q = String(state.cels.get(`sqlc.${d}.query`)?.v ?? "").trim();
  if (q) {
    try {
      const res = await cmd(state, "sql", d, q);
      if (Array.isArray(res)) {
        const cols = res.length ? Object.keys(res[0] as object) : [];
        const rows = (res as Record<string, unknown>[]).slice(0, 100);
        await setV(state, `sqlc.${d}.results`, { cols, rows });
        await materialize(state, cols, rows);
      } else {
        await setV(state, `sqlc.${d}.results`, { cols: [], rows: [], note: String(res) });
        await refreshTables(state, d);                 // a write may have changed the tables
      }
      await setV(state, `sqlc.${d}.error`, "");
    } catch (e) {
      await setV(state, `sqlc.${d}.error`, String((e as { message?: unknown })?.message ?? e));
    }
  }
  await repaint(state);
}) as Fn;

// =sqlc.refresh(db) — repopulate the sidebar on demand (and on window open).
const sqlcRefresh: Fn = (async (state: State, db: unknown): Promise<void> => {
  await refreshTables(state, String(db ?? "main")); await repaint(state);
}) as Fn;

const sqlcSelectTable: Fn = (async (state: State, payload: unknown): Promise<void> => {
  const [d, table] = String(payload ?? "").split("::");
  if (!d || !table) return;
  await setV(state, `sqlc.${d}.query`, `SELECT * FROM "${table}" LIMIT 100`);
  await (sqlcRun as unknown as (s: State, db: unknown) => Promise<void>)(state, d);
}) as Fn;

const sqlcKey: Fn = (async (state: State, db: unknown, event?: { key?: string; metaKey?: boolean; ctrlKey?: boolean; preventDefault?: () => void }): Promise<void> => {
  if (event?.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    try { event.preventDefault?.(); } catch { /* */ }
    await (sqlcRun as unknown as (s: State, db: unknown) => Promise<void>)(state, db);
  }
}) as Fn;

// ── the window verb ──────────────────────────────────────────────────────────
// =sqlclient("demo" [, "Title"]) — GENESIS: opens the db, seeds the client's
// state cels + a winframe whose content is the panel. Mirrors chatappFn.
const sqlclientFn: Fn = ((db: unknown, title: unknown): unknown => {
  const d = String(db ?? "main");
  const lay = `win.sqlc-${d}`, sref = `${lay}.state`;
  let hsh = 0; for (const c of d) hsh = (hsh * 31 + c.charCodeAt(0)) >>> 0;
  const dx = 80 + (hsh % 6) * 48, dy = 60 + (hsh % 4) * 40;
  const t = String(title ?? `SQLite — ${d}`).replace(/"/g, "'");
  return { genesis: true, layer: lay, cels: {
    [`sqlc.${d}.db`]:      { celType: "FormulaCel", f: `=db("${d}")`, metadata: { name: "db", parser: "infix" } },
    [`sqlc.${d}.query`]:   { celType: "ValueCel", v: "", metadata: { name: "query" } },
    [`sqlc.${d}.results`]: { celType: "ValueCel", v: { cols: [], rows: [] }, metadata: { name: "results" } },
    [`sqlc.${d}.error`]:   { celType: "ValueCel", v: "", metadata: { name: "error" } },
    [`sqlc.${d}.tables`]:  { celType: "ValueCel", v: { tables: [] }, metadata: { name: "tables" } },
    [sref]: { celType: "ValueCel", v: { ref: sref, x: dx, y: dy, w: 560, h: 420, z: 1, min: 0, max: 0, closed: 0, title: t }, metadata: { name: "state" } },
    [`${lay}.content`]: { celType: "FormulaCel", f: `(sqlclientui "${d}" sqlc.${d}.query sqlc.${d}.tables sqlc.${d}.results sqlc.${d}.error)`, metadata: { name: "content", parser: "f" } },
    [`${lay}.frame`]: { celType: "FormulaCel", f: `(mount ".origin" (winframe ${sref} win.active ${lay}.content))`, metadata: { name: "frame", parser: "f" } },
  } };
}) as Fn;

export const name = "sqlite-client" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["sqlclient", sqlclientFn],
  ["sqlclientui", sqlclientui],
  ["sqlc.run", sqlcRun],
  ["sqlc.refresh", sqlcRefresh],
  ["sqlc.selectTable", sqlcSelectTable],
  ["sqlc.key", sqlcKey],
]));
