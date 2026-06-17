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
await (resolve(state, "runCycle"))(state);

// URL boot? A #f= / #raw= shared formula is UNTRUSTED: bootFromHash LOCKS the
// kernel and makes that formula BE 元, so a stranger's plastron renders jailed
// (no net/storage/code/secrets until the user grants via the 🛡 badge). When it
// fires we SKIP the desktop boot entirely — the page is the shared plastron.
const shared = location.hash ? await bootFromHash(state, location.hash) : null;
if (shared) {
  await (resolve(state, "drain"))(state, "dom.paint");
} else {
  // normal desktop boot: 元's value is a genesis (doc(desktop)…); commit drains
  // it so the wallpaper + app windows materialize (hydrate/runCycle alone don't
  // drain genesis). With an empty draft, commit re-applies the README seed.
  await (resolve(state, "origin.commit"))(state, "元");
  await (resolve(state, "drain"))(state, "dom.paint");
  // wallpaper FROM an OPFS file (shipped data-URI → desktop.A2 → the img verb).
  await (resolve(state, "origin.seedWallpaper"))(state);
  await (resolve(state, "drain"))(state, "dom.paint");
  // seed the page's own served HTML into OPFS so the file explorer shows "the
  // index.html that plastron makes" (only OPFS is reachable from the sandbox).
  await (resolve(state, "origin.seedIndexHtml"))(state);
  // initial file-explorer listing (nav/open handlers refresh it thereafter).
  await (resolve(state, "origin.explorerRefresh"))(state);
  await (resolve(state, "drain"))(state, "dom.paint");
  // restore a previously =save()d sheet (localStorage default slot), repaint.
  await (resolve(state, "origin.autoload"))(state);
  await (resolve(state, "drain"))(state, "dom.paint");
  // boot with the examples ALREADY OPEN: the Symphony of Cels (score + keyboard
  // + melody) and the MIDI track (midi + ▶ play). MIDI runs LAST so it's newest →
  // lands in the top rows (row-flow orders newest-first).
  await (resolve(state, "origin.demoMusic"))(state);
  await (resolve(state, "origin.demoMidi"))(state);
  await (resolve(state, "drain"))(state, "dom.paint");
}

// expose for console tinkering + the Playwright suite (createPainter/setPainter
// let harnesses swap in a synchronous painter for measurement)
(globalThis as { plastron?: unknown }).plastron = { state, resolveFn, createPainter, setPainter, precomputeOptional };
