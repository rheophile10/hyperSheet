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
  // desktop boot: 元's genesis IS the desktop — a wallpaper mount (.origin) plus
  // the navpanel app launcher (folded into 元.f). One run materializes it.
  await (resolve(state, "origin.run"))(state, "元");
  // clean desktop: NOTHING opens on plastron.ca — just wallpaper + the navpanel
  // icons. Hide the base 元 + the desktop worksheet windows (the wallpaper still
  // paints — it's a .origin mount, not a window). The user clicks an icon to open
  // something (🧮 Origin reopens 元). A host presentation choice → lives here, not
  // in the seed (so headless/test boots still get 元 visible).
  {
    const geom = (state.cels.get("win.geom")?.v ?? {}) as Record<string, { closed?: number }>;
    await (resolve(state, "setValue"))(state, "win.geom",
      { ...geom, ["元"]: { ...(geom["元"] ?? {}), closed: 1 }, desktop: { ...(geom.desktop ?? {}), closed: 1 } });
    await (resolve(state, "runCycle"))(state);
  }
  await (resolve(state, "drain"))(state, "dom.paint");
  // first run: materialize the starter kit (readme + keyboard) into OPFS as real
  // files, so the 📖 Readme / 🎹 Keyboard launchers open them and they're editable
  // in 📁 Files. Idempotent — skips files that already exist.
  await (resolve(state, "origin.seedStarter"))(state);
  // The wallpaper paints from 元.f's img mount straight off the windows.wallpaper
  // data-URI (no boot-time OPFS seeding). No auto-restore: a =save()d sheet is a
  // real file in 📁 Files — reopen it with =open() or from the explorer. The
  // file-explorer refreshes its listing when its window opens; the navpanel app
  // launcher materializes from 元's genesis (see 甲骨.json 元.f).
}

// expose for console tinkering + the Playwright suite (createPainter/setPainter
// let harnesses swap in a synchronous painter for measurement)
(globalThis as { plastron?: unknown }).plastron = { state, resolveFn, createPainter, setPainter, precomputeOptional };
