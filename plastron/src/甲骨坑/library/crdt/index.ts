import type { 甲骨, Cel, Fn } from "../../../types/index.js";
import { bindNativeFns } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// crdt — a string value modelled as a grow-only stack of LINE-LEVEL diffs
// (crdt-diff-stack.md, under-consideration). Each stack layer is one
// authorship-stamped edit { id, author, ts, parent, ops }; resolving the stack
// folds the diffs from "" to the current text (or n edits up from 0).
//
// Convergence: every replica sorts the identical layer set identically by
// (ts, author, id), so the fold is identical everywhere. Exact for sequential /
// self edits; convergent-LWW for truly-concurrent same-region edits (NOT full
// OT). Who may append is enforced externally — the CRDT only RECORDS author/ts.
//
// All verbs are PURE (no Date.now / no Math.random): `ts` is passed in, ids are
// content hashes. That keeps replay deterministic and the segment testable.
// ============================================================================

interface Hunk { at: number; del: number; ins: string[]; }
interface Layer { id: string; author: string; ts: number; parent: string | null; ops: Hunk[]; }

// "" is the empty document (0 lines); a non-empty string splits on \n.
const toLines = (text: unknown): string[] => {
  const s = text == null ? "" : String(text);
  return s === "" ? [] : s.split("\n");
};
const fromLines = (lines: string[]): string => lines.join("\n");

// djb2 → base36. Deterministic content hash for stable, dedupable layer ids.
const hash = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

// ── diff: minimal line-level edit between two strings, as hunks ─────────────
// LCS dynamic-programming table + backtrace, coalescing del/ins runs between
// kept lines into { at, del, ins } hunks indexed in `before` coordinates so
// that apply(before, diff(before, after)) === after.
const diffLines = (before: string[], after: string[]): Hunk[] => {
  const m = before.length, n = after.length;
  // lcs[i][j] = LCS length of before[i..] and after[j..]
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const ops: Hunk[] = [];
  let hunk: Hunk | null = null;
  const flush = () => { if (hunk) { ops.push(hunk); hunk = null; } };
  const open = (at: number) => (hunk ??= { at, del: 0, ins: [] });

  let i = 0, j = 0;
  while (i < m && j < n) {
    if (before[i] === after[j]) { flush(); i++; j++; }            // keep
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { open(i).del++; i++; } // delete before[i]
    else { open(i).ins.push(after[j]); j++; }                      // insert after[j]
  }
  while (i < m) { open(i).del++; i++; }                            // trailing deletes
  while (j < n) { open(m).ins.push(after[j]); j++; }               // trailing inserts (at end of before)
  flush();
  return ops;
};

// ── apply: fold hunks into text (total — clamps so a stale hunk never throws) ─
const applyHunks = (text: unknown, ops: unknown): string => {
  const lines = toLines(text);
  const hunks = Array.isArray(ops) ? (ops as Hunk[]) : [];
  // High `at` first so lower indices stay valid as we splice.
  for (const h of [...hunks].sort((a, b) => (b?.at ?? 0) - (a?.at ?? 0))) {
    if (!h) continue;
    const at = Math.max(0, Math.min(Math.trunc(h.at ?? 0), lines.length));
    const del = Math.max(0, Math.min(Math.trunc(h.del ?? 0), lines.length - at));
    const ins = Array.isArray(h.ins) ? h.ins.map((x) => String(x)) : [];
    lines.splice(at, del, ...ins);
  }
  return fromLines(lines);
};

// ── layer: one authorship-stamped diff record ──────────────────────────────
const makeLayer = (before: unknown, after: unknown, author: unknown, ts: unknown, parent?: unknown): Layer => {
  const ops = diffLines(toLines(before), toLines(after));
  const a = String(author ?? "");
  const t = Number(ts ?? 0) || 0;
  const p = parent == null ? null : String(parent);
  return { id: `${t}.${a}.${hash(JSON.stringify(ops))}`, author: a, ts: t, parent: p, ops };
};

// Total order over layers: ts, then author, then id (full tie-break) — the
// SAME comparison on every replica, which is what makes the fold convergent.
const cmp = (x: Layer, y: Layer): number =>
  (x.ts - y.ts) || (x.author < y.author ? -1 : x.author > y.author ? 1 : 0)
  || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

const asStack = (stack: unknown): Layer[] => (Array.isArray(stack) ? (stack as Layer[]).filter(Boolean) : []);

// ── append: grow-only, sorted, deduped-by-id insert → NEW array ─────────────
const appendLayer = (stack: unknown, record: unknown): Layer[] => {
  const out = asStack(stack).slice();
  const rec = record as Layer | null;
  if (rec && rec.id && !out.some((l) => l.id === rec.id)) out.push(rec);
  out.sort(cmp);
  return out;
};

// ── resolve: fold from "" over the sorted stack (full, or first n layers) ───
const resolveStack = (stack: unknown, n?: unknown): string => {
  const layers = asStack(stack).slice().sort(cmp);
  const upto = n == null ? layers.length : Math.max(0, Math.min(Math.trunc(Number(n)), layers.length));
  let text = "";
  for (let i = 0; i < upto; i++) text = applyHunks(text, layers[i].ops);
  return text;
};

const diffFn:    Fn = ((before: unknown, after: unknown) => diffLines(toLines(before), toLines(after))) as Fn;
const applyFn:   Fn = ((text: unknown, ops: unknown) => applyHunks(text, ops)) as Fn;
const layerFn:   Fn = ((before: unknown, after: unknown, author: unknown, ts: unknown, parent?: unknown) => makeLayer(before, after, author, ts, parent)) as Fn;
const appendFn:  Fn = ((stack: unknown, record: unknown) => appendLayer(stack, record)) as Fn;
const resolveFnImpl: Fn = ((stack: unknown, n?: unknown) => resolveStack(stack, n)) as Fn;

export const name = "crdt" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["crdt.diff",    diffFn],
  ["crdt.apply",   applyFn],
  ["crdt.layer",   layerFn],
  ["crdt.append",  appendFn],
  ["crdt.resolve", resolveFnImpl],
]));
