import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import { el as makeEl, text as T } from "../dom/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// io-touch — mobile input via a virtual-key overlay (io-touch.md, accepted;
// depends on io-keys). io-keys made input source-agnostic; this is the SECOND
// PRODUCER: an on-screen overlay whose hold-buttons synthesize key events
// through the SAME keys.capture entry point the physical keyboard uses — one
// code path, one set of routing semantics. Doom cannot tell a thumb from a
// keyboard. pointerdown/up/cancel (not click) so HOLDS work (movement needs
// key-held, not key-tapped).
// ============================================================================

type V = { type: "el" | "text"; tag?: string; attrs?: Record<string, unknown>; events?: Record<string, unknown>; children?: V[]; text?: string };
const el = makeEl as unknown as (tag: string, attrs?: Record<string, unknown>, children?: V[], events?: Record<string, unknown>) => V;
const keysCapture = (state: State, evt: unknown): Promise<unknown> => Promise.resolve((resolveFn(state, "keys.capture") as Fn)(state, null, evt));

// touch.press / touch.release — synthesize a key event through keys.capture, so
// keys.pressed + keys.event + routing all behave exactly as for a real key.
const pressFn: Fn = (async (state: State, key: unknown): Promise<void> => { await keysCapture(state, { type: "keydown", key: String(key), target: {} }); }) as Fn;
const releaseFn: Fn = (async (state: State, key: unknown): Promise<void> => { await keysCapture(state, { type: "keyup", key: String(key), target: {} }); }) as Fn;

// touchpad(keys) — keys = [{label, key}, …] → an overlay of hold-buttons.
const touchpadFn: Fn = ((keys: unknown): V => {
  const list = Array.isArray(keys) ? keys : [];
  return el("div", { class: "io-touch", style: "position:fixed;left:0;right:0;bottom:0;display:flex;gap:.5rem;justify-content:center;padding:.6rem;touch-action:none;user-select:none;z-index:9999" },
    list.map((k) => {
      const o = k as { key?: unknown; label?: unknown };
      const key = String(o?.key ?? k);
      return el("button", { class: "io-touch-btn", "data-key": key, style: "min-width:3.2rem;min-height:3.2rem;border-radius:.6rem;border:1px solid #8886;background:#8882;font:600 1.1rem ui-monospace,monospace;touch-action:none" }, [T(String(o?.label ?? key))], {
        pointerdown: { dispatch: "touch.press", payload: key },
        pointerup: { dispatch: "touch.release", payload: key },
        pointercancel: { dispatch: "touch.release", payload: key },
      });
    }));
}) as Fn;

// touchcapable() — environment probe (a touch device?). Hosts/tests can ignore + force.
const capableFn: Fn = ((): boolean => {
  const g = globalThis as { navigator?: { maxTouchPoints?: number }; ontouchstart?: unknown };
  return !!(g.navigator && (g.navigator.maxTouchPoints ?? 0) > 0) || "ontouchstart" in g;
}) as Fn;

export const name = "io-touch" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["touch.press", pressFn],
  ["touch.release", releaseFn],
  ["touchpad", touchpadFn],
  ["touchcapable", capableFn],
]));
