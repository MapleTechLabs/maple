---
title: "GitHub"
description: "Install the Maple GitHub App to sync repositories and commit history, resolve commit SHAs in your telemetry, trace your GitHub Actions runs, and give Maple's agents read access to your source code."
group: "Integrations"
order: 4
---

The Maple GitHub App syncs your repositories and their commit history into Maple. You install the app, choose which repositories to share, and pick one branch to track per repository. Maple backfills the last 90 days of commits on that branch and keeps it current through GitHub webhooks.

Once connected, the integration does three things:

- **Commit context in telemetry.** When your services report the `vcs.ref.head.revision` resource attribute, Maple resolves the SHA against synced commits. The trace view and service pages show a commit hover card with the author, message, and a link to GitHub.
- **CI traces.** Every finished GitHub Actions run becomes a trace under the `github-actions` service: the run is the root span, each job a child span, and each step a span inside its job. No workflow changes are needed. Each job's log comes along as logs on those spans.
- **Source code for Maple's agents.** Investigations and pull request review read your repositories through the app installation, so they can go from an exception in a trace to the code that raised it. These reads are not offered to third-party assistants on the [MCP server](/docs/reference/mcp).

## Prerequisites

- Permission to install GitHub Apps on the personal account or organization that owns the repositories.

## Set up

### 1. Install the GitHub App

In Maple, open **Sources**, click **Connect source** and pick **GitHub**. Click **Install on GitHub**. GitHub opens in a new window and walks you through installing the **Maple GitHub App**. During install you choose the scope:

- **All repositories**: Maple syncs every repository the account can access, including ones added later.
- **Only select repositories**: Maple syncs only the repositories you pick. You can change the selection from GitHub at any time.

When the install completes, GitHub sends you back and Maple shows the account and repository scope. Maple discovers repositories and queues a backfill for each. Each row moves from **Queued** to **Syncing** to **Synced**.

### 2. Pick a tracked branch per repository

Each repository tracks one branch. It starts as the repository's default branch, and Maple syncs commits only from that branch. Use the **Tracked branch** selector on a repository row to change it.

Changing the tracked branch is destructive. Maple deletes the repository's synced commits and re-syncs the last 90 days from the new branch. The app asks you to confirm before it applies the change.

## How syncing works

- **90-day backfill** on connect and whenever you change the tracked branch.
- **Webhooks** deliver pushes to a tracked branch as they happen. Force-pushes are reconciled. Repositories added to or removed from the installation, and a suspended app, are picked up automatically.
- **A scheduled reconcile** runs every 12 hours for every installation, so a missed webhook does not leave gaps.

## CI traces

Maple receives GitHub's `workflow_run` and `workflow_job` webhooks for the repositories the app can see and writes one trace per run attempt. A re-run gets its own trace.

- **Spans:** the run is a `SERVER` span named `RUN <workflow>` (for example `RUN CI`), from when it started to when it finished. A job that waited a second or more for a runner spans from when it was queued to when it finished, with a `Waiting for a runner` child span for that wait; otherwise it starts when the runner picked it up, and a job that never started has no length. The wait is always on the job span as `maple.cicd.queue_duration_ms`. Each step is a span inside its job, named without the commit a pinned action points at (`Run actions/checkout`, not `Run actions/checkout@3d3c42e…`). Steps that never ran are left out.
- **Status:** failed and timed-out runs, jobs, and steps are `Error` with `error.type` set, passing ones are `Ok`, and cancelled or skipped ones carry no status.
- **Failure reasons:** for a failed job, Maple reads the annotations GitHub recorded on it (test failures, compiler errors). The most specific one becomes the job span's status message and `maple.cicd.failure.reason`, and up to 20 of them, failures first, are `cicd.annotation` events on the job span with `code.file.path` and `code.line.number`.
- **Attributes:** spans follow the OpenTelemetry CI/CD conventions (`cicd.pipeline.name`, `cicd.pipeline.run.id`, `cicd.pipeline.action.name`, `cicd.pipeline.result`, `cicd.pipeline.task.name`, `cicd.pipeline.task.run.id`, `cicd.pipeline.task.run.result`, `cicd.pipeline.task.run.url.full`, `cicd.worker.name`) plus `vcs.ref.head.name`, `vcs.ref.head.revision`, and `vcs.change.id` (the pull request number). Jobs and steps are both tasks; a step's URL links to its line in the job log. The resource carries `vcs.repository.name`, `vcs.owner.name`, and `vcs.repository.url.full`, so you can filter CI traces by repository.

