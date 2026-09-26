# PR review model comparison (September 25, 2026)

Point-in-time record. Related: [the reviewer design](pr-review-agent-plan.md) · [the audit and
smoke test that preceded this run](pr-review-agent-evaluation.md) · [eval commands and
grading](../apps/ai/scripts/pr-review-eval/README.md).

**Keep DeepSeek V4.1 Flash for the current reviewer configuration. Do not switch to MiMo V2.6
Pro on this evidence.** DeepSeek delivered reviews; MiMo did not. Neither configuration
demonstrated acceptable known-target detection.

| Measure                                    | DeepSeek V4.1 Flash `:nitro`                           | MiMo V2.6 Pro               |
| ------------------------------------------ | ------------------------------------------------------ | --------------------------- |
| Submitted reviews / completed attempts     | 4 / 5                                                  | 0 / 3                       |
| Normal submissions / close-out submissions | 2 / 2                                                  | 0 / 0                       |
| Same first three ranges: submitted         | 2 / 3                                                  | 0 / 3                       |
| Holdout targets (#972, #685)               | #685 missed in a submitted review; #972 attempt failed | Both attempts failed        |
| Development targets (#261)                 | 0 / 2 detected                                         | Not run                     |
| Suppression controls (#1057)               | 3 / 4 passed                                           | No submitted control review |
| Distinct findings                          | 4 valid, 2 false positives, 1 unresolved               | None to grade               |

DeepSeek's submitted reviews took 328–665 seconds; MiMo's failed attempts took 602–1,200
seconds. Those timings depend on the outcome and are not a speed ranking.

## Method

Models: `deepseek/deepseek-v4.1-flash:nitro` (the existing default) and
`xiaomi/mimo-v2.6-pro`. Both use the same committed parent prompt, worker prompt, corpus
snapshot, source-only historical adapter and budget. No production model or prompt was changed
and no GitHub review was posted.

The five ranges, in run order:

1. #972 fix head: holdout, one positive target.
2. #685 fix head: holdout, one positive target.
3. #1057 original head: development, two pre-existing-bug controls.
4. #1057 post-fix head: development, two post-fix controls.
5. #261 introducing head (57 files): development, two positive targets.

The development defects already appear in the production prompt, so success on them would not
show generalization. Live PR comments and future fixes are hidden from the reviewer.

The review budget is ten minutes plus a separate close-out pass. Both models have a configured
one-million-token context window, but the agent caps live prompts at 128,000 tokens. Reasoning
effort uses provider defaults. DeepSeek uses the `nitro` route and MiMo uses default routing,
so latency and reliability compare these configurations, not the models in isolation.

### Stopping

The plan was two passes over all five ranges per model, stopping a model after three
consecutive non-submissions. After MiMo's first two non-submissions the run was curtailed
instead: finish DeepSeek's first pass and MiMo's in-progress third attempt, then defer repeats
until the failures are understood. As a result:

- DeepSeek ran all five ranges once; MiMo ran ranges 1-3.
- MiMo's ranges 4-5 and all second passes were not run.
- Any attempt interrupted by the stopping script is excluded.

Both stopping rules are preserved in the artifacts. A failed submission counts as neither a
clean review nor an adjudicated miss.

## Adjudication

Findings are checked against both the historical base and head. Unlabelled real bugs count as
useful findings, and ambiguous ones stay unresolved. Target labels that share a replay do not
multiply findings or token totals. Suggested edits are judged separately from whether the bug
is real.

**#685.** DeepSeek missed the known defect (empty S3 PUTs omit `Content-Length: 0`), but found
two distinct recovery problems: shutdown deletes the heartbeat used to discover uploaded tails,
and partial recovery removes the discovery key while leaving segments unrecovered. It also
flagged the missing client span on the new S3 dependency, which is valid under the current
observability rubric and
[MAP-01](../.agents/skills/maple-telemetry-conventions/rules/service-map-attribution.md). A
fourth finding, that startup segments are not enqueued for shipping, is unresolved: the source
gap is real, but the claimed data-loss trigger needs more lifetime and rollout evidence.

**#1057 original head.** DeepSeek reported the real wildcard/token mismatch, but it already
existed at the base, so it is out of scope for an introduced-only review. Its suggested
replacement also puts a whole function inside a three-line replacement range, which leaves the
original declaration in place and produces invalid TypeScript.

**#1057 post-fix head.** No findings, passing both suppression checks, but only after close-out
forced the submission.

**#261.** DeepSeek missed both targets. Its interruption finding is false: in the pinned Effect
`4.0.0-beta.93`, `Deferred.complete` delegates to `into`, which captures the interrupted Exit
and completes the Deferred under an uninterruptible mask, so waiters are released with that
Exit. The repository patch does not change this. Its other finding, a new camelCase span
attribute, is valid under the committed NAME-01 rubric but is a low-severity convention issue,
not a functional bug.

**Totals.** Of seven distinct submitted findings, four are valid (two functional defects, two
observability/convention issues), two are false positives under the review scope, and one is
unresolved. A single precision percentage would hide the unresolved case and the severity gap.

## Operational failures

**MiMo.**

1. Attempt 1 exhausted both ten-minute passes.
2. Attempt 2 exhausted the main pass, then hit provider HTTP 400 during close-out. The captured
   response gave no more specific reason.
3. Attempt 3 exhausted both passes without submitting.

Separate small health probes through DeepInfra succeeded: a plain response in 7.4 seconds and a
streamed tool call in 14.0 seconds. So the endpoint is reachable and basic tool calling works;
that neither explains nor rules out a problem in the full agent integration.

**DeepSeek.** Its one non-submission, the #972 holdout, failed because compaction could not fit
the next prompt under the agent's 128,000-token cap. The model's larger configured context does
not lift that runtime limit.

## Limitations

- Exploratory and adaptively stopped: a handful of PRs, no completed repeat study, so no
  general model ranking.
- The adapter disables command execution and live runtime data. This is a source-only
  benchmark, not a production-environment test.
- Token totals are what the provider returned; aborted requests may omit usage. Cached input is
  included. No dollar-cost comparison is drawn.

## Next changes before another model selection run

1. Diagnose MiMo's full-session streaming and close-out failures with provider request IDs and
   redacted error bodies. Basic health probes already pass, so repeating them proves nothing.
2. Make context overflow and failed close-out recoverable, then rerun the same pinned holdouts.
   Record the original failure separately from the close-out failure, which can currently
   overwrite the end reason.
3. Require evidence that each defect is introduced between base and head, and check library
   primitives at the pinned version. Validate replacement ranges before considering automatic
   application.
4. Tune the prompt against severity-weighted useful findings, false positives, target recall
   and completion together. A shorter prompt alone did not help in the earlier smoke test. Add
   more independently verified holdouts before claiming one model is better.

## Reproduction and artifacts

See [eval commands and grading](../apps/ai/scripts/pr-review-eval/README.md). The original
commands used `--repeats 2`; see [Stopping](#stopping) for why the matrix is incomplete.

- DeepSeek run: `apps/ai/scripts/.pr-review-evals/2026-09-25T14-02-03-486Z`
- MiMo run: `apps/ai/scripts/.pr-review-evals/2026-09-25T14-02-33-204Z`
- Combined evidence: `apps/ai/scripts/.pr-review-evals/2026-09-25-deepseek-vs-mimo`

The artifacts directory is gitignored and exists only on the machine that ran the eval. It
holds transcripts, immutable corpus and prompt snapshots, hashes, installed package versions,
model catalogue and endpoint metadata, stopping decisions, and adjudication rationales.
