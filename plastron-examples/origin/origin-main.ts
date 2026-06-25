// ============================================================================
// origin-main — THE boot for the origin host (origin-segment.md).
//
// The whole host: wake the origin segment, hydrate, paint. The kernel
// surfaces 元.view at "#app" — one centered cel in freespace whose value
// is the readme. Type formulas to grow an application out of it.
// ============================================================================
import {
  createInitialState, resolveFn, precomputeOptional, createPainter, setPainter,
} from "../../plastron/dist/index.js";
import { bootFromHash } from "../../plastron/dist/甲骨坑/application/origin/index.js";

const resolve = resolveFn as (s: unknown, k: string) => (...a: unknown[]) => Promise<unknown> | unknown;

const state = createInitialState();
setPainter(state, createPainter(state)); // real rAF + document
await (resolve(state, "ensureSegments"))(state, ["origin"]);
await (resolve(state, "hydrate"))(state, [], []);
await (resolveFn(state, "precomputeOptional") ?? precomputeOptional)(state);
await (resolve(state, "origin.viewportSync"))(state);   // seed viewport.* before first eval
await (resolve(state, "origin.clockSync"))(state);      // seed clock before first eval
await (resolve(state, "runCycle"))(state);

// host-ticked clock: refresh the clock cel every second (clockSync no-ops unless
// the minute rolled), then repaint so a taskbar referencing `clock` updates.
setInterval(async () => {
  const before = state.cels.get("clock")?.v;
  await (resolve(state, "origin.clockSync"))(state);
  if (state.cels.get("clock")?.v !== before) {
    await (resolve(state, "runCycle"))(state);
    await (resolve(state, "drain"))(state, "dom.paint");
  }
}, 1000);

// reactive viewport: on resize, refresh the viewport.* cels and repaint, so
// formulas that reference them (viewport.w / .h / .mobile / .orient) relayout.
let vpT: ReturnType<typeof setTimeout> | undefined;
globalThis.addEventListener?.("resize", () => {
  clearTimeout(vpT);
  vpT = setTimeout(async () => {
    await (resolve(state, "origin.viewportSync"))(state);
    await (resolve(state, "runCycle"))(state);
    await (resolve(state, "drain"))(state, "dom.paint");
  }, 120);
});

// URL boot? A #f= / #raw= shared formula is UNTRUSTED: bootFromHash LOCKS the
// kernel and makes that formula BE 元, so a stranger's plastron renders jailed
// (no net/storage/code/secrets until the user grants via the 🛡 badge). When it
// fires we SKIP the desktop boot entirely — the page is the shared plastron.
const shared = location.hash ? await bootFromHash(state, location.hash) : null;
if (shared) {
  await (resolve(state, "drain"))(state, "dom.paint");
} else {
  // desktop boot: install the baked origin-application archives into OPFS, then
  // open the desktop shell (wallpaper + draggable icons + taskbar + state graph)
  // — the cutover from the legacy 元-genesis desktop. The base 元 readme seed stays
  // for the ▣ Origin launcher (which reopens the base spreadsheet).
  // No persistent storage (file:// with no OPFS, or an OPFS-less browser) means
  // the baked apps can't be installed to the segment store — boot.run throws.
  // Degrade instead of white-screening: catch it, leave the base 元 spreadsheet
  // visible, and let keys + sheets move via manual import/export. (The CRDT +
  // crypto pipeline runs entirely in memory and needs no storage backend.)
  try {
    await (resolve(state, "boot.run"))(state, { open: "desktop" });
  } catch (e) {
    console.warn("desktop boot skipped (no storage backend?):", (e as { message?: string })?.message ?? e);
  }
  // Once the desktop shell is up, hide the base 元 grid — the desktop chrome is
  // rendered by .origin mounts that paint independently of the grid window, and
  // the ▣ Origin launcher restores 元 on demand. If the desktop didn't hydrate
  // (apps not baked, or no storage backend), leave 元 visible so the page isn't blank.
  if (state.cels.get("desktop.iconbar.frame")) {
    const cur = (state.cels.get("win.元.state")?.v ?? {}) as Record<string, unknown>;
    await (resolve(state, "setValue"))(state, "win.元.state", { ...cur, closed: 1 });
    await (resolve(state, "runCycle"))(state);
  }
  // readme/keyboard/turtles are sheetapp origin-user DOCUMENTS (installed to the
  // segment store by boot.run), opened via their desktop icons.
  await (resolve(state, "drain"))(state, "dom.paint");
}

// expose for console tinkering + the Playwright suite (createPainter/setPainter
// let harnesses swap in a synchronous painter for measurement)
(globalThis as { plastron?: unknown }).plastron = { state, resolveFn, createPainter, setPainter, precomputeOptional };
