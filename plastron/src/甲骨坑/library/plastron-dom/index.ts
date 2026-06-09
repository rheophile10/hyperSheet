import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import { diffVNodes } from "./utils/diff.js";
import { applyPatch } from "./utils/apply.js";
import { applyListenerDelta } from "./utils/events.js";
import { paintDrain } from "./utils/paint.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// plastron-dom — the painter segment. Ships the RAF-batched paint ChannelCel
// (driven by the per-state painter in dom/paint.ts) plus the pure diff and the
// DOM/global-listener appliers as dispatch-surface LockedLambdaCels, and the
// `patch` schema. The vnode / render-spec schemas the painter consumes ship
// in the html-template-parser segment. See raf-channel.md.
// ============================================================================

export const name = "plastron-dom" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["plastron-dom.paint.drain",        paintDrain as unknown as Fn],
  ["plastron-dom.diffVNodes",         diffVNodes as unknown as Fn],
  ["plastron-dom.applyPatch",         applyPatch as unknown as Fn],
  ["plastron-dom.applyListenerDelta", applyListenerDelta as unknown as Fn],
]));

export { createPainter, getPainter, setPainter } from "./utils/paint.js";
export { el, text, memo } from "./utils/build.js";
