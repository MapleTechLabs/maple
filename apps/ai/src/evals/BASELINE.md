# Eval baselines

Reference points for judging changes to the tools, prompts and models. Append a section per
baseline; never overwrite history. Runs before 2026-10-08 used the old single-run harness and are
not comparable with anything after.

## How to regenerate

```bash
set -a && . ../../.env.local && set +a          # from apps/ai
EVAL_MODEL=<model> EVAL_K=3 bun run eval:tools
bun run eval:compare .evals/runs/<A> .evals/runs/<B>
bun run measure-tokens                          # catalog cost, free
```

Pin `EVAL_MODEL`. Unset, it tracks the production triage model, which moves.

---

## Config suite: 2026-11-21, before and after the configuration writes

33 configuration tasks (`src/evals/config/`), k=5, `deepseek/deepseek-v4.1-flash-1017:nitro` (the
production triage model that day). "Before" is the 115-tool catalog at `d4b83412db` with only the
suite added; "after" adds `manage_ingest_source`, `manage_alert_destination`, `delete_dashboard`,
`manage_maintenance_window action=update` and the "Used by" column of `list_alert_destinations`.

| Group         | Tasks | Before         | After           | After, regraded |
| ------------- | ----- | -------------- | --------------- | --------------- |
| control       | 16    | 97.5% (78/80)  | 97.5% (78/80)   | 92.5% (74/80)   |
| gap           | 13    | 0.0% (0/65)    | 100.0% (65/65)  | 100.0% (65/65)  |
| negative      | 4     | 100.0% (20/20) | 100.0% (20/20)  | 100.0% (20/20)  |
| all           | 33    | 59.4% (98/165) | 98.8% (163/165) | 96.4% (159/165) |
| calls / trial |       | 3.38           | 2.41            | 2.41            |
| input tokens  |       | 172k           | 149k            | 149k            |

"Regraded" is the same after run under two targets tightened in review, read from its saved trials.
`drop-noise` now needs the proposed rule, not a preview: 0/5, where 3/5 had passed on a preview
alone. `weekly-window` now needs Sunday 02:00 for 120 minutes: 4/5, one trial proposed 240. The
before run's trials were not kept, so it is not regraded; neither task touches a tool this change
added. A rerun of the two under the new targets scored `weekly-window` 5/5 and `drop-noise` 0/5.

`drop-noise` is the open miss: the world holds no spans, so `preview_ingest_rule` samples nothing
and the agent spends the call budget looking for `/ready` instead of proposing the rule it was
asked for. Without the tools the agent's fallbacks were the finding: it filed
`send_maple_feedback` feature requests for the source and dashboard changes, and to change a
maintenance window it created a second window under the same name.

Catalog cost (`measure-tokens`): 50,678 to 52,374 tokens, 115 to 118 public tools. The tools suite
on the same two catalogs, k=3: 96.4% before, 93.5% after (paired −3.0 pts, 95% CI −6.8 to +0.8, not
significant); the four tasks that moved, rerun at k=10, score 27/40 before and 29/40 after.

Regression check on the final branch (`de50c8ca7b`) against main (`4dd3eedeba`), k=5. Tools suite,
56 tasks: 95.4% (267/280) on main, 94.6% (265/280) on the branch (paired −0.7 pts, 95% CI −2.4 to
+1.0, not significant). Six tasks moved, each by one trial, and no trial called a tool this change
adds. `failed-span-in-trace` fails the regression gate on both (1/5 and 0/5). Config suite on the
branch: 95.8% (158/165), control 73/80, gap 65/65, negative 20/20; besides `drop-noise` (0/5),
`availability-slo` and `service-dashboard` each lost one trial to the call budget.

Two wordings were measured, not guessed. "Only for a destination the user named" on the delete
actions took `ambiguous-destination-delete` from 4/5 to 10/10. Listing what routes to each
destination took `delete-destination` from 1/5 to 5/5: before it, the agent spent the 8-call budget
proving the destination unused.

---

