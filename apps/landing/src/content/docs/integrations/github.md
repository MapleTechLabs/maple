---
title: "GitHub"
description: "Install the Maple GitHub App to sync repositories and commit history from your org — one tracked branch per repo, backfilled and kept live via webhooks, so commits show up alongside your traces."
group: "Integrations"
order: 3
---

Maple ships a GitHub App that syncs your repositories and their commit history into Maple. Once connected, Maple backfills recent commits, stays current through GitHub webhooks, and links commit SHAs to the traces and services they appear in — so you can see which change a span came from without leaving the dashboard. There is nothing to run on your side: you install the app, pick which repositories to share, and Maple does the rest in the background.

## 1. Connect your GitHub account

Open **Integrations → GitHub** in the Maple dashboard and click **Connect GitHub**. A popup walks you through installing the **Maple GitHub App** on a personal account or organization. During install you choose the scope:

- **All repositories** — Maple syncs every repository the account can access, including ones added later.
- **Only select repositories** — Maple syncs only the repositories you pick. You can change the selection any time from GitHub.

When the install completes the popup closes and the card flips to **Connected**, showing the account it's installed on and your repository scope. Maple immediately begins discovering repositories and enqueues a backfill for each — the card polls and updates as repositories move from **Queued** to **Syncing** to **Synced**.

## 2. Pick a tracked branch per repository

Each repository tracks exactly **one** branch — seeded to the repo's default branch — and Maple syncs commits only from that branch. Use the **branch** selector on a repository row to track a different branch.

Changing the tracked branch is **destructive**: Maple deletes the repo's currently synced commits and re-syncs the last 90 days from the new branch. The dashboard confirms before applying the change, and the row reflects the re-sync as it runs.

## What you get

- **90-day backfill.** On connect — and whenever you switch the tracked branch — Maple backfills the last 90 days of commits on the tracked branch.
- **Live updates via webhooks.** Pushes to a tracked branch are ingested in near real time. Force-pushes (history rewrites) are reconciled, and installation changes — repositories added, removed, or the app suspended — are picked up automatically.
- **A periodic safety net.** A scheduled job reconciles every installation every 12 hours, so the repository list and commit history stay correct even if a webhook is missed.
- **Commits linked to telemetry.** Synced commit SHAs are resolved across Maple — most visibly in trace detail and service views, where a commit hover card surfaces the author, message, and link back to GitHub.

## Repository and account management

- **Sync status per repo.** Each repository shows **Synced**, **Syncing**, **Queued**, or **Sync failed**, with the last successful sync time (or the error message on failure).
- **Removed repositories are kept.** If you revoke Maple's access to a repository in GitHub, it moves to a **Needs attention** list and its already-synced commit history is retained. Re-enable it in the [Maple GitHub App settings](https://github.com/settings/installations) to resume syncing, or **Delete** it from Maple to permanently remove its synced commits.
- **Manage** reopens the GitHub App install screen so you can add or remove repositories.
- **Disconnect** removes the integration from Maple.

## Troubleshooting

- **A repo is stuck on Syncing or shows Sync failed** — click **Refresh**. Failed backfills are retried automatically; a terminal failure surfaces the underlying error (most often a GitHub rate limit, which Maple retries once the budget resets, or revoked access).
- **No repositories appear after connecting** — discovery and the first backfill run in the background and can take a moment; the card polls and fills in as they complete.
- **Commits aren't showing up for a repo** — confirm the **tracked branch** is the one your commits land on. Only the tracked branch is synced.
- **A repository is in "Needs attention"** — GitHub revoked access to it. Re-enable it in the [GitHub App settings](https://github.com/settings/installations) to resume syncing.
