# Evals

Model-driven evals for Maple's agents. They call a real model through OpenRouter, so every run
costs money and gives a slightly different answer. That is why they run apart from `bun run test`
and why every number comes with an error bar.

Design references: Anthropic's
[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
and [statistical approach to model evals](https://www.anthropic.com/research/statistical-approach-to-model-evals),
tau-bench (pass^k, outcome grading), BFCL (acceptable-value lists, irrelevance tasks), MCP-Bench
(fuzzy phrasing) and UK AISI's Inspect (task, solver, scorer, epochs, logs).

## Principles

- **Production path.** A trial is one `runChatTurn`: the session's agent and system prompt, the
  `chat` surface's tools and permission ruleset, and the registry's own decoding. Only the
  warehouse is fake. An eval that skips the system prompt is measuring a different product.
- **Grade meaning, not spelling.** Calls are read through `readToolCall`, so a retired alias or a
  lowercase enum means what the dispatcher makes of it. Targets list every acceptable answer, and
  any call in the trajectory can satisfy one, not only the first.
- **Outcomes where possible.** `answer-mentions` checks that the answer came from the data the
  tool returned, not only that the right tool ran.
- **Solvable tasks.** Tasks run in a small world (`world.ts`) where the services and attributes
  they name exist. In an empty warehouse the agent spends its calls looking for data, and the
  task measures the fixture, not the model. `world.test.ts` fails if a query change empties it.
- **Negative cases.** Tasks where no tool fits, a read must not mutate, or a destructive request
  is ambiguous. A suite with only positive cases rewards a model that calls everything.
- **Repeats and error bars.** Each task runs `k` times. Reports give pass@1 with a 95% interval
  clustered by task, pass^k (all trials pass: consistency) and pass@k (any passes).
- **Paired comparison.** Compare models with `eval:compare`, which takes per-task differences.
  Two pass@1 numbers side by side hide whether the gap is noise.
- **Read transcripts.** Every trial is in `trials.jsonl` with the calls as made, as read, and what
  the model was shown. A failing score is a question about the trial, not yet an answer.

## Running

```sh
set -a && . ../../.env.local && set +a        # OPENROUTER_API_KEY; suites skip without it
bun run eval:tools                             # production triage model, k=1
EVAL_MODEL=anthropic/claude-haiku-5.5 EVAL_K=3 bun run eval:tools
EVAL_TASKS=tag:negative,trace-tree bun run eval:tools
EVAL_TIER=regression bun run eval:tools        # what CI runs
bun run eval:compare .evals/runs/<A> .evals/runs/<B>
```

| Variable           | Default                 | Meaning                                      |
| ------------------ | ----------------------- | -------------------------------------------- |
| `EVAL_MODEL`       | production triage model | OpenRouter model id                          |
| `EVAL_K`           | 1                       | Trials per task                              |
| `EVAL_CONCURRENCY` | 4                       | Trials in flight                             |
| `EVAL_TIER`        | both                    | `regression` or `capability`                 |
| `EVAL_TASKS`       | all                     | Comma-separated ids or `tag:<tag>` selectors |

A run writes `apps/ai/.evals/runs/<stamp>-<suite>-<model>/` (gitignored): `manifest.json`
(revision, dirty files), `trials.jsonl`, `summary.json` and `summary.md`. Start reading at the
failing tasks in `summary.md`.

## Tiers

- **regression**: saturated tasks. Each must pass a majority of its trials, or the eval fails.
- **capability**: still hard, or new. Reported, never gating. A task moves to regression once it
  passes every trial on every model we care about across a couple of runs.

## Adding a task

1. Start from a real failure: a production transcript, a support thread, a bad answer.
2. Write the input as a user would, without naming tools or parameters.
3. List every acceptable answer in the target. If a reasonable expert would accept another call,
   add it. If you cannot say what passes, the task is not ready.
4. Run it a few times and read the transcripts before trusting the grade.
5. `src/evals/tools/tasks.test.ts` checks targets against the live tool schemas in the unit
   suite, so a renamed parameter fails there instead of zeroing correct answers here.

## Layout

| File           | Role                                                        |
| -------------- | ----------------------------------------------------------- |
| `targets.ts`   | Checks and the deterministic grader                         |
| `chat-turn.ts` | The solver: one production chat turn, with its transcript   |
| `runner.ts`    | Trials, concurrency, artifacts, summary                     |
| `stats.ts`     | pass@1 with clustered SE, pass@k, pass^k, paired comparison |
| `model.ts`     | The evaluated model, unattributed on OpenRouter             |
| `world.ts`     | The services, attributes and errors the tasks assume exist  |
| `tools/`       | Tool-use tasks, their schema contract test, and the suite   |

The fake warehouse and eval runtime live in `src/mcp/__evals__/` beside the deterministic
renderer tests that share them.
