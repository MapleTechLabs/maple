# PR review experiments

Compare the production parent prompt with `compact.md` on real changes with known bugs. The
production prompt stays unchanged until evidence supports promotion. Results so far:
[audit and smoke test](../../../../docs/pr-review-agent-evaluation.md),
[model comparison](../../../../docs/pr-review-model-comparison-2026-09-25.md).

From the repository root:

```sh
# Find candidate cases: blames each fix: commit back to the PR that wrote the lines.
bun run --cwd apps/ai review:eval mine --ref origin/main --since 2026-08-01 --limit 40

# Validate refs/config without calling a provider.
bun run --cwd apps/ai review:eval run --dry-run

# A development smoke test: suppress two pre-existing bugs in a historical PR.
bun run --cwd apps/ai review:eval run \
  --cases pr1057-like-wildcards-preexisting,pr1057-lowercase-before-ascii-filter-preexisting \
  --prompts committed,scripts/pr-review-eval/compact.md

# Iterate on development cases only; run holdouts once, on a frozen candidate.
bun run --cwd apps/ai review:eval run --split development \
  --prompts committed,scripts/pr-review-eval/compact.md

# Full factorial comparison; use provider IDs available to your account.
bun run --cwd apps/ai review:eval run \
  --models deepseek/deepseek-v4.1-flash:nitro,openai/gpt-6-luna \
  --prompts committed,scripts/pr-review-eval/compact.md --repeats 3

# Edit the generated grades.json, then compute semantic scores.
bun run --cwd apps/ai review:eval score --dir /absolute/path/to/.pr-review-evals/run
```

`mine` prints candidates only; a person decides what enters `corpus.json`. Paths passed as
flags are relative to `apps/ai` when using `--cwd apps/ai`. Runs use `.env.local`, spend
provider credits, and never post to GitHub.

There is one replay per unique range, model, prompt and repetition; bug labels on the same
range share that review. Repeat order rotates variants. Outputs are checkpointed after every
replay into `apps/ai/scripts/.pr-review-evals/<timestamp>/`, which is gitignored. Failures
stay failures, not clean reviews, and an interrupted replay has no quality score.

## What is held constant

The evaluator uses the same tools, budgets, normalization, worker prompt and close-out path as
the local runner. To keep the answer out of reach:

- Each case pins full base/head SHAs and reads local git objects.
- Today's PR discussion and checks are not fetched.
- Source reads can reach only ancestors of the pinned head.
- Execution is disabled, including arbitrary git commands, so future fixes and the local corpus
  are unreachable.

This is a source-only eval, not a production sandbox fidelity test. Telemetry is unavailable
locally, and provider knowledge of public code cannot be excluded.

Artifacts include the selected corpus, exact parent/worker prompts and their hashes, source
revision and dirty-file status, resolved model, transcripts, findings, token usage, latency and
close-out status. When running from a dirty checkout, save the code diff next to the results.

Worker prompt and close-out behavior are fixed, so this measures the parent prompt, not worker
prompt optimization. Tool-call counts in the local report exclude child events and are not the
total fan-out cost. Usage counters are recorded; dollar costs are not estimated from stale
prices.

## Grading meaning, not lines

Read each report against the case's `bug`, the historical code and the later fix. For every
case and run, give every finding index a verdict in `grades.json`:

- `target`: identifies this case's causal defect, trigger and consequence. A Unicode-folding
  finding does **not** detect a wildcard bug, even on the same line.
- `other_valid`: another confirmed, introduced defect. Not a false positive just because our
  labels are incomplete.
- `false_positive`: refuted, pre-existing, unsupported or non-actionable.
- `duplicate`: repeats a defect already reported in the same review.
- `ungraded`: unresolved; blocks scoring until decided.

```json
{
	"runId": "2026-09-25T13-48-05-122Z-r0-g0-v1",
	"caseId": "pr1057-like-wildcards-preexisting",
	"status": "complete",
	"findings": [
		{
			"index": 0,
			"verdict": "false_positive",
			"rationale": "Exists at base 48ddd675 logs.ts:79-89; not introduced."
		}
	]
}
```

Write the evidence in `rationale`, and set `status: "complete"` only after every finding is
assessed. A review with zero findings still needs `complete`. `score` rejects incomplete
coverage, duplicate or out-of-range indexes, blank rationales and pending grades.

The `nearby` field in `results.json` (location overlap) is for navigation only. No LLM judge or
keyword match stands in for semantic grading. Where practical, grade without looking at the
model/prompt identity, and have disputed findings adjudicated independently.

What a verdict means depends on the case's `expected` value:

| Case kind                | `expected` | Passes when              | Measures                                   |
| ------------------------ | ---------- | ------------------------ | ------------------------------------------ |
| Positive                 | `present`  | some finding is `target` | target recall                              |
| Pre-existing-bug control | `absent`   | no finding is `target`   | not blaming the PR for an unchanged defect |
| Post-fix control         | `absent`   | no finding is `target`   | not re-alleging the repaired defect        |

On an `absent` case a `target` finding counts as a false positive. A passing post-fix control
does not certify the whole PR as bug-free. Per-case precision includes other valid bugs, and
duplicates lower it. Do not sum findings, cost or precision across labels that share a replay.
Summary recall and control rates use only completed grades, so check pending and failed counts
before comparing variants.

## Corpus and promotion

- **Development:** PR #261 (introducing, two positives) and PR #1057 (two pre-existing-bug
  controls at the original head, two post-fix controls). The production prompt already names
  their exact wildcard/Unicode counterexamples, so they cannot show generalization. Both
  defects already existed at #1057's base, which is why its original head is a control, not a
  positive.
- **Holdout:** PR #972 (Postgres URL parsing) and #685 (empty S3 PUT). Keep them out of prompt
  iteration.
- **Disabled:** three mined cases, pending attribution review. Mining finds candidates, not
  ground truth: blame may point at refactors or unrelated later edits.

Before claiming a winner, add more reviewed PRs: genuinely clean changes, other languages,
security and lifetime bugs, and large fan-out changes. Keep every snapshot of one PR in the
same split. For a new positive, verify the defect exists at the pinned head and was introduced
by that diff, and put the later fix and explicit acceptance criteria in `bug`. For an absent
control, name the specific repaired bug rather than labelling the PR clean. Never copy holdout
counterexamples into prompts.

Choose on recall and false-positive burden together, with completion rate, latency and tokens
as constraints. Repeat runs before promoting: eight labels from four PRs is a smoke suite, not
a statistically persuasive benchmark. A shorter prompt that uses fewer tokens is not a reason
to promote on its own.
