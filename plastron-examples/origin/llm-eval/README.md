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

## Files

- `providers.ts` — calls each model (Anthropic SDK; xAI/OpenAI via `/chat/completions`)
- `validate.ts` — extracts a formula/link and runs it through the real parser
- `tasks.json` — the test tasks
- `run.ts` — orchestrates + reports
