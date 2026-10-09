# Before-merge checklist: what is left

Status: sections 1, 2 and 4a built on `feat/pr-review-merge-steps` (2026-10-09); `@maple done`,
the analytics count, section 3, 4b, 4c and the gate are open. How the built parts work is in
`docs/pr-review-agent-plan.md`, "Before merge".

## Where it stands

#1339 shipped the checklist itself (described in `docs/pr-review-agent-plan.md`, "Before merge"):

- `merge-checklist.ts` detects new secret and env reads (config helpers, runtime reads, workflow
  `secrets.*` / `vars.*`, `.env.example`), added migrations, warehouse schema and deploy config.
- Each name is checked against a default-branch code search (whole word, up to 10 names). Names the
  search cannot confirm are listed as unverified, not dropped.
- The reviewer adds its own steps through `beforeMerge` on `submit_review` (up to six). A reviewer
  step that names a detected subject exactly replaces it.
- The comment renders `- [ ]` items under the summary, and the web sheet shows them.
- `maple.pr_review.checklist.*` attributes go on the span, with one log line.
- `review:checklist` prints any PR's checklist without a model, and `review:local` reproduces it.
- `merge-checklist.test.ts` covers detection, verdicts, replacement, ignored paths and rendering.

That covers steps 1 and 3 of the previous plan and layer 1 of its evals. What is left is below.

## 1. Ticks that stick (main gap)

Today the boxes are decoration. Every review starts its own comment (#1051), so a box ticked on
one push is gone on the next. Nothing reads the ticks, and the list is stored per review in
`report_json`, not per pull request.

- **Table** `pr_review_merge_steps`, keyed by `(org_id, repository_id, pr_number, key)`, where
  `key` is `kind:subject` for detected steps and `manual:<slug>` for reviewer steps. Columns:
  `status` (`open` / `done` / `obsolete`), `done_by`, `done_at`, `first_review_id`,
  `last_review_id`, plus the step fields. Register it with `OrganizationService` purge.
- **Carry forward in `submitReview`.** Upsert the built steps. An open step the new head no longer
  produces becomes `obsolete`, and a `done` step stays done. Render `[x]` from the stored status.
- **Read the ticks.** Ticking edits the comment, which arrives as `issue_comment` with
  `action: "edited"`. `GithubProvider.mapIssueComment` skips everything but `created` today. Add a
  branch for edits by a person (not a bot) on a comment our App wrote that carries the
  `maple-pr-review` marker, and emit a `pull-request-merge-steps` job with the `{ key, checked }`
  pairs. Each rendered item carries `<!-- ms:<key> -->` so the parse does not rely on wording.
  The handler never re-renders the comment, so there is no edit loop.
- **Typed fallback.** `@maple done <n|subject>` through the existing reply command parser.

## 2. Remember it at merge

This is the reminder Christo asked for. Both parts depend on section 1.

- If a PR merges with open steps, the post-merge comment (`PrReviewPostMergeService`) leads with
  them ("merged with 1 open step: secret `FOO`").
- The Code Review analytics tab shows the count of PRs merged with open steps.

## 3. Smaller additions

- **Repository rules.** The prompt already asks for steps "in the repository's terms". Make it
  explicit: a `## Before merge` section in `.maple/review.md` that the reviewer always applies
  (for example, "a change under `packages/db/drizzle` needs `ps:migrations-preflight`").
- **Kinds.** `dependency` (a new or major-bumped package) is not detected. `permission` and `flag`
  currently fold into `manual`. Add them only if the evals show the model-written manual steps
  missing them.
- **Settings.** A per-repository off switch and muted kinds in `PrReviewRepositoryConfig`.
- **Gate (last).** `blockOnOpenChecklist` concludes `failure` while a detected step is open. It
  stays off by default and is built only after a month of production precision. Reviewer steps
  never block.

## 4. Evals

The checklist has two halves that need different evals: detection is deterministic and free to
score, while reviewer steps need a model and a person grading them.

### 4a. Detector corpus (no model, runs in `bun run test`)

`merge-checklist.test.ts` holds hand-written patches. Add a corpus of real pull requests so recall
and noise are measured on history, not on fixtures written to pass.

- `merge-checklist.corpus.json`: one entry per PR, holding the changed files' patches (snapshotted
  so the test needs no network), the names the base already referenced (snapshotted from a
  whole-word `git grep` at the base SHA, as `review:local` does), and the labels: `expected` keys,
  `forbidden` keys (an existing key the PR also touches), or `expectEmpty`.
