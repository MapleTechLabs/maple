---
title: "GitHub"
description: "Install the Maple GitHub App to sync repositories and commit history, resolve commit SHAs in your telemetry, trace your GitHub Actions runs, and give the MCP server read access to your source code."
group: "Integrations"
order: 4
---

The Maple GitHub App syncs your repositories and their commit history into Maple. You install the app, choose which repositories to share, and pick one branch to track per repository. Maple backfills the last 90 days of commits on that branch and keeps it current through GitHub webhooks.

Once connected, the integration does three things:

- **Commit context in telemetry.** When your services report the `vcs.ref.head.revision` resource attribute, Maple resolves the SHA against synced commits. The trace view and service pages show a commit hover card with the author, message, and a link to GitHub.
- **CI traces.** Every finished GitHub Actions run becomes a trace under the `github-actions` service: the run is the root span, each job a child span, and each step a span inside its job. No workflow changes are needed.
- **Source code tools for the MCP server.** The [MCP server](/docs/reference/mcp) gains three read-only tools that reach your repositories through the app installation: `list_source_repositories`, `search_source_code` (GitHub code search on the default branch), and `read_source_file` (a line range at a branch, tag, or commit SHA). An assistant can go from an exception in a trace to the code that raised it.

## Prerequisites

- Permission to install GitHub Apps on the personal account or organization that owns the repositories.

## 1. Connect your GitHub account

Open **Integrations → GitHub** in Maple and click **Connect GitHub**. A popup walks you through installing the **Maple GitHub App**. During install you choose the scope:

- **All repositories**: Maple syncs every repository the account can access, including ones added later.
- **Only select repositories**: Maple syncs only the repositories you pick. You can change the selection from GitHub at any time.

When the install completes, the popup closes and the card shows **Connected** with the account and repository scope. Maple discovers repositories and queues a backfill for each. Each row moves from **Queued** to **Syncing** to **Synced**.

## 2. Pick a tracked branch per repository

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

CI traces are on by default. CI spans are ingested like any other telemetry and count toward your usage. To stop them, an organization admin turns off **CI traces** on **Integrations → GitHub**; runs that finish while it is off are not recorded.

## Verify

1. On **Integrations → GitHub**, every repository row reads **Synced** with a recent sync time. The card polls while backfills run, so you do not need to reload.
2. Deploy a service that sets `vcs.ref.head.revision` to the commit SHA it was built from. See [OpenTelemetry conventions](/docs/concepts/otel-conventions).
3. Open a trace from that service. The short SHA in the trace header shows the commit author and message on hover.

## Managing the connection

- **Refresh** reloads repository status.
- **Manage** reopens the GitHub App install screen so you can add or remove repositories.
- **Needs attention** lists repositories whose access was removed on GitHub. Their commit history is kept. Re-enable them in the [GitHub App settings](https://github.com/settings/installations) to resume syncing, or click **Delete** to remove the repository and its synced commits from Maple.
- **Disconnect** removes the app connection and permanently deletes all synced repositories and their commit history from Maple. Reconnecting later re-syncs from scratch.

## Troubleshooting

- **A repository shows Sync failed.** Click **Refresh**. Failed backfills are retried automatically. The row shows the underlying error, most often a GitHub rate limit (retried once the limit resets) or revoked access.
- **No repositories appear after connecting.** Discovery and the first backfill run in the background. The card polls and fills in as they complete.
- **Commits don't show up for a repository.** Confirm the tracked branch is the one your commits land on. Only the tracked branch is synced.
- **Traces show a SHA without a hover card.** The SHA must be a full 40-character commit on a synced tracked branch within the synced history.
- **No CI traces appear.** Traces are written when a run or job finishes, so a run in progress has none yet. Check that **CI traces** is on under **Integrations → GitHub**. If finished runs are still missing, open the [GitHub App settings](https://github.com/settings/installations) and accept any pending permission request from the Maple app.
- **`search_source_code` finds nothing.** GitHub code search indexes only the default branch and matches whole tokens. Search for exact identifiers or exception text.

## Next steps

- [OpenTelemetry conventions](/docs/concepts/otel-conventions): the `vcs.*` resource attributes Maple reads.
- [MCP server](/docs/reference/mcp): connect an assistant and use the source code tools.
- [Traces](/docs/explore/traces): where commit context appears.
