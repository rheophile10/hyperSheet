// validate — extract a plastron formula/link from a model's reply, then run it
// through the REAL kernel: boot origin headless, commit it as 元, and report
// whether it parsed + evaluated without error. This is the "is it viable?" check.
import { createInitialState, resolveFn, setPainter } from "../../../plastron/dist/index.js";
import { decodeLink } from "../../../plastron/dist/甲骨坑/application/origin/share-link.js";

type Fn = (...a: unknown[]) => unknown;
export interface Verdict { ok: boolean; kind: string; formula: string | null; note: string }

// Capture up to whitespace/quotes — parens are KEPT (a #raw= formula contains
// literal "(" / ")"; excluding them truncated the formula).
const LINK_RE = /https?:\/\/[^\s"'`]*#(?:f|raw|aes256gcm|otp)=[^\s"'`]+/;
const FRAG_RE = /#(?:f|raw|aes256gcm|otp)=[^\s"'`]+/;

// Pull the most likely formula/link out of free-form model prose.
const extract = async (text: string): Promise<{ kind: string; formula: string | null; note: string }> => {
  const t = String(text ?? "");
  const link = (LINK_RE.exec(t) ?? FRAG_RE.exec(t))?.[0];
  if (link) {
    if (/#(?:aes256gcm|otp)=/.test(link)) return { kind: "encrypted-link", formula: null, note: "encrypted link — needs a passphrase/pad, not auto-validated" };
    if (/#raw=/.test(link)) {
      const m = /#raw=([^\s"'`]+)/.exec(link)![1]!;
      try { return { kind: "raw-link", formula: decodeURIComponent(m), note: "" }; }
      catch { return { kind: "raw-link", formula: null, note: "malformed #raw= percent-encoding" }; }
    }
    try { return { kind: "f-link", formula: await decodeLink(link), note: "" }; }   // #f=
    catch (e) { return { kind: "f-link", formula: null, note: "bad #f= payload: " + String((e as { message?: unknown })?.message ?? e) }; }
  }
  // a fenced code block, else the first line that looks like a formula
  const fenced = /```[a-z]*\n([\s\S]*?)```/i.exec(t)?.[1];
  const body = (fenced ?? t).split("\n").map((l) => l.trim()).find((l) => l.startsWith("=") || l.startsWith("("));
  if (body) return { kind: "formula", formula: body, note: "" };
  return { kind: "none", formula: null, note: "no formula or plastron link found in the reply" };
};

// Boot origin headless and commit `formula` as 元; success = no parse/eval error.
const runFormula = async (formula: string): Promise<{ ok: boolean; note: string }> => {
  const st = createInitialState();
  setPainter(st, { enqueue: () => {} } as never);
  await (resolveFn(st, "ensureSegments") as Fn)(st, ["origin"]);
  await (resolveFn(st, "hydrate") as Fn)(st, [], []);
  try {
    await (resolveFn(st, "setValue") as Fn)(st, "元.draft", formula);
    await (resolveFn(st, "origin.commit") as Fn)(st, "元");
  } catch (e) { return { ok: false, note: "threw: " + String((e as { message?: unknown })?.message ?? e) }; }
  const err = String((st.cels.get("元.error")?.v ?? "")).trim();
  if (err && err !== "null") return { ok: false, note: "error cel: " + err.slice(0, 140) };
  const v = st.cels.get("元")?.v;
  if (v === undefined || v === null || v === "") return { ok: false, note: "评 produced an empty value" };
  return { ok: true, note: "parsed + evaluated" };
};

export const validate = async (text: string | null): Promise<Verdict> => {
  if (!text) return { ok: false, kind: "no-reply", formula: null, note: "no reply" };
  const ex = await extract(text);
  if (!ex.formula) return { ok: false, kind: ex.kind, formula: null, note: ex.note };
  // A viable result must be an actual FORMULA (= infix / ( s-expr), not a literal
  // value. The classic failure — a JSON wrapper in a #f= link — decodes to "{…}",
  // which plastron would store as a plain string (no error), so guard against it.
  if (!/^\s*[=(]/.test(ex.formula))
    return { ok: false, kind: ex.kind, formula: ex.formula, note: "decoded to a non-formula (e.g. a JSON wrapper) — not a runnable plastron formula" };
  const r = await runFormula(ex.formula);
  return { ok: r.ok, kind: ex.kind, formula: ex.formula, note: r.note };
};
