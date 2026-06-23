import type { Fn, State } from "../../../../types/index.js";
import { resolveFn } from "../../../../kernel/index.js";

// ============================================================================
// drag-reassign — "a drop is an event that writes a cel". The reusable substrate
// behind drag-and-drop boards (kanban, file move, tag buckets, calendar slots):
//
//   drag an item that NAMES a cel K → drop on a zone that CARRIES a value V → K := V
//
// The item is rendered draggable and on its dragstart names its own cel:
//   on("dragstart", "drag.grab", "tasks.C3")
// the drop zone carries the value to assign and enables drops:
//   on("dragover", "drag.over"), on("drop", "drag.drop", "Done")
//
// Movement is REACTIVE, not pixel-tracked: drag.drop setValues the named cel, and
// any view formula that references it re-fires through runCycle and re-renders the
// item in its new place. The only transient state is drag.active (the cel in hand).
//
// Pure data-plane — these handlers touch nothing outside the sheet (the same
// surface as typing into a cell), so NO consent/DANGEROUS gating is needed.
// ============================================================================

interface DomEvt { preventDefault?: () => void }

// Painting is an explicit effect (the graph owns value propagation; the host's
// raf does NOT auto-drain). A dispatch handler that writes a cel must repaint —
// so drain dom.paint after the write, exactly as the windows handlers do.
const repaint = (state: State): Promise<unknown> =>
  Promise.resolve((resolveFn(state, "drain") as Fn)(state, "dom.paint"));
const setV = (state: State, k: string, v: unknown): Promise<unknown> =>
  Promise.resolve((resolveFn(state, "setValue") as Fn)(state, k, v)).then(() => repaint(state));

// dragstart on the item — record WHICH cel is in hand.
export const dragGrab: Fn = (async (state: State, key: unknown): Promise<void> => {
  await Promise.resolve((resolveFn(state, "setValue") as Fn)(state, "drag.active", String(key ?? "")));
}) as Fn;

// dragover on a zone — REQUIRED: the browser fires no "drop" unless the default
// is prevented. (Sibling of windows' win.stop, which calls stopPropagation.)
export const dragOver: Fn = ((_state: State, _p: unknown, event?: DomEvt): void => {
  try { event?.preventDefault?.(); } catch { /* no-op off-DOM */ }
}) as Fn;

// drop on a zone carrying VALUE — assign it to the cel in hand, then clear.
export const dragDrop: Fn = (async (state: State, value: unknown): Promise<void> => {
  const k = String(state.cels.get("drag.active")?.v ?? "");
  if (k) await setV(state, k, value);
  await setV(state, "drag.active", null);
}) as Fn;