## Data source world (tool playground): 2026-11-08, Haiku

Agents playing the Maple agent through `scripts/tool-playground.sh` against the 18-source data
source world (`src/evals/playground/README.md`, "The data source world"), 10 scenarios, one run
each per round, scored from the reports and the `PLAYGROUND_LOG` files.

| Round                           | Correct | Partial | Wrong  | Right source | First query form right | Logged calls (wasted)      |
| ------------------------------- | ------- | ------- | ------ | ------------ | ---------------------- | -------------------------- |
| 1 (before fixes)                | 8       | 1 (D8)  | 1 (D4) | 9 of 10      | 5 of 6                 | 40 (+6)                    |
| Reruns after fixes (D4, D8, D9) | 9       | 1 (D8)  | 0      | 10 of 10     | 7 of 7                 | D4 6 (+3), D8 5 (+1), D9 3 |

Fixed before round 1 (found by the world test): search ranking for `invoices`. Fixed between
rounds: the default window and unapplied windows in `query_data_source`, epoch-seconds guidance,
the empty-search message, and pointers from Maple's user tools to data sources. Open: D8
(per-device analysis), D4 still starts in Maple telemetry, widgets and alerts on data sources (phases 2
and 3) are not measurable yet.

---

## Tools suite: 2026-10-08, six models, two runs pooled

Same 50 tasks. Two k=3 runs pooled to 6 trials per task (Sonnet: one run, 3 trials), all graded
with the current targets. The second run reproduced the first: every model's failures recur on
the same tasks.

| Model                                | pass@1 (95% CI)     | pass^6 | Invalid calls | Errored | s/trial | Input tokens |
| ------------------------------------ | ------------------- | ------ | ------------- | ------- | ------- | ------------ |
| `z-ai/glm-5.3-flash:nitro` (prod)    | 99.0% (97.6 to 100) | 96.0%  | 1.8%          | 0       | 10.5    | 115k         |
| `anthropic/claude-haiku-5.5`         | 100.0%              | 100.0% | 1.0%          | 0       | 6.9     | 172k         |
| `anthropic/claude-sonnet-5.5`        | 99.3% (98.0 to 100) | n/a    | 2.2%          | 1       | 8.1     | 153k         |
| `deepseek/deepseek-v4.1-flash:nitro` | 99.0% (97.6 to 100) | 96.0%  | 0.6%          | 0       | 2.9     | 109k         |
| `openai/gpt-6.1-sol`                 | 98.0% (94.1 to 100) | 98.0%  | 23.0%         | 1       | 17.6    | 111k         |
| `openai/gpt-6-luna`                  | 96.0% (90.5 to 100) | 96.0%  | 30.5%         | 4       | 14.3    | 106k         |

Paired against GLM, no model differs significantly (Haiku +1.0, 95% CI −0.4 to +2.4; Luna −3.0,
−7.7 to +1.7). The deterministic failures are the OpenAI models': both fail `all-error-types` in
6 of 6 trials and Luna fails `requests-per-minute` 6 of 6, from empty-string arguments followed by
invented dates. Four Luna trials hit the engine's 5-consecutive-tool-failure limit, which ends the
turn in production. Sonnet's one miss was a protocol error (the model signalled tool calls and sent
none).

---

## Tools suite: 2026-10-08, five models

Same 50 tasks, k=3. Regraded after two target fixes (`record-fix` now accepts
`link_pull_request`; outcome tasks get 10 calls instead of 6), so these supersede the table below.

| Model                                | pass@1 | pass^3 | s/trial | Input tokens/trial |
| ------------------------------------ | ------ | ------ | ------- | ------------------ |
| `anthropic/claude-haiku-5.5`         | 100.0% | 100%   | 7.1     | 170k               |
| `z-ai/glm-5.3-flash:nitro`           | 99.3%  | 98%    | 11.3    | 114k               |
| `deepseek/deepseek-v4.1-flash:nitro` | 99.3%  | 98%    | 3.1     | 108k               |
| `openai/gpt-6.1-sol`                 | 98.0%  | 98%    | 17.5    | 111k               |
| `openai/gpt-6-luna`                  | 96.0%  | 96%    | 14.2    | 106k               |

