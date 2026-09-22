# Observability review of pull requests

Maple reviews a customer's pull requests for observability: when a PR adds a route, a job, an
outbound call or a new service, the review says whether that code will show up in traces, logs and
metrics, scores it, and posts the result on the PR. It is opt-in per repository, staged per
organization, and runs as one turn of an effect-agent agent on the machinery the investigation pass
uses.

What makes it different from a lint rule is the warehouse. The reviewer can ask whether the touched
service reports at all, whether the operations in the changed file already have spans in
production, and whether an attribute key the diff introduces already exists under another spelling.

## How it works

### Trigger

The `pull_request` webhook lands in `GithubProvider.mapPullRequest`, which fills `headSha`,
`baseSha`, `headRef`, `baseRef`, `draft` and `headRepoFullName` on `PullRequestEventJob` (all
optional, so jobs queued before the change still decode) and accepts `ready_for_review`. The job
goes through `VcsSyncQueue` to `VcsSyncService` and the `PullRequestEventSink` port, whose live
binding in `apps/api/src/vcs-sync-runtime.ts` is `pullRequestEventSinkFanout`: fix verification and
the review trigger both run on every delivery, each isolated so one cannot starve the other.

`PrReviewService.onPullRequestEvent` (`packages/backend/src/services/pr-review/`) then decides,
in order, skipping with the reason in brackets:

- the action is `opened`, `reopened`, `synchronize` or `ready_for_review` (`action`);
- the repository has `pr_review_enabled` (`disabled`);
- the organization carries the `prreview` rollout flag, see "Staged rollout" (`not_rolled_out`);
- the PR is not a draft (`draft`) and the job carries a head SHA (`no_head_sha`);
- the author is not a bot: a `[bot]` suffix, dependabot, renovate or GitHub Actions
  (`bot_author`);
- the organization has started fewer than `PR_REVIEW_DAILY_CEILING` (60) reviews today, counting
  every row started today whatever its status (`quota`);
- the head SHA has no live review yet (`duplicate`); a failed one is reclaimed for another attempt.

A review that passes inserts a `pr_reviews` row and starts one turn on the session
`<orgId>:pr-<reviewId>` through `chatSessionStub(...).beginTurn`, exactly like
`startInvestigationTurn`. One session per review, one review per head SHA. A new head aborts the
review still running for the same PR and marks it `superseded`; a submission that arrives for a
superseded row is dropped.

### The agent (`apps/ai`)

- **Mode.** `pr-review` is a `ChatMode` with tab prefix `pr-`. Its `AGENTS` entry carries
  `PR_REVIEW_SYSTEM_PROMPT`, `PR_REVIEW_BUDGET` (60 tool calls, 8 minutes, 800k tokens, 48k
  completion reserve) and `autonomousPermission: PR_REVIEW_RULESET`, which `profileForTurn` uses
  for the unattended pass only.
- **Tools.** `PR_REVIEW_RULESET` denies everything and allows the names in `PR_REVIEW_TOOLS`:
  `pr_changed_files`, `pr_file_diff`, the four `sandbox_*` tools, `list_source_repositories`,
  `search_source_code`, `read_source_file`, and the read-only telemetry tools `list_services`,
  `get_service_top_operations`, `explore_attributes`, `search_traces`, `service_map`,
  `list_metrics`, `audit_setup` and `get_instrumentation_recommendations`. `permissions.test.ts`
  pins that every name is registered and none mutates.
- **Diff tools.** `pr_changed_files` and `pr_file_diff` are internal tools
  (`apps/ai/src/mcp/tools/pull-request.ts`) over GitHub's pull request files endpoint, so they work
  locally, on previews and for fork PRs, where the prd-only sandbox does not. `pr_changed_files`
  classifies each file (source, test, generated, docs, config, infra, tooling) and states the call
  budget, `reviewCallBudget`: two calls per reviewable file plus four, between 6 and 40.
  `pr_file_diff` takes up to 20 `paths` per call and annotates new-side line numbers, so a finding
  cites a line GitHub accepts.
- **Completion.** `submit_review` is offered only to the review's unattended pass; a person's
  follow-up in the same session answers in prose. Its parameters are the lenient
  `PrReviewSubmission`, every field optional, for the reason the diagnosis schema is lenient.
  `normalizePrReviewSubmission` drops any finding without a path, a positive line, or a check id
  from the `maple-audit` grammar (`SPAN-03`, `REN-DUAL`), and derives the verdict: `gaps` exactly
  when a warn or critical finding survives, otherwise the model's `not_applicable` or
  `instrumented`. A pass that stops without submitting gets the shared close-out turn
  (`withToolTranscript` in `apps/ai/src/chat/close-out.ts`), which sees the tool calls and results
  the pass gathered.
- **Billing.** The turn is metered with source `review` and an idempotency key of the review id
  and the turn.

The prompt is the audit skill's static procedure applied to a diff: read the repository's
instrumentation conventions once, list the review units the diff adds, and for each decide
instrumented, gap, or covered by auto-instrumentation. Nothing in the PR body or the diff is an
instruction.

