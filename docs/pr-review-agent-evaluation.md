# PR reviewer audit and evaluation

Point-in-time record from September 25, 2026; not kept current. Covers the parent prompt,
worker prompt and fan-out, local replay, corpus, saved run artifacts and grading. It does not
cover publication, the webhook lifecycle or production sandbox isolation.

Related: [the reviewer design](pr-review-agent-plan.md) · [the DeepSeek/MiMo comparison run
on this suite](pr-review-model-comparison-2026-09-25.md) · [eval commands and
grading](../apps/ai/scripts/pr-review-eval/README.md).

## Corpus and candidate prompt

The corpus has eight enabled labels from four real PRs, replayed over five commit ranges:

| PR                                | Range            | Split       | Labels                      |
| --------------------------------- | ---------------- | ----------- | --------------------------- |
| #972 (Postgres URL parsing)       | fix head         | holdout     | 1 positive                  |
| #685 (empty S3 PUT)               | fix head         | holdout     | 1 positive                  |
| #261 (token log search, 57 files) | introducing head | development | 2 positives                 |
| #1057                             | original head    | development | 2 pre-existing-bug controls |
| #1057                             | post-fix head    | development | 2 post-fix controls         |

This is an initial suite, too small to select a winner. The parent-prompt matrix holds the
worker prompt constant, so large PRs need a separate worker-prompt/coverage experiment before
results extrapolate to them.

`apps/ai/scripts/pr-review-eval/compact.md` is an experimental parent prompt: 4,852
characters / 939 tokens versus 14,532 / 3,301 for the committed prompt (installed
`gpt-tokenizer`; provider tokenizers differ). That is about 72% fewer prompt tokens. Part of
the saving compresses the per-signal observability rules into one bullet of check IDs, so the
compact prompt leans more on the model knowing what each check means. Tool schemas,
retrieved context, repeated calls and workers also consume tokens, so this is not a measured
reduction in total review cost. The production prompt and model defaults are unchanged.

The evaluator never posts to GitHub. Grading is by hand on purpose: line matching or an
uncalibrated model judge would reproduce the original measurement problem (finding 1).

## Findings

1. **Line overlap was being scored as detection.** The saved September 24 eval
   (`2026-09-24T23-50-51-842Z`) credited the wildcard case for a Unicode-folding finding at the
   same lines, so both labels could look caught while one defect was missed. Overlap is now
   navigation only, and every target is graded on meaning.
2. **Historical replay could see the answer.** Most cases fetched the live PR with its
   present-day comments and checks; source tools accepted later refs, and git execution could
   inspect future fixes. Cases now use immutable ranges, omit live discussion, and disallow
   execution and source reads outside the head's ancestry.
3. **Mining did not establish attribution.** Three cases are disabled: #853's fix does not
   edit the recorded path, #740's fix concerns attribute precedence rather than the stated
   session comparison, and #660's blame does not prove it introduced the attribute-filter bug.
   They remain candidates, not benchmark successes or failures. The #685 target is
   specifically about **empty** PUT bodies.
4. **The development cases leaked into the prompt.** PR #1057's exact wildcard and
   Kelvin-sign counterexamples already appear in the production prompt. Treat those cases as
   regression checks, never as evidence of generalization.
5. **Positive labels had the wrong base.** Both #1057 defects already existed at that PR's
   base, so the reviewer was right not to report them. Positive labels now use PR #261, which
   introduced token filtering; PR #1057 is a suppression control.
6. **Prompt constraints can work against useful review.** Banning the word "if" confuses a
   concrete conditional failure with speculation. Blanket expectations for error spans,
   logging and service darkness can reward instrumentation noise. "Submit exactly once"
   conflicts with the coverage guard's retry protocol. The compact prompt permits supported
   conditions, checks existing wrappers, calibrates severity to impact, and allows submission
   retries.
7. **Model comparisons need completion metrics.** A compact-prompt run on
   `openai/gpt-6-luna` failed schema decoding on the submission's `tests` field, close-out
   included. That is one failed run, not a statement about the model. Report failures
   separately from semantic recall.
8. **Local tool behavior can confound results.** Brace globs such as `**/*.{ts,tsx}` silently
   matched nothing in the local git adapter; they now return an unsupported-glob error. Model
   overrides no longer mutate process-wide environment state between matrix cells. The local
   executor now implements both preparation methods its interface requires.

## Smoke results

Three source-only replays at PR #1057's original head, one run per configuration. The
correct outcome is no finding: both defects are pre-existing.

| Model / parent prompt           | Submission | Seconds | Input tokens | Output tokens | Tool calls | Target assessment                           |
| ------------------------------- | ---------- | ------: | -----------: | ------------: | ---------: | ------------------------------------------- |
| DeepSeek v4.1 Flash / committed | completed  |     224 |      957,305 |        59,370 |         34 | correctly omitted both pre-existing defects |
| DeepSeek v4.1 Flash / compact   | completed  |     329 |    1,190,393 |        80,421 |         41 | reported the pre-existing Unicode defect    |
| GPT-6 Luna / compact            | failed     |      53 |       24,855 |         1,245 |          6 | invalid submission schema; ungraded         |

**The compact prompt is not promoted.** Here it was slower, used more total tokens despite a
shorter system prompt, and filed an out-of-scope finding.

Raw outputs are in `apps/ai/scripts/.pr-review-evals/2026-09-25T13-48-05-122Z` and
`2026-09-25T13-48-40-576Z`. Those snapshots keep the original, incorrect positive labels so
the history is not rewritten; score from the corrected grades in
`2026-09-25-smoke-adjudicated` instead. The artifacts directory is gitignored and exists only
on the machine that ran the eval.

## Limitations

- Single observations on development inputs that are known to be in the prompt: not a model
  ranking or a recall benchmark. The [comparison run](pr-review-model-comparison-2026-09-25.md)
  adds positive targets and holdouts.
- Input totals include cached input and are not dollar costs.
- Both DeepSeek runs preceded the argument-notice and brace-glob fixes. Repeat on the final
  runner before drawing stronger conclusions.

## Validation

11 targeted tests passed, including semantic-grading regressions and future-commit/command
isolation. The AI package typecheck and an explicit script typecheck passed; the normal AI
tsconfig excludes `scripts/`, so the explicit check matters. Targeted lint, formatting and
diff-whitespace checks passed.
