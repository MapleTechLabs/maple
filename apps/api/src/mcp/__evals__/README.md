# MCP evals

Quality net for the Maple MCP server (`apps/api/src/mcp`). Two layers:

| Layer                              | Files                                   | Model?                              | Cost       | When it runs                                 |
| ---------------------------------- | --------------------------------------- | ----------------------------------- | ---------- | -------------------------------------------- |
| **Deterministic regression tests** | `*.test.ts` (e.g. `regression.test.ts`) | No                                  | Free       | Every `test` CI run + locally via `bun test` |
| **LLM evals**                      | `*.eval.ts`                             | Yes — real model via **OpenRouter** | 💲 per run | **Opt-in only** — see below                  |

The LLM evals hand a real model every MCP tool and score whether it picks the
right tool with the right arguments (`vitest-evals` `ToolCallScorer`), plus a
full-execution case that runs `inspect_trace` end-to-end against a fake
warehouse. They are **nondeterministic and cost money**, so CI does **not** run
them on every push.

## Running the LLM evals in CI — add the `run-evals` badge 🏷️

The [`MCP Evals`](../../../../../.github/workflows/eval.yml) workflow is gated on
a PR **label** (the "badge"):

1. Add the **`run-evals`** label to your PR.
2. The evals run on that event and on every subsequent push **while the label
   stays on**.
3. Remove the label to stop spending budget — later pushes skip the job (it
   shows as _skipped_, not failed).

You can also run them on demand: **Actions ▸ MCP Evals ▸ Run workflow**.

> The deterministic `*.test.ts` regression tests always run for free in the
> normal `test` job — only the model-driven `*.eval.ts` files are gated.

## Running locally

```bash
# Needs an OpenRouter key. Without it the suite self-skips (green).
OPENROUTER_API_KEY=sk-or-... bun run --filter @maple/api eval

# Deterministic regression tests only (no key, no cost):
bun run --filter @maple/api test

# See per-case scores:
OPENROUTER_API_KEY=sk-or-... \
  bunx --bun vitest run --config apps/api/vitest.eval.config.ts \
  --reporter=vitest-evals/reporter
```

Model defaults to the production `moonshotai/kimi-k2.7-code`. Override per-run with
`MCP_EVAL_MODEL=...` (CI reads it from the `MCP_EVAL_MODEL` repo variable).

## Files

- `model.ts` — OpenRouter model factory (`MCP_EVAL_MODEL`, `OPENROUTER_API_KEY`).
- `tools.ts` — builds the `ai` ToolSet from the registry: `buildPredictionToolSet`
  (no `execute`) and `buildExecutionToolSet` (runs handlers through a runtime).
- `utils.ts` — `predictToolCalls` task + `describeMapleEval` (skips without a key).
- `scorers.ts` — `OutputContainsScorer` for rendered-output assertions.
- `fixtures.ts` / `fake-warehouse.ts` / `eval-runtime.ts` — canned warehouse data
    - a runtime wired to it (`WarehouseQueryService.__testables`), for full-execution.
- `observability.eval.ts`, `cli-scenarios.eval.ts`, `disambiguation.eval.ts` —
  LLM tool-selection cases (the last two ported from the old `apps/cli/EVALS.md`).
- `execution.eval.ts` — LLM full-execution case (large-trace `inspect_trace`).
- `regression.test.ts` — **deterministic** renderer guards (no model).