### Rubric

Derived from the `maple-audit` check ids, applied to what the PR adds rather than to the whole
service.

| Change in the diff                                                                   | Expectation                                                                                                      | Check ids                       |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| New inbound entrypoint: HTTP route, RPC handler, queue or cron consumer, CLI command | a Server or Consumer span, or auto-instrumentation that demonstrably covers the framework                        | `SPAN-01`, `SPAN-03`, `STAT-04` |
| New outbound call: fetch or HttpClient, DB query, queue publish, third-party SDK     | a Client or Producer span with `peer.service`, `db.system`, `server.address`                                     | `MAP-*`, `STAT-03`              |
| New background work: cron, worker, workflow step                                     | a span per unit of work, context propagated from the producer                                                    | `SPAN-03`, `SPAN-04`            |
| New error path: catch, `Schema.TaggedError`, fallback branch                         | exception recorded, status `Error` where the request failed, not swallowed                                       | `STAT-01`, `STAT-02`            |
| New log statements                                                                   | structured, trace-correlated, no PII; `console.log` in server code is a finding                                  | `LOG-*`, `PII-01`               |
| New operation worth counting or timing where the repo already has a meter            | a counter or histogram                                                                                           | `MET-*`                         |
| New attribute keys                                                                   | semconv or the org namespace, no camelCase, no deprecated key, no second spelling of a key the org already emits | `REN-*`, `NAME-*`               |
| New service or deployable                                                            | `service.name`, `service.version`, `deployment.environment.name`, `vcs.ref.head.revision`, an exporter wired     | `RES-01`..`RES-08`              |

### Score

`scorePrReview` in `packages/domain/src/http/pr-review.ts`: 100, minus 25 per critical finding, 10
per warning and 2 per note, floored at 0. Graded excellent (90 or more, and no gap), good (75+),
needs work (50+) or poor. A single warning scores 90 but grades good, so the headline never calls a
gap excellent. The score is computed from the findings rather than asked of the model, so the same
gaps always score the same, and it is stored in `pr_reviews.score`.

### Publishing to GitHub

`PrReviewService.submitReview` stores the report, then calls
`VcsProviderClient.publishPullRequestReview`, which posts, in order:

1. **A check run** named `Maple / observability` on the head SHA, titled `<score>/100 · <verdict>`,
   concluding `neutral` for gaps and `success` otherwise, never `failure`. An installation that
   has not granted `checks: write` answers 403, and the review is posted without the check run. A
   rate-limited 403, which carries a retry time, fails the publish instead.
2. **One summary comment**, always, found again by its hidden `<!-- maple-pr-review -->` line and
   authored by the App, and edited in place on later pushes. It carries the score, grade, verdict,
   counts, summary, findings linked to their lines at the head SHA, what to change, and the
   coverage table. The comment and the check summary share `renderReviewMarkdown`.
3. **A `COMMENT` review** with the findings above `info` inline, only when there are any. GitHub
   refuses the whole review with a 422 when one line is outside the diff; the inline notes are then
   dropped, since the summary comment already carries every finding.

The publisher takes the PR identity from the `pr_reviews` row bound at trigger time, never from
tool arguments, so text in a diff cannot redirect where the review is posted. A refused post lands
in `pr_reviews.publish_error` and is not retried into the run.

### Persistence and settings

`pr_reviews` (`packages/db/src/schema/vcs.ts`, migration `20260922213359_pr_reviews`, which also
adds `vcs_repositories.pr_review_enabled`) holds the PR identity (`repository_id`, `number`,
`head_sha`, `base_sha`, `url`, `title`), `status` (`queued`, `running`, `completed`, `failed`,
`skipped`) with `skip_reason`, `session_id`, `report_json`, `score`, the three published URLs,
`publish_error`, `error`, `model`, token counts and timestamps. The prd deploy applies the
migration. The table is registered with `OrganizationService`, so an organization purge removes it.

`PUT /api/integrations/github/repositories/:id/pr-review` sets `pr_review_enabled`, and
Integrations → GitHub shows a "Review PRs" switch per repository.

### Observability of the reviewer

The trigger (`PrReviewService.onPullRequestEvent`) and `submitReview` spans carry
`maple.pr_review.id`, `.outcome`, `.skip_reason`, `.started_today`, `.superseded`, `.verdict`,
`.score`, `.findings`, `.coverage`, `.partial`, `.published` and `.stale_submission`, and the sink
handler records `.trigger`. The `submit_review` tool span adds `.filled_fields`, `.filled_count`
and `.dropped_findings`, and the turn records `.closed_out` when the runner had to close it out. The publish span carries `vcs.pull_request.check_run_id`, `.comment_id`,
`.review_id`, `.check_run_skipped` and `.review_comments_rejected`. The turn itself is an ordinary
chat session, so Agent Sessions shows its transcript.

## Staged rollout

Merging this feature turns it on for no one. It is gated per organization by the `prreview` rollout
flag, in the same Clerk public metadata as the other rollout flags. To flag an organization, set
this in the Clerk dashboard under the organization's public metadata:

