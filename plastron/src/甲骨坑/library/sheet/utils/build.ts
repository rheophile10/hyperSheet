import type { Cel, DehydratedCel, Fn, State, 甲骨 } from "../../../../types/index.js";
import {
  inflateCel, compileCelBody, resolveSchemas, precompute, precomputeOptional, resolveFn,
} from "../../../../kernel/index.js";
import { addrFrom, cellKey } from "./address.js";
import { isDefinitionSource } from "./infix.js";

// ============================================================================
// Sheet grid factory + action fns. buildSheet generates the data layer — an
// N×M grid of cell cels plus the selection / editing / formula-bar control
// cels — as a segment the host hydrates. The reusable machinery (the `infix`
// parser and the action cels) ships in the boot `sheet` segment.
//
// A cell whose source begins with `=` is a FormulaCel (parser: infix); any
// other cell is a ValueCel holding a literal. This split matters: the kernel's
// `set` writes ValueCels (data entry), formulas recompute through the cascade,
// and a commit that changes a cell between the two re-installs the cel.
// ============================================================================

// `=…` is a formula; `seg.name := …` is a definition binder — both compile
// through the infix parser (the binder emits a defn.commit request).
const isFormulaSource = (s: string): boolean =>
  s.trimStart().startsWith("=") || isDefinitionSource(s);

const literal = (s: string): unknown => {
  if (s === "") return "";
  return Number.isNaN(Number(s)) ? s : Number(s);
};

/** Build the DehydratedCel for an address from its raw source. */
const cellCel = (addr: string, segment: string, source: string): DehydratedCel => {
  const key = cellKey(addr);
  if (isFormulaSource(source)) {
    return { key, celType: "FormulaCel", metadata: { key, segment, parser: "infix" }, f: source };
  }
  return { key, celType: "ValueCel", metadata: { key, segment }, v: literal(source) } as unknown as DehydratedCel;
};

export interface BuildSheetOpts {
  rows: number;
  cols: number;
  /** Initial cell contents by A1 address, e.g. { A1: "10", B1: "=A1*2" }. */
  cells?: Record<string, string>;
  /** Segment name to tag the generated cels with (default "sheet-grid"). */
  segment?: string;
}

/** Build the sheet data segment: an N×M grid + control cels. The cels are
 *  pure data (no _fn), so the host hydrates them directly. */
export const buildSheet = (opts: BuildSheetOpts): 甲骨 & { version: string; dependencies: string[] } => {
  const segment = opts.segment ?? "sheet-grid";
  const cells = opts.cells ?? {};
  const dc: DehydratedCel[] = [];
  for (let r = 0; r < opts.rows; r++) {
    for (let c = 0; c < opts.cols; c++) {
      const addr = addrFrom(c, r);
      dc.push(cellCel(addr, segment, cells[addr] ?? ""));
    }
  }
  // Control cels.
  const ctrl = (key: string, v: unknown): DehydratedCel =>
    ({ key, celType: "ValueCel", metadata: { key, segment }, v } as unknown as DehydratedCel);
  dc.push(ctrl("sheet.selection", { row: 0, col: 0 }));
  dc.push(ctrl("sheet.editing", { editing: false, draft: "" }));
  dc.push(ctrl("sheet.formula-bar", ""));
  dc.push(ctrl("sheet.dims", { rows: opts.rows, cols: opts.cols }));
  dc.push(ctrl("sheet.segment", segment));
  // "defn" is structural: every grid supports the binder gesture
  // (`=JS(A1, "name")` → defn.commit). Compiler edges (js, py, wat, …)
  // stay UNdeclared — they're user-introduced per formula, and the
  // precompute drift warning reports them truthfully.
  return { name: segment, version: "0.0.1", dependencies: ["sheet", "defn"], cels: dc };
};

/** GRID — the first genesis vocabulary (genesis-segment.md). Returns a
 *  structure request for an empty rows×cols grid of infix cells named
 *  `<name>.A1` …; the genesis drain commits it (stamped generatedBy,
 *  landed in layer segment <name>). Cells are seeds: the user's typed
 *  values/formulas survive regeneration. `=grid(3, 3)` at the origin
 *  blooms a grid; delete the formula and the sweep unmakes it. */
export const grid: Fn = (rows: unknown, cols: unknown, nameArg?: unknown) => {
  const r = Math.max(1, Math.min(256, Number(rows) || 1));
  const c = Math.max(1, Math.min(64, Number(cols) || 1));
  const name = typeof nameArg === "string" && nameArg !== "" ? nameArg : "grid";
  const cels: Record<string, unknown> = {};
  for (let row = 0; row < r; row++) {
    for (let col = 0; col < c; col++) {
      const addr = addrFrom(col, row);
      cels[`${name}.${addr}`] = {
        celType: "ValueCel", v: "",
        metadata: { name: addr, parser: "infix" },
      };
    }
  }
  cels[`${name}.dims`] = { celType: "ValueCel", v: { rows: r, cols: c }, metadata: {} };
  return { genesis: true, layer: name, cels };
};

// ── action fns (bound as the sheet.* action cels) ───────────────────────────