No pair differs significantly. The OpenAI models fill every optional parameter with an empty
string (84% of Luna's calls), which fails validation (` ` is not a timestamp``); both then
retried `all-error-types` with invented dates and never recovered. Luna also invented a March
window for `requests-per-minute`. DeepSeek's one miss was cut off by the old 6-call cap.

---

## Tools suite: 2026-10-08, first run on the rebuilt harness

50 tasks (40 regression, 10 capability), k=3, production chat turn, eval world.

| Model                        | pass@1 (95% CI)     | pass^3 | Calls/trial | Input tokens/trial | s/trial |
| ---------------------------- | ------------------- | ------ | ----------- | ------------------ | ------- |
| `anthropic/claude-haiku-5.5` | 100.0% (100 to 100) | 100%   | 3.8         | 170k               | 7.1     |
| `z-ai/glm-5.3-flash:nitro`   | 98.7% (96.8 to 100) | 96.0%  | 3.9         | 114k               | 11.3    |

Paired difference: +1.3 pts for Haiku (95% CI −0.5 to +3.2), not significant. GLM's misses were
`requests-per-minute` (one trial queried a hallucinated July window) and `span-attribute-keys`
(a grader bug since fixed: span is the default scope).

**This suite is saturated.** Single-turn tool choice no longer separates current models. It is a
regression guard for tool and prompt changes. Telling models apart needs multi-step,
outcome-graded tasks: the investigation suite is next.

How it got here, for the next person: the first run scored GLM 96.7% and Haiku 98.0%, and most of
the misses were the harness. The warehouse was empty, so agents that check before acting spent
their calls looking for data. The broad trace-log fixture answered unrelated log queries with the
wrong row shape. `run_sql` had no signing key. The issue the tasks named did not exist. And two
targets rejected valid answers. Tool errors per call fell from 27% to 2 to 4% once the world existed.

---

## Baseline — 2026-08-17, commit `3c07fcfe98`

Model: `moonshotai/kimi-k2.7-code` · scope: `src/mcp/__evals__` only.

### Eval scores

| Suite                    | Cases  | Mean score | Threshold |
| ------------------------ | ------ | ---------- | --------- |
| `cli-scenarios.eval.ts`  | 19     | 1.00       | 0.7       |
| `observability.eval.ts`  | 10     | 1.00       | 0.7       |
| `disambiguation.eval.ts` | 5      | 1.00       | 0.7       |
| `execution.eval.ts`      | 1      | 1.00       | 0.7       |
| **Total**                | **35** | **1.00**   | —         |

**Not comparable across 2026-10-07.** Evals moved off the Vercel AI SDK onto the agents' Effect AI
stack: the toolkit is now the `mcp` surface as `buildMapleToolkit` builds it, temperature is the
provider default rather than 0, and the diagnosis report schema is now sent as `json_schema`
structured output. Re-baseline before comparing against the rows below.

**These suites are at ceiling.** Every case scores 1.00, so a before/after comparison against
them can only demonstrate _absence of regression_ — it cannot demonstrate improvement. Any
change claiming to make tool selection better must ship a case that fails before it and passes
after. Treat the table above as a guardrail, not a scoreboard.

Unrelated: `src/chat/__evals__/diagnosis.eval.ts` (investigation diagnosis, a separate
suite) had 7 failures on this commit, including a real crash in
`diagnosis-scorers.ts:108` — `entry.trim is not a function` when a ruled-out entry is not a
string. Not caused by and not blocking MCP work.

**The crash is fixed** — the scorers now treat a present-but-wrong-type field as a zero rather
than trusting the declared type, and the malformed shapes are unit-tested in
`diagnosis-scorers.test.ts`. The suite still fails, and the remaining cause is plumbing, not
reasoning: OpenRouter routes `moonshotai/kimi-k2.7-code` to a provider that returns
`content: null` with the whole answer in `reasoning`, so `generateObject` raises
`AI_NoObjectGeneratedError`; and `createEvalModel()` leaves `supportsStructuredOutputs` at its
`false` default, so the report schema is dropped before the request goes out and the model
free-forms a `{tool_name, tool_input}` envelope that `jsonSchema()` passes through unvalidated.
Fixing that is a change to the shared `mcp/__evals__/model.ts` and would need this table
re-baselined.

### Catalog cost

**57 tools · 17,692 tokens** (`gpt-tokenizer`, name + description + input JSON schema).

Ten most expensive:

| Tool                   | Total | Description | Schema |
| ---------------------- | ----: | ----------: | -----: |
| `create_alert_rule`    |  1314 |          63 |   1248 |
| `create_dashboard`     |  1219 |         820 |    397 |
| `add_dashboard_widget` |  1166 |         287 |    876 |
| `query_data`           |  1021 |          57 |    962 |
| `search_sessions`      |   934 |         144 |    788 |
| `update_alert_rule`    |   924 |          46 |    875 |
| `search_traces`        |   558 |          57 |    498 |
| `inspect_chart_data`   |   440 |         294 |    143 |
| `run_sql`              |   410 |         102 |    306 |
| `mine_log_patterns`    |   402 |          97 |    302 |

The top six are 6,578 tokens — **37% of the catalog**. Note the split: for five of the six the
cost is the **input schema**, not the prose. Only `create_dashboard` is description-dominant.
A diet aimed at descriptions would recover roughly 1k tokens total; the schemas are where the
budget actually goes.

---

## After the MCP audit changes — 2026-08-17

Same model, same scope.

|                       | Before |  After |                   Δ |
| --------------------- | -----: | -----: | ------------------: |
| Tools                 |     57 |     56 |                  −1 |
| Catalog tokens        | 17,692 | 15,225 | **−2,467 (−13.9%)** |
| Eval cases            |     35 |     35 |                   — |
| Reproducible failures |      0 |      0 |                   — |

### Where the 2,467 tokens came from

Almost all of it is one change, and it was a **correctness fix** that happened to pay:
`toInputSchema` now collapses `anyOf: [T, {type: "null"}]` to `T`
(`tools/registry.ts`). `Schema.optional(X)` types as `X | undefined` and rejects an explicit
null, but rendered a JSON `null` branch — so the published schema told every client that
`{"service": null}` was valid on every optional parameter of all 57 tools, while the decoder
answered `Expected string | undefined`. Removing the lie removed 2,268 tokens of union wrapper.

Prose trimming on the five fattest tools, by contrast, recovered **140 tokens**. Descriptions
are 58% of the catalog but they are mostly load-bearing; do not expect a diet to come from there.

### Verdict on tool selection

Two full runs, each with exactly **one** failing case — but a _different_ case each time
("deep health investigation" in the first, "list all the error types" in the second). The first
was then re-run twice in isolation and scored **1.00 both times**.

Both failures share a signature: the model answers with narration ("I'll get the current time
first…") instead of emitting a tool call on the first step. That is model nondeterminism —
`temperature: 0` does not make these runs reproducible — not a regression from the catalog change.

**Read a single failing case here as noise until it fails twice in a row.** A real selection
regression shows up as the same case failing on re-run.

### Deterministic coverage added alongside

Because the LLM suites are at ceiling and individually flaky, the three production bugs this
work fixed are pinned by free, always-on tests instead:

- `__evals__/regression.test.ts` — "agent-recoverable error messages": `error_detail` given a
  truncated issue id / a full UUID / an `alert:` incident id, and `query_data` given a token
  valid only for the other `kind`. These run the real handlers through the real dispatcher.
- `lib/query-spec-tokens.test.ts` — pins the metric/group_by table against the domain schemas
  by decoding, so it cannot drift.
- `tools/registry.test.ts` — pins the invariant the nullable collapse depends on (no MCP
  parameter genuinely accepts null).