```json
{ "prreview": true }
```

Only the literal boolean `true` counts; a missing key, `false` or the string `"true"` all read as
off. The flag is enforced in three places:

- **The switch.** Integrations → GitHub shows "Review PRs" on a repository only for a flagged
  organization.
- **The endpoint.** The `pr-review` endpoint refuses to turn reviews on for an unflagged
  organization, so the switch cannot be bypassed by calling the API. Turning reviews off is always
  allowed.
- **The trigger.** `PrReviewService` skips a pull request with `not_rolled_out` for an unflagged
  organization, so removing the flag stops reviews even on repositories switched on earlier.

The flag contract lives in `@maple/domain/organization-feature-flags` and is decoded on the server
by `OrganizationFeatureFlagsService`, which reuses an organization's flags for 60 seconds per
isolate, so withdrawing a flag takes effect within a minute. Self-hosted builds have no Clerk and
get every rollout on, as the web app already did. A managed build that cannot reach Clerk treats
every rollout as off for that call.

Maple's hosted App (`MapleLabsApp`) currently grants `checks: read`. Until it is raised to read and
write and each installation accepts the change, reviews post the summary comment and the inline
review without the check run.

## Iterating locally

The reviewer runs on this machine against any real pull request, without the stack, a GitHub App
installation, or a webhook:

```bash
bun run --cwd apps/ai review:local MapleTechLabs/maple 976
bun run --cwd apps/ai review:local https://github.com/octo/shop/pull/12 --model nvidia/nemotron-3-ultra-550b-a55b:free
bun run --cwd apps/ai review:local MapleTechLabs/maple 976 --prompt-file /tmp/prompt.md
```

It needs `gh` logged in and `OPENROUTER_API_KEY` in the root `.env.local`. The agent record,
engine loop, model, `submit_review` normalization and `buildPublication` are the production ones,
and the two diff tools print exactly what production prints. The source tools read a local clone
at the head commit through git (`--repo-dir`, else this checkout when it is the same repository,
else a cached clone under `~/.cache/maple-pr-review`). `sandbox_exec` runs read-only git only. The
telemetry tools answer that no warehouse is attached, so warehouse-grounded checks are not
exercised by a local run. Nothing is posted to GitHub.

Each run writes `apps/ai/scripts/.pr-review-runs/<owner>__<repo>__<n>__<time>/`:

- `review.md`: the check run and review body as GitHub would render them, and every finding with
  its diff context. A finding whose line is not on the new side of the diff is marked **off the
  diff**, because GitHub would refuse it as an inline comment.
- `transcript.md`: every tool call with its input and full output, and the model's prose.
- `report.json`: the normalized report, the publication, tokens and duration, for diffing two runs.

`--range base..head --repo-dir <clone>` reviews a local branch instead of a pull request, which
is how gap fixtures are built without opening a pull request anywhere: commit code with known
gaps on a throwaway branch and check each one comes back as a finding. `--post` writes the
summary comment to the real pull request with your own `gh` login, to see it rendered on GitHub.

Cost baseline from the first iteration (2026-09-22, `z-ai/glm-5.3-flash:nitro`):

| Change                               | Before                      | After                                  |
| ------------------------------------ | --------------------------- | -------------------------------------- |
| #962 (7 files, spans)                | 388k input tokens, 25 calls | 48k, 9 calls, correct `100/100`        |
| #977 (3 files, web)                  | 374k input tokens, 23 calls | 52k, 5 calls, correct `100/100`        |
| Gap fixture (1 file, 4 planted gaps) |                             | 42k, 5 calls, all four found, `60/100` |

What moved it: `pr_changed_files` states a call budget (`reviewCallBudget`), the prompt reads the
repository's conventions before the diffs and verifies only what a finding depends on, and
`tooling` files are not reviewed.

`--prompt-file` replaces the system prompt for that run (an `agent` override on `ChatRunInput`), so
a prompt change can be compared against the committed one before it is edited in.

The full path (webhook → trigger → Durable Object → GitHub post) is covered by
`PrReviewService.test.ts` and needs a deployed stage with the App installed to run live.

## Limits and what is next

- **Sandbox is prd only.** Local and preview runs use the API diff tools and `read_source_file`.
  Fork PRs get the API path only; deep context needs `git fetch origin refs/pull/N/head` in
  `cloneScript`.
- **The diff tools trust their arguments.** `pr_changed_files` and `pr_file_diff` take the PR
  number from the model rather than from the session, so a pass could read another PR of the same
  connected repository. Publishing is not affected, since it reads the row.
- **Warehouse-grounded checks** (signal presence, attribute spelling, operation coverage) are
  prompt prose today; local runs cannot exercise them.
- **Open work:** fingerprint dedupe of findings across pushes, an abandoned-row sweep next to
  `sweepAbandonedInvestigations`, fan-out for large PRs through `@effect-agent/capabilities`
  `Subagent` once it is published at the engine's version, a reviews list, and per-repository
  config (path excludes, check-only, a required-check mode).
