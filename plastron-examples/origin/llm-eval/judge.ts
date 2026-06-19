// judge — the "how good is it?" layer. Validity (check.ts) only asks did it parse
// and evaluate. This asks the harder questions a human would: does the rendered
// result actually satisfy the task, is the FORMULA readable, is the result usable?
// Uses a vision model (Grok-4) that SEES the screenshot render.ts captured, plus
// the formula source and the DOM facts. Returns structured 1–5 scores + a reason.
import { readFileSync } from "node:fs";

const env = (k: string, d = "") => process.env[k]?.trim() || d;

export interface Score {
  satisfaction: number; // 1–5: does the render do what the task asked?
  layout: number;       // 1–5: is the PAGE well laid out (window size, fits viewport)?
  usability: number;    // 1–5: is the rendered thing pleasant/usable?
  notes: string;        // one or two sentences of rationale
}

const RUBRIC = `You are grading the plastron.ca PAGE an AI built with a single "plastron"
spreadsheet formula, for a stated task. You are given the TASK, the FORMULA source,
machine-read facts about what rendered, and a SCREENSHOT of the live page.

Judge the PAGE the user sees — not the formula text. Score three axes, integer 1–5:
- satisfaction: does the SCREENSHOT actually fulfil the task? A formula can parse yet
  render nothing useful (blank, "[object Object]", a "no data" chart). Judge the
  pixels, not the intent. 5 = clearly does the task; 1 = broken/empty/wrong.
- layout: is the PAGE well composed? Reward use of the available viewport — windows
  sized and placed sensibly, content not crammed into one tiny grid cell, no overflow
  or clipping, readable proportions on the screen. Penalise a UI squeezed into a
  single cell, off-screen content, or one giant unsized blob.
- usability: is the result pleasant and usable? Reward sizing, labels, styling,
  spacing, affordances; penalise tiny/cramped/unstyled/unlabelled output.

Reply with ONLY a JSON object: {"satisfaction":N,"layout":N,"usability":N,"notes":"…"}`;

export async function judge(input: { task: string; formula: string; pngPath: string; facts?: string }): Promise<Score | { error: string }> {
  const key = env("XAI_API_KEY");
  const model = env("XAI_JUDGE_MODEL", "grok-4");
  if (!key) return { error: "no XAI_API_KEY (judge needs a vision model)" };
  let dataUrl: string;
  try {
    dataUrl = "data:image/png;base64," + readFileSync(input.pngPath).toString("base64");
  } catch (e) { return { error: `cannot read ${input.pngPath}: ${String(e)}` }; }

  const userText =
    `TASK: ${input.task}\n\nFORMULA:\n${input.formula}\n\n` +
    (input.facts ? `RENDERED FACTS: ${input.facts}\n\n` : "") +
    `Grade the screenshot below.`;

  try {
    const resp = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: RUBRIC },
          { role: "user", content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: dataUrl } },
          ] },
        ],
      }),
    });
    if (!resp.ok) return { error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}` };
    const j = await resp.json() as { choices?: { message?: { content?: string } }[] };
    const raw = j.choices?.[0]?.message?.content ?? "";
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { error: `no JSON in judge reply: ${raw.slice(0, 120)}` };
    const p = JSON.parse(m[0]) as Score;
    return { satisfaction: +p.satisfaction, layout: +p.layout, usability: +p.usability, notes: String(p.notes ?? "") };
  } catch (e) { return { error: String((e as { message?: unknown })?.message ?? e) }; }
}
