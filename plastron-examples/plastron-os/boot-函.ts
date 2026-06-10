// ============================================================================
// plastron-OS — the 函 boot path (proving example for roadmap 06).
//
// The point this proves: ONE data artifact (a 函) + hydrate函 + a boot record
// brings the screen up. The desktop is DATA-shaped — a cels array — so it
// rides in the 函 as an inline payload. hydrate函 installs it dormant, then
// the boot record wakes "desktop" (pulling its dependency closure) and sets
// os.active="home". No imperative hydrate/runCycle wiring for the desktop
// itself: the 函 IS the boot.
//
// Honest scope: the desktop's view helpers (`if` / `eq` / `renderIcons`) are
// NATIVE fns (functions, not data) and the icon grid reads os.apps (app-host
// state). Those stay imperative — registered before the 函 boots, exactly as
// a host always seeds its native capabilities. Doom's asset pipeline is NOT
// force-fit into the 函 (the roadmap is explicit about that). What the 函
// carries is the data: the desktop segment + the boot record.
// ============================================================================

import {
  resolveFn, getPrecomputedIndexes,
} from "../../plastron/dist/index.js";
import { registerDesktopHelpers, desktopSegment, type DesktopApp } from "./desktop.js";

/** Build the plastron-OS application 函: the desktop segment as an inline
 *  payload, boot.wake = ["desktop"], boot.set = os.active → "home". The
 *  desktop's deps (app-host / html-template-parser / dom) are bundled
 *  and already awake, so they need no 函 entry — they're in scope by name for
 *  validateManifests, and waking "desktop" finds them live. */
export const osBoot函 = (apps: DesktopApp[]) => {
  const seg = desktopSegment(apps);
  return {
    version: "0.1.0",
    boot: {
      // Wake the desktop root; its closure (app-host, view layer) is already
      // awake (bundled), so this inflates only the desktop's own cels.
      wake: ["desktop"],
      // os.active lives in the always-awake app-host segment — setting it
      // after wake is a live write (app-host never went dormant). Without
      // this the OS boots with no active view.
      set: [["os.active", "home"]] as Array<[string, unknown]>,
    },
    segments: [
      {
        name: "desktop",
        payload: { inline: { name: "desktop", cels: seg.cels } },
        manifest: {
          version: seg.version,
          dependencies: seg.dependencies,
          role: "application" as const,
        },
      },
    ],
  };
};

/** Boot the OS via the 函 path: register the native view helpers + the
 *  app-host app registry (imperative — these are code, not data), then hand
 *  the 函 to hydrate函. Returns once the desktop is awake and os.active="home".
 *  The caller mounts a painter + runs a cycle to paint (as any host does). */
export const bootOS函 = async (
  state: unknown,
  apps: DesktopApp[],
): Promise<void> => {
  // Native capabilities the desktop templates call. Registered up front —
  // a host always seeds its native fns before booting data.
  await registerDesktopHelpers(state);

  // The single data artifact + hydrate函 + boot record.
  const hydrate函 = resolveFn(state as never, "hydrate函") as (s: unknown, app: unknown) => Promise<unknown>;
  await hydrate函(state, osBoot函(apps));

  // Register the apps with app-host so os.apps drives the icon grid. (app-host
  // ops are native fns over its own state — not 函 data.)
  const register = resolveFn(state as never, "os.register-app") as (s: unknown, a: unknown) => Promise<unknown>;
  for (const a of apps) {
    await register(state, { id: a.id, title: a.title, icon: a.icon, application: a.application ?? a.id });
  }

  // Sanity: the desktop woke (its cels are live, not dormant).
  const idx = getPrecomputedIndexes(state as never);
  if (idx && idx.dormantKeys.has("home.view")) {
    throw new Error("bootOS函: desktop failed to wake — home.view is still dormant.");
  }
};