CI traces and logs are on by default. CI spans and logs are ingested like any other telemetry and count toward your usage. To stop both, an organization admin turns off **CI traces and logs** on the GitHub source in **Sources**; runs that finish while it is off are not recorded.

## CI logs

Maple also downloads each finished job's log from GitHub and writes every line as a log record under the `github-actions` service. Nothing runs inside your workflows: the app's existing **Actions: Read** permission covers the download.

- **Linked to steps:** each record carries the job's trace id and the span id of the step that was running when the line was written, so a step's output shows up with that step in the trace view. Lines from before the first step belong to the job span.
- **Timestamps** come from the runner's own per-line stamps. A line without one, such as the rest of a multi-line message, takes the stamp of the line before it.
- **Severity:** `##[error]` lines (including `::error::` workflow commands) are `ERROR`, `##[warning]` lines are `WARN`, `##[debug]` lines are `DEBUG`, and everything else is `INFO`. The runner's markers and color codes are removed from the text, and blank lines are dropped.
- **Attributes:** `cicd.pipeline.name`, `cicd.pipeline.run.id`, `cicd.pipeline.task.name` and `cicd.pipeline.task.run.id` (the same as on the step span, or the job's for job-level lines), `maple.cicd.step.number`, `maple.cicd.job.name`, `vcs.ref.head.name`, and `vcs.ref.head.revision`.
- **Size:** Maple keeps the first 5 MB of a job's log and cuts lines longer than 8,000 characters. A cut log ends with a `WARN` record that links to the full log on GitHub.
- **Secrets:** GitHub masks registered secrets as `***` before Maple reads the log. Values a job prints that were never registered as secrets are kept as written.

Logs arrive a few seconds after their job's spans, since GitHub publishes a log shortly after the job finishes.

## Verify

1. On the GitHub source in **Sources**, every repository row reads **Synced** with a recent sync time. The page polls while backfills run, so you do not need to reload.
2. Deploy a service that sets `vcs.ref.head.revision` to the commit SHA it was built from. See [OpenTelemetry conventions](/docs/concepts/otel-conventions).
3. Open a trace from that service. The short SHA in the trace header shows the commit author and message on hover.

## Managing the connection

- **Refresh** reloads repository status.
- **Edit data** (or **Change repos on GitHub** during setup) reopens the GitHub App install screen so you can add or remove repositories.
- **Needs attention** lists repositories whose access was removed on GitHub. Their commit history is kept. Re-enable them in the [GitHub App settings](https://github.com/settings/installations) to resume syncing, or click **Delete** to remove the repository and its synced commits from Maple.
- **Disconnect** removes the app connection and permanently deletes all synced repositories and their commit history from Maple. Reconnecting later re-syncs from scratch.

## Troubleshooting

- **A repository shows Sync failed.** Click **Refresh**. Failed backfills are retried automatically. The row shows the underlying error, most often a GitHub rate limit (retried once the limit resets) or revoked access.
- **No repositories appear after connecting.** Discovery and the first backfill run in the background. The page polls and fills in as they complete.
- **Commits don't show up for a repository.** Confirm the tracked branch is the one your commits land on. Only the tracked branch is synced.
- **Traces show a SHA without a hover card.** The SHA must be a full 40-character commit on a synced tracked branch within the synced history.
- **No CI traces appear.** Traces are written when a run or job finishes, so a run in progress has none yet. Check that **CI traces and logs** is on for the GitHub source in **Sources**. If finished runs are still missing, open the [GitHub App settings](https://github.com/settings/installations) and accept any pending permission request from the Maple app.
- **CI traces appear but no CI logs.** A job whose steps never ran has no log to send, and a log GitHub takes too long to serve is skipped.

## Next steps

- [OpenTelemetry conventions](/docs/concepts/otel-conventions): the `vcs.*` resource attributes Maple reads.
- [MCP server](/docs/reference/mcp): connect an assistant to your telemetry.
- [Traces](/docs/explore/traces): where commit context appears.
