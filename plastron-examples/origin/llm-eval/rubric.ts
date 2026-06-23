// rubric — the scoring criteria for a model's answer to a (task, mode) cell.
// Two objective signals (computed for free in the runner) + two judged signals
// (a text LLM scores them 1–5 from the task + the extracted formula). A separate
// vision pass (render.ts/judge.ts) can later fill `render`; it's left null here.
//
//   valid     0/1  objective  did the formula parse + evaluate (validate.ts)
//   mode_ok   0/1  objective  is the output in the REQUESTED form (formula/#raw=/#f=),
//                             and for a link does it decode to a valid formula
//   task_fit  1–5  judged     does the formula actually do what the task asked
//   idiomatic 1–5  judged     correct plastron idioms; PENALIZE anti-patterns:
//                             • a raw array (MAP/SCAN/BYROW/FILTER) dumped into a SHEET CELL
//                               (shows a JSON blob) — NOTE: a MAP/FILTER array passed to a
//                               dom() CONTAINER is CORRECT (dom flattens) — do NOT dock that
//                             • backticks / a 3rd quote level
//                             • a genesis (cels()/segment()) nested inside dom()
//                             • a bare scalar formula over empty cells (shows 0)
//                             • hand-rolled reactivity instead of cel refs
//   render    1–5  (optional, vision pass) does it LOOK right when drawn
export const RUBRIC_COLUMNS = ["valid", "mode_ok", "task_fit", "idiomatic", "render"] as const;
export type RubricColumn = typeof RUBRIC_COLUMNS[number];

export interface JudgeScore { task_fit: number | null; idiomatic: number | null; notes: string }

const JUDGE_SYSTEM =
  "You are a strict reviewer of plastron spreadsheet formulas. Apply these idioms EXACTLY:\n" +
  "• NO array spill INTO A SHEET CELL: a raw MAP/SCAN/BYROW/FILTER array left in a grid cell shows a JSON blob — " +
  "for a per-row COLUMN write a formula per cell (INDEX(SCAN(...),n) or SUM over a growing range).\n" +
  "• RENDERING A LIST IS THE OPPOSITE AND CORRECT: passing a MAP/FILTER array of vnodes to a dom() CONTAINER is " +
  "idiomatic — dom() FLATTENS array children. =dom('div', MAP(r, LAMBDA(x, dom('div', x)))) is GOOD. " +
  "FILTER(range, LAMBDA(x, pred)) to render a subset is GOOD. NEVER penalize MAP/FILTER inside dom() — that is the intended way data becomes UI.\n" +
  "• APP SHAPE: =segment(cels(...), winapp(id, title, '=<body formula>')) — a data sheet + a window over it — is the idiomatic shareable app; reward it.\n" +
  "• DRAG-TO-REASSIGN is idiomatic: a draggable item names a cel via on('dragstart','drag.grab', key); a drop zone uses on('dragover','drag.over') + on('drop','drag.drop', value); the drop writes the cel and the view re-renders. This is CORRECT.\n" +
  "• Only two string-quote levels exist (\" and '); backticks are a parse error.\n" +
  "• A genesis (cels()/segment()) is top-level, never nested inside dom().\n" +
  "Score two criteria 1–5 (5=excellent): task_fit (does it do what was asked) and idiomatic. " +
  "Dock ONLY for: a raw array sitting in a sheet cell, backticks/3rd quote level, a genesis nested in dom(), a bare scalar over empty cells, or hand-rolled reactivity. " +
  'Reply with ONLY compact JSON: {"task_fit":N,"idiomatic":N,"notes":"<=20 words"}.';

/** Text-judge one answer. Uses the xAI endpoint (grok) by default; returns nulls
 *  if no key is set so the run still produces the objective columns. */
export const judgeFormula = async (args: { task: string; mode: string; formula: string | null }): Promise<JudgeScore> => {
  const key = process.env.XAI_API_KEY;
  if (!key || !args.formula) return { task_fit: null, idiomatic: null, notes: args.formula ? "no judge key" : "no formula" };
  const model = process.env.JUDGE_MODEL || process.env.XAI_MODEL || "grok-4";
  const user = `TASK (mode=${args.mode}): ${args.task}\n\nFORMULA:\n${args.formula}`;
  try {
    const r = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: user }], temperature: 0 }),
    });
    const j = await r.json();
    const text = String(j?.choices?.[0]?.message?.content ?? "");
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return { task_fit: null, idiomatic: null, notes: "judge: unparseable" };
    const o = JSON.parse(m[0]);
    const clamp = (n: unknown) => { const x = Number(n); return Number.isFinite(x) ? Math.max(1, Math.min(5, Math.round(x))) : null; };
    return { task_fit: clamp(o.task_fit), idiomatic: clamp(o.idiomatic), notes: String(o.notes ?? "").slice(0, 120) };
  } catch (e) {
    return { task_fit: null, idiomatic: null, notes: "judge error: " + String((e as { message?: unknown })?.message ?? e).slice(0, 60) };
  }
};
