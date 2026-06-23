import type { State, Fn, 甲骨, Cel } from "../../../types/index.js";
import { bindNativeFns, resolveFn, ensureSegments } from "../../../kernel/index.js";
import { wasmwinGenesis } from "../wasm-window/index.js";
import { createDoomHarness, type DoomHarness } from "./doom-harness.js";
import seed from "./甲骨.json" with { type: "json" };

// doom — the first USER of the wasm-window kind. `=doom()` opens a freespace
// window running Doom: the wasm-window library supplies the window + canvas +
// key routing; this segment supplies the engine (doom.wasm), the WASI harness,
// and the lazy, CONSENT-GATED asset load. Assets are hosted at plastron.ca and
// fetched at runtime — never inlined (the 28 MB WAD would wreck the bundle).

const ASSETS = (globalThis as { __doomAssets?: string }).__doomAssets ?? "/"; // base for doom.wasm + the WAD (overridable for e2e)
const WAD = "freedoom1.wad";
let _harness: DoomHarness | null = null;
let _booting = false; // sync re-entry guard: armboot can fire boot() several times

const setOut = (state: State, v: unknown): void => { void (resolveFn(state, "setValue") as Fn)(state, "wasm.doom.out", v); };
const b64 = (u8: Uint8Array): string => { let s = ""; for (const x of u8) s += String.fromCharCode(x); return btoa(s); };

// =doom() — mint the DOOM window (canvas + bridge cels) and arm the boot. A
// genesis; the window materialises, then `doom.arm` RAF-defers the engine boot
// so the canvas exists first.
const doomFn: Fn = (() => {
  const g = wasmwinGenesis("doom", "🐢 DOOM", "doom.engine", { w: 640, h: 400 });
  g.cels["wasm.doom.armboot"] = { celType: "FormulaCel", f: "(doom.arm wasm.doom.state)", metadata: { name: "armboot", parser: "f", segment: "wasm.doom" } };
  return g;
}) as Fn;

// doom.arm — fired once when the window materialises; RAF-defer doom.boot so the
// <canvas id="wasm-doom"> is mounted before the harness grabs it. Off-browser
// (no rAF) it is a no-op, so a headless mint doesn't try to boot an engine.
const arm: Fn = (async (state: State): Promise<string> => {
  const g = globalThis as { requestAnimationFrame?: (cb: () => void) => void };
  if (g.requestAnimationFrame) g.requestAnimationFrame(() => { void boot(state); });
  return "armed";
}) as Fn;