- A script, `review:checklist --snapshot <n>`, writes an entry from a real PR so adding a case is
  one command plus labelling. It must verdict at the base SHA: against a merged PR the default
  branch already has the names, so the current command reports them as `exists`.
- The test asserts recall per kind, precision and noise over the corpus, with thresholds below.
  A detector change that loses a case fails CI.
- **Seed cases.** #1036 adds `MAPLE_REVIEW_MODEL_OPENROUTER` (confirmed). #965, #1001, #1218 and
  #1339 are setup PRs to label by hand. Negatives are refactors that touch config code without a
  new name (#1164 is a candidate, unverified) and a sample of the bug corpus's PRs. The target
  before tightening thresholds is 25 positive and 15 negative cases.
- `review:eval mine --checklist` proposes candidates: commits that add `.env.example` keys,
  workflow `secrets.*`, alchemy secrets or migrations, and PR bodies mentioning "secret", "env
  var", "before merge", "backfill" or "migration".

### 4b. Reviewer steps (model, run by hand or on the `run-evals` label)

The reviewer's own steps (permissions, flags, backfills) are where a model can miss or invent.

- Extend `review:eval` (`apps/ai/scripts/pr-review-eval/`) with `--suite checklist` on the same
  replay harness, so pinned SHAs, ancestor-only reads and execution-off still hold. Cases reuse the
  corpus entries from 4a and add `reviewerExpected` (a description of each step a careful human
  would list) for the cases with one.
- Grading: a detected-kind step is matched by key automatically. Reviewer steps go into
  `grades.json` with the finding eval's verdicts (`target`, `other_valid`, `false_positive`,
  `duplicate`), graded by meaning.
- Statistics: borrow `apps/ai/src/evals/stats.ts` from #1303 (pass@1 with clustered error bars,
  pass^k, paired comparison) rather than reporting raw percentages. `review:eval` does not use it
  yet.
- Every checklist run also re-scores the bug corpus and records tokens. A `beforeMerge` prompt
  change that costs finding recall, or adds more than about 10% tokens, does not ship.
- Once a few cases pass every trial, move them into the #1303 regression tier so the `run-evals`
  label in `eval.yml` gates prompt changes. This needs a pr-review solver beside `chat-turn.ts`,
  which is the larger job, so it comes after the hand-run suite proves useful.

### 4c. Production signal (after section 1)

- Per kind: done, obsolete and still-open-at-merge rates from the new table. Add
  `maple.pr_review.checklist.done` / `.obsolete` to the spans.
- Misses: a commit within 48 h of merge that adds a secret name the review did not list, or an
  `@maple` reply disputing a step. Each miss becomes a candidate corpus case for 4a.

### Bars (proposed, revisit after the first run)

| Metric                           | Bar                          |
| -------------------------------- | ---------------------------- |
| Secret and migration recall (4a) | at least 95%                 |
| Precision, detected kinds (4a)   | at least 90%                 |
| Noise on negative cases (4a)     | at most 1 step across 10 PRs |
| Reviewer-step precision (4b)     | at least 70%, reported       |
| Bug-corpus finding recall (4b)   | no drop                      |
| Tokens per review (4b)           | at most +10%                 |

## Build order

1. 4a: the detector corpus, the snapshot command and the thresholds in CI. It is cheap, and it
   measures what already shipped.
2. Section 1: the table, carry-forward, edited-comment ticks and `@maple done`.
3. Section 2: the post-merge reminder and the analytics count.
4. 4b: the reviewer-step replay suite, then the repository-rules section and new kinds if it
   shows gaps.
5. 4c: production signal.
6. The gate.

## Tests (beyond the evals)

- PGlite `PrReviewService.test.ts`: upsert across two heads, obsolete on removal, done survives,
  rendered `[x]`.
- Provider: an edited marker comment by a person maps; edits by the App or a bot, and edits on
  other comments, are skipped.
- Post-merge render with and without open steps.