const readV = (state: State, key: string): unknown => state.cels.get(key)?.v;

/** Source string a cell currently holds (formula `f` or stringified value). */
const cellSource = (state: State, addr: string): string => {
  const cel = state.cels.get(cellKey(addr));
  if (!cel) return "";
  if (cel.celType === "FormulaCel") return (cel.f as string | undefined) ?? "";
  return cel.v === "" || cel.v === null || cel.v === undefined ? "" : String(cel.v);
};

const selectedAddr = (state: State): string => {
  const sel = readV(state, "sheet.selection") as { row: number; col: number } | undefined;
  return addrFrom(sel?.col ?? 0, sel?.row ?? 0);
};

/** start-edit — open the editor on the selected (or given) cell, seeding the
 *  draft with the cell's current source. */
export const startEdit: Fn = async (state: State, payload?: { addr?: string }) => {
  const addr = payload?.addr ?? selectedAddr(state);
  const set = resolveFn(state, "setValue")!;
  await set(state, "sheet.editing", { editing: true, draft: cellSource(state, addr) });
  return state;
};

/** cancel-edit — discard the draft. */
export const cancelEdit: Fn = async (state: State) => {
  const set = resolveFn(state, "setValue")!;
  await set(state, "sheet.editing", { editing: false, draft: "" });
  return state;
};

/** move-selection — set the selection to an absolute { row, col } or apply a
 *  { dr, dc } delta, clamped to the grid; mirror the cell's source into the
 *  formula bar. Uses batch so selection + formula-bar update together. */
export const moveSelection: Fn = async (
  state: State, payload: { row?: number; col?: number; dr?: number; dc?: number },
) => {
  const dims = (readV(state, "sheet.dims") as { rows: number; cols: number } | undefined) ?? { rows: 1, cols: 1 };
  const cur = (readV(state, "sheet.selection") as { row: number; col: number } | undefined) ?? { row: 0, col: 0 };
  const clamp = (n: number, max: number): number => Math.max(0, Math.min(max - 1, n));
  const row = clamp(payload.row ?? cur.row + (payload.dr ?? 0), dims.rows);
  const col = clamp(payload.col ?? cur.col + (payload.dc ?? 0), dims.cols);
  const batch = resolveFn(state, "setValueBatch")!;
  await batch(state, [
    ["sheet.selection", { row, col }],
    ["sheet.formula-bar", cellSource(state, addrFrom(col, row))],
  ]);
  return state;
};

/** commit-cell — write the editing draft (or a given input) into the target
 *  cell. A cell that flips between literal and formula changes celType, which
 *  `set` cannot do, so the cel is re-installed (inflate + compile + precompute)
 *  and the graph recomputed. The simple value-into-ValueCel case still routes
 *  through `set`. */
export const commitCell: Fn = async (
  state: State, payload?: { addr?: string; input?: string },
) => {
  const addr = payload?.addr ?? selectedAddr(state);
  const editing = readV(state, "sheet.editing") as { draft?: string } | undefined;
  const input = payload?.input ?? editing?.draft ?? "";
  const key = cellKey(addr);
  const existing = state.cels.get(key);
  const segment = (readV(state, "sheet.segment") as string | undefined)
    ?? existing?.metadata.segment ?? "sheet-grid";

  const formula = isFormulaSource(input);
  const set = resolveFn(state, "setValue")!;

  if (!formula && existing && existing.celType === "ValueCel") {
    // Fast path: plain value into an existing data cell — fire downstream.
    await set(state, key, literal(input));
  } else {
    // Re-install the cell at the right kind, recompile, rewire, recompute.
    const live = inflateCel(cellCel(addr, segment, input));
    state.cels.set(key, live as Cel);
    if (live.celType === "FormulaCel") await compileCelBody(live, state);
    resolveSchemas(state);
    precompute(state);
    // precompute clears every _evaluate and rebuilds them only via a
    // fire-and-forget precomputeOptional; await it here so the per-cell
    // VIEW cels (whose formulas dispatch lambda heads like cellVnode)
    // fire through their _evaluate closure — the generic record path
    // resolves input VALUES, and a lambda head needs the resolved cel's
    // _fn, which only the buildEvaluate closure reads.
    await precomputeOptional(state);
    const runCycle = resolveFn(state, "runCycle")!;
    await runCycle(state);
  }

  // Binder formulas (named-function-cels) enqueue their definition
  // request on defn.commit during the cycle; commit them now so the
  // function exists by the time the user's next formula calls it. Then
  // run the drain once more with an empty batch: its orphan sweep must
  // see edits that REMOVED a binder (the flush skips empty queues).
  const defnDrain = resolveFn(state, "defn.drain");
  if (defnDrain) {
    await resolveFn(state, "drain")!(state, "defn.commit");
    await defnDrain([], state);
  }
  // Same for genesis — a sheet cell can hold a generator formula.
  const genesisDrain = resolveFn(state, "genesis.drain");
  if (genesisDrain) {
    await resolveFn(state, "drain")!(state, "genesis.commit");
    await genesisDrain([], state);
  }

  await set(state, "sheet.editing", { editing: false, draft: "" });
  return state;
};