// doom.boot — the browser boot: fetch doom.wasm + the WAD, createDoomHarness,
// register the provider cel, hydrate the kind:"wasm" engine cel (the
// wasm-host-instance hook captures the live instance), start the RAF tick loop.
// Idempotent. Status streams to wasm.doom.out (engine→graph).
export const boot = async (stateArg: State): Promise<void> => {
  // The armboot FORMULA `(doom.arm wasm.doom.state)` hands arm/boot the window
  // STATE-CEL VALUE (formula verbs get evaluated args, not the kernel State), so a
  // dynamically-launched window can't receive the real State through it. Recover
  // the live kernel State the host exposes; a direct call (host/test) passes it.
  const state: State = (stateArg && (stateArg as { cels?: unknown }).cels)
    ? stateArg
    : (((globalThis as { plastron?: { state?: State } }).plastron?.state) ?? stateArg);
  if (!state || !(state as { cels?: unknown }).cels) return;
  // _harness gates a completed boot; _booting gates the async window BEFORE
  // _harness is set (fetchBytes awaits) so concurrent fires don't double-instantiate.
  if (_harness || _booting) return;
  const doc = (globalThis as { document?: { getElementById(id: string): { width: number; height: number; getContext(s: "2d"): unknown } | null } }).document;
  const canvas = doc?.getElementById("wasm-doom");
  if (!canvas) return; // off-browser / canvas not mounted — armboot fires before the canvas paints; a later fire (canvas up) boots
  // claim the boot ONLY now that we'll actually run it — set after the canvas
  // early-return so an early fire doesn't leak the guard and block the real boot.
  _booting = true;


  const fetchBytes = async (name: string): Promise<Uint8Array> => {
    setOut(state, `fetching ${name}…`);
    const r = await (globalThis as { fetch: typeof fetch }).fetch(ASSETS + name);
    if (!r.ok) throw new Error(`doom: ${name} HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  };

  try {
    const wadBytes = await fetchBytes(WAD);
    const wasmBytes = await fetchBytes("doom.wasm");
    setOut(state, "creating harness…");
    // Wire Doom's DMX SFX → the Web Audio `sound` segment (the harness is SILENT
    // without these callbacks). ensureSegments lazy-loads `sound` on first boot; if
    // it can't resolve (off-browser / no AudioContext) the callbacks stay undefined
    // and the harness runs muted. play-pcm returns its own handle the harness tracks.
    await ensureSegments(state, ["sound"]);
    const sfn = (verb: string): Fn | undefined => resolveFn(state, `sound.${verb}`) as Fn | undefined;
    const sPlay = sfn("play-pcm"), sStop = sfn("stop-source"), sUpd = sfn("update-source"), sIs = sfn("is-playing");
    _harness = createDoomHarness(wadBytes, {
      canvas: canvas as never, wadName: WAD, onLog: () => {},
      playPcm: sPlay ? (info) => Number(sPlay(state, { samples: info.samples, rate: info.rate, gain: info.gain, pan: info.pan })) : undefined,
      stopPcm: sStop ? (h: number) => { void sStop(state, h); } : undefined,
      updatePcm: sUpd ? (h: number, a: { gain: number; pan: number }) => { void sUpd(state, h, a); } : undefined,
      isPcmPlaying: sIs ? (h: number) => Boolean(sIs(state, h)) : undefined,
      // quit-to-DOS (the engine calls proc_exit) → close the window + reset the
      // guards so a re-launch reboots a fresh engine. proc_exit cancels its RAF then
      // throws, so schedule the (async) close+repaint OFF that unwinding stack.
      onExit: () => {
        _harness = null; _booting = false;
        void Promise.resolve().then(async () => {
          const close = resolveFn(state, "winx.close") as Fn | undefined;
          if (close) await close(state, "wasm.doom.state");
          const stopAll = resolveFn(state, "sound.stop-all") as Fn | undefined;
          if (stopAll) await stopAll(state);
          setOut(state, "exited");
          const drain = resolveFn(state, "drain") as Fn | undefined;
          if (drain) await drain(state, "dom.paint");
        });
      },
      // window CLOSED/MINIMIZED (the ✕ or – just flip wasm.doom.state, dropping the
      // canvas) → free the harness + CUT AUDIO so the hidden demo stops making
      // noise. Unlike onExit, do NOT touch window state (the window is already
      // hidden; closing a minimized one would yank it from the taskbar). Freeing
      // _harness lets a reopen/restore re-arm → reboot a fresh engine.
      onDetach: () => {
        _harness = null; _booting = false;
        void Promise.resolve().then(async () => {
          const stopAll = resolveFn(state, "sound.stop-all") as Fn | undefined;
          if (stopAll) await stopAll(state);
          setOut(state, "stopped");
        });
      },
    });

    await (resolveFn(state, "setCel") as Fn)(state, "doom-provider", {
      celType: "LockedLambdaCel", fn: () => _harness!.provider(), metadata: { key: "doom-provider", segment: "doom", kind: "native" },
    });
    await (resolveFn(state, "hydrate") as Fn)(state, [{
      name: "doom",
      cels: [{ key: "doom.engine", celType: "EditableLambdaCel", metadata: { key: "doom.engine", segment: "doom", kind: "wasm", imports: "doom-provider" }, f: b64(wasmBytes) }],
    }], []);
    setOut(state, "starting…");
    _harness.start();
    setOut(state, "running");
  } catch (e) {
    setOut(state, `#ERROR(doom: ${(e as Error).message})`);
    _harness?.stop?.(); _harness = null;
  } finally {
    _booting = false;
  }
};
const bootFn: Fn = (async (state: State): Promise<State> => { await boot(state); return state; }) as Fn;
const stopFn: Fn = (async (state: State): Promise<State> => { _harness?.stop?.(); _harness = null; _booting = false; setOut(state, "stopped"); return state; }) as Fn;

export const name = "doom" as const;
export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["doom", doomFn],
  ["doom.arm", arm],
  ["doom.boot", bootFn],
  ["doom.stop", stopFn],
]));
