import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import { diffVNodes } from "./utils/diff.js";
import { applyPatch } from "./utils/apply.js";
import { applyListenerDelta } from "./utils/events.js";
import { paintDrain } from "./utils/paint.js";
import { dom, style, attr, on, img, layout } from "./utils/vocab.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// dom — the painter segment. Ships the RAF-batched paint ChannelCel
// (driven by the per-state painter in dom/paint.ts) plus the pure diff and the
// DOM/global-listener appliers as dispatch-surface LockedLambdaCels, and the
// `patch` schema. The vnode / render-spec schemas the painter consumes ship
// in the html-template-parser segment. See raf-channel.md.
// ============================================================================

export const name = "dom" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["dom.paint.drain",        paintDrain as unknown as Fn],
  ["dom.diffVNodes",         diffVNodes as unknown as Fn],
  ["dom.applyPatch",         applyPatch as unknown as Fn],
  ["dom.applyListenerDelta", applyListenerDelta as unknown as Fn],
  ["dom",                    dom],
  ["style",                  style],
  ["attr",                   attr],
  ["on",                     on],
  ["img",                    img],
  ["layout",                 layout],
]));

export { createPainter, getPainter, setPainter } from "./utils/paint.js";
export { el, text, memo } from "./utils/build.js";
