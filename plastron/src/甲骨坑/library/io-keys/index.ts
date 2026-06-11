import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// io-keys — keyboard routing as a reusable LIBRARY (io-keys.md, accepted).
// Input is DATA through cels: the physical keyboard is just one PRODUCER writing
// `keys.event` + `keys.pressed`; consumers never know the source (touch overlay,
// gamepad, a remote peer, or a test can write the same cels). A host attaches
// ONE listener pair (document|keydown/keyup → keys.capture) + window|blur →
// keys.blur, declares a per-app keymap cel (keys.map.<app>), and sets the active
// app (keys.active). keys.route matches + dispatches the action — imperative
// (latency-sensitive, preventDefault must be synchronous), not a channel.
// ============================================================================

interface KeyEvt { type?: string; key?: unknown; code?: unknown; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; target?: { tagName?: string; isContentEditable?: boolean }; preventDefault?: () => void }
interface EvtData { type: "down" | "up"; key: string; code: string; mods: { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean }; editable: boolean }
interface MapEntry { key?: string; action?: string; inEditable?: boolean; preventDefault?: boolean; mods?: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean }; payload?: unknown }

const isEditable = (t: KeyEvt["target"]): boolean => {
  const tag = String(t?.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || !!t?.isContentEditable;
};
const eventData = (e: KeyEvt): EvtData => ({
  type: e?.type === "keyup" ? "up" : "down",
  key: String(e?.key ?? ""), code: String(e?.code ?? ""),
  mods: { shift: !!e?.shiftKey, ctrl: !!e?.ctrlKey, alt: !!e?.altKey, meta: !!e?.metaKey },
  editable: isEditable(e?.target),
});
const setV = (state: State, pairs: [string, unknown][]): Promise<unknown> => Promise.resolve((resolveFn(state, "setValueBatch") as Fn)(state, pairs));

// keys.route — match the event against the active app's keymap + dispatch. First
// match wins. A binding fires only when the target is NOT editable, unless it
// declares inEditable (so Enter can still commit inside the cell editor).
const routeFn: Fn = (async (state: State, _p: unknown, event?: KeyEvt): Promise<void> => {
  const active = String(state.cels.get("keys.active")?.v ?? "");
  if (!active || !event) return;
  const map = state.cels.get(`keys.map.${active}`)?.v as MapEntry[] | undefined;
  if (!Array.isArray(map)) return;
  const d = eventData(event);
  for (const e of map) {
    if (!e || e.key !== d.key) continue;
    if (d.editable && !e.inEditable) continue;                     // typing in an input ≠ a shortcut
    if (e.mods && (["shift", "ctrl", "alt", "meta"] as const).some((m) => !!e.mods![m] !== d.mods[m])) continue;
    if (e.preventDefault && typeof event.preventDefault === "function") event.preventDefault();
    if (e.action) { const fn = resolveFn(state, e.action); if (fn) await fn(state, e.payload, event); }
    break;
  }
}) as Fn;

// keys.capture — the one document keydown/keyup handler. Writes the event +
// the held set as cels, then routes on keydown.
const captureFn: Fn = (async (state: State, _p: unknown, event?: KeyEvt): Promise<void> => {
  const d = eventData(event ?? {});
  const pressed = { ...(state.cels.get("keys.pressed")?.v as Record<string, boolean> ?? {}) };
  if (d.type === "down") pressed[d.key] = true; else delete pressed[d.key];
  await setV(state, [["keys.event", d], ["keys.pressed", pressed]]);
  if (d.type === "down") await routeFn(state, null, event);
}) as Fn;

// keys.blur — clear the held set (the standard stuck-key fix on window blur).
const blurFn: Fn = (async (state: State): Promise<void> => { await setV(state, [["keys.pressed", {}]]); }) as Fn;

export const name = "io-keys" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["keys.capture", captureFn],
  ["keys.route", routeFn],
  ["keys.blur", blurFn],
]));
