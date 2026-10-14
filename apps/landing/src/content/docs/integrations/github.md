---
title: "GitHub"
description: "Install the Maple GitHub App to sync repositories and commit history, resolve commit SHAs in your telemetry, and give the MCP server read access to your source code."
group: "Integrations"
order: 4
---

The Maple GitHub App syncs your repositories and their commit history into Maple. You install the app, choose which repositories to share, and pick one branch to track per repository. Maple backfills the last 90 days of commits on that branch and keeps it current through GitHub webhooks.

Once connected, the integration does two things:

- **Commit context in telemetry.** When your services report the `vcs.ref.head.revision` resource attribute, Maple resolves the SHA against synced commits. The trace view and service pages show a commit hover card with the author, message, and a link to GitHub.
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
- **`search_source_code` finds nothing.** GitHub code search indexes only the default branch and matches whole tokens. Search for exact identifiers or exception text.

## Next steps

- [OpenTelemetry conventions](/docs/concepts/otel-conventions): the `vcs.*` resource attributes Maple reads.
- [MCP server](/docs/reference/mcp): connect an assistant and use the source code tools.
- [Traces](/docs/explore/traces): where commit context appears.
