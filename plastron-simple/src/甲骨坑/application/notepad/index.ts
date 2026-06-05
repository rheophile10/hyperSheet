import type { DehydratedCel, Fn, State, 甲骨 } from "../../../types/index.js";
import { resolveFn } from "../../../kernel/index.js";
import notepadSeed from "./甲骨.json" with { type: "json" };

// ============================================================================
// notepad — the simplest non-spreadsheet application: a <textarea> bound to a
// text cel, rendered through html-template + plastron-dom. A clean
// demonstration that "an application is just cels + a view".
//
// The canonical default segment is pure data — the text/mount/path/binding
// ValueCels + the view FormulaCel — and lives in 甲骨.json. buildNotepad loads
// that seed, deep-clones it, and applies opts overrides (the same factory
// surface as buildSheet). Editing needs ZERO custom code: the textarea's
// onInput routes through the shipped `{ set, extract }` event binding, which
// reads event.target.value and `set`s the text cel directly. Only persistence
// needs native fns, and those are host-injected at runtime by
// installNotepadActions — `setCel` with a LockedLambdaCel celType, carrying
// the fn — rather than bundled into the boot, matching the host-capability
// model (the `host` segment, the painter).
//
// The cel keys are fixed ("notepad.text", …) regardless of the segment name,
// exactly like sheet's fixed "sheet.<addr>" keys: one note is active at a
// time. See docs/4-current/05-runCycle/08-notepad-app.md.
// ============================================================================

export interface BuildNotepadOpts {
  /** Initial note text (default ""). */
  text?: string;
  /** Mount selector the painter paints into (default "#notepad"). */
  mount?: string;
  /** File-store path save/load read & write (default "notepad.txt"). */
  path?: string;
  /** Segment name to tag the generated cels with (default "notepad"). */
  segment?: string;
}

type NotepadSegment = 甲骨 & { version: string; role: "application"; dependencies: string[] };

/** Build the notepad application segment: the text cel + the view that renders
 *  and writes it. Pure data (no `_fn`), so the host hydrates it directly.
 *
 *  Loads the canonical default segment from 甲骨.json, deep-clones it, and
 *  applies opts: text/mount/path remap the matching ValueCels' `v`; segment
 *  retags both the manifest name and every cel's metadata.segment (cel KEYS
 *  stay fixed — "notepad.text", … — like sheet's fixed addresses). */
export const buildNotepad = (
  opts: BuildNotepadOpts = {},
): NotepadSegment => {
  const seg = structuredClone(notepadSeed) as unknown as NotepadSegment;
  const segment = opts.segment ?? seg.name;
  seg.name = segment;

  const byKey = (key: string): DehydratedCel | undefined =>
    seg.cels.find((c) => (c as DehydratedCel & { key: string }).key === key) as DehydratedCel | undefined;
  const setV = (key: string, v: unknown): void => {
    const cel = byKey(key) as (DehydratedCel & { v: unknown }) | undefined;
    if (cel) cel.v = v;
  };

  if (opts.text  !== undefined) setV("notepad.text",  opts.text);
  if (opts.mount !== undefined) setV("notepad.mount", opts.mount);
  if (opts.path  !== undefined) setV("notepad.path",  opts.path);

  for (const cel of seg.cels) (cel.metadata as { segment: string }).segment = segment;
  return seg;
};

// ── runtime persistence actions ─────────────────────────────────────────────
//
// Save/load are async fs round-trips, so they can't be value formulas (no
// await). They're registered as locked native dispatch cels the Save/Load
// buttons reach via `(dispatch notepad.save)`. Installed at runtime against
// the live file-store rather than bundled, keeping the app segment pure data.

const noteText = (state: State): string => (state.cels.get("notepad.text")?.v as string) ?? "";
const notePath = (state: State): string => (state.cels.get("notepad.path")?.v as string) ?? "notepad.txt";

/** Register notepad.save / notepad.load against the live file-store. Idempotent
 *  re-registration is fine (the cels are locked but unchanged in behavior). */
export const installNotepadActions = async (
  state: State, opts: { segment?: string } = {},
): Promise<State> => {
  const setCelFn = resolveFn(state, "setCel")!;
  const segment = opts.segment ?? "notepad";

  const save: Fn = async (st: State) => {
    const writeText = resolveFn(st, "fs.writeText");
    if (writeText) await writeText(notePath(st), noteText(st));
    return st;
  };

  const load: Fn = async (st: State) => {
    const readText = resolveFn(st, "fs.readText");
    const exists = resolveFn(st, "fs.exists");
    const set = resolveFn(st, "setValue");
    if (!readText || !set) return st;
    const path = notePath(st);
    // Loading a note that was never saved is a no-op, not an error.
    if (exists && !(await exists(path))) return st;
    await set(st, "notepad.text", await readText(path));
    return st;
  };

  await setCelFn(state, "notepad.save", { celType: "LockedLambdaCel", locked: true, fn: save, metadata: { segment, kind: "native" } });
  await setCelFn(state, "notepad.load", { celType: "LockedLambdaCel", locked: true, fn: load, metadata: { segment, kind: "native" } });
  return state;
};
