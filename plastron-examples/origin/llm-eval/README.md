# llm-eval — does the plastron system prompt actually work?

Feeds the canonical guide (`../llms.md`) as a **system prompt** to **Claude, Grok,
and ChatGPT**, asks each to write a plastron formula for a task (keyboard, solar
system, spreadsheet+chart), then **validates every reply against the real kernel**
— boots origin headless, commits the formula as 元, and checks it parsed and
evaluated without error. The point: measure whether the prompt is self-sufficient,
and iterate on `llms.md` until all three produce viable formulas/links.

## Setup

```sh
cd plastron-examples/origin/llm-eval
cp .env.example .env        # then fill in the keys you have (.env is gitignored)
bun install                  # installs @anthropic-ai/sdk
# make sure the kernel is built (the validator imports from plastron/dist):
( cd ../../../plastron && bun run build )
```

`.env` keys (skip any you don't have — that provider is just skipped):

```
ANTHROPIC_API_KEY=   XAI_API_KEY=   OPENAI_API_KEY=
# optional model overrides:
ANTHROPIC_MODEL=claude-opus-4-8   XAI_MODEL=grok-4   OPENAI_MODEL=gpt-5
```

## Run

```sh
bun run.ts                 # all providers × all tasks
bun run.ts keyboard        # one task by id (keyboard | solar-system | spreadsheet-chart)
```

Prints a `task | provider | VIABLE/FAIL` matrix and writes full replies to
`last-run.json`. A FAIL tells you *why* (no formula found, bad `#f=` encoding,
parse/eval error) — feed that back into `../llms.md` and re-run.

## Raw formula check (no LLM)

Just "is this formula valid?" — runs the same validator directly:

```sh
bun check.ts '=cels(3,3)'                          # VALID   [formula]  parsed + evaluated
bun check.ts '=cels(3,3'                           # INVALID [formula]  error cel: infix: expected ")"
bun check.ts 'https://plastron.ca/#raw=%3Dcels(3%2C3)'   # decodes + validates a link
echo '(dom "h1" "hi")' | bun check.ts             # also reads stdin
```

Exit code is `0` for valid, `1` for invalid — pipe-friendly for scripts/CI.

## The matrix scoreboard (`matrix.ts`)

The richer harness: crosses **base task × output mode × model** and APPENDS to a
persistent `results.csv` (history across runs + guide versions). Each base task is
asked three ways — produce the **formula**, a **`#raw=` link**, and a compressed
**`#f=` link** — and for the link modes the underlying formula is decoded and
recorded in the `formula` column.

```sh
bun matrix.ts                  # all tasks × all modes × all configured models
bun matrix.ts keyboard         # one base task
bun matrix.ts keyboard formula # one base task, one mode
```

Each row records: `ts, guide_version, source, provider, model, task, mode, valid,
mode_ok, task_fit, idiomatic, render, kind, judge_notes, validate_note, formula,
prompt, raw_output`. The exact `llms.md` that produced a row is content-hashed and
archived under `versions/llms-<hash>.md` (`version.ts`), so every result is
traceable. `valid`/`mode_ok` are objective; `task_fit`/`idiomatic` are 1–5 from a
text judge (`rubric.ts`, defaults to grok); `render` is filled by the optional
vision pass (`render.ts` → `score.ts`).

## Local models

- **On your box (3090):** set `LOCAL_MODEL` (+ `LOCAL_BASE_URL`) in `.env` to any
  OpenAI-compatible server (Ollama/LM Studio/llama.cpp/vLLM). It joins the matrix as
  `local-3090`; skipped with a reason if the endpoint is down.
- **plastron's bundled in-browser model** (`webllm-eval.ts`): drives WebLLM
  Qwen2.5-0.5B on WebGPU in real chromium → `local-browser` rows. ⚠️ Currently
  **blocked by the origin CSP** (it omits `'unsafe-eval'`, but `llm/local.ts` loads
  WebLLM via `Function()`; and `esm.run` isn't in the CSP allowlist). Fix the segment
  before this produces scores. This script doubles as the local LLM segment's e2e.

## Discoverability tests

- **Test A — which source suffices** (`test-a.ts`): runs the matrix injecting each
  candidate *as a model would receive it* — `llms.md`, `llms.txt`, the GitHub
  README, and the raw `index.html` truncated at a fetcher cap — labeling each in the
  `source` column. `bun test-a.ts [task] [mode]`.
- **Test B — where do they look** (`test-b.ts`): gives the model a `fetch(url)` tool
  and only "the docs are at plastron.ca", intercepts requests, and logs which channel
  it reaches for (`llms.txt` vs the HTML root vs the README). `bun test-b.ts [task]`.
  Finding so far: grok & gpt fetch the **bare site**, not `/llms.txt` — so the early
  `<head>` guide block is what they actually read.

## Files

- `providers.ts` — calls each model (Anthropic SDK; xAI/OpenAI/local via `/chat/completions`)
- `validate.ts` — extracts a formula/link and runs it through the real parser
- `tasks.ts` — base tasks + the three output modes (matrix axes); `tasks.json` — legacy `run.ts` tasks
- `version.ts` — content-hash + archive `llms.md`; `rubric.ts` — criteria + text judge
- `matrix.ts` — the CSV scoreboard · `test-a.ts` / `test-b.ts` — discoverability · `webllm-eval.ts` — in-browser model
- `run.ts` — the original VIABLE/FAIL matrix (still works)
