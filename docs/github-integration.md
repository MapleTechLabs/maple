# GitHub Integration

Maple resolves the `deployment.commit_sha` attribute on incoming spans into rich commit metadata (author, message, avatar, GitHub deep link) by syncing commits from connected GitHub repositories. This document covers the one-time operator setup required to enable the integration.

## How it works

- A **GitHub App** is registered against your GitHub organization (or a personal account, or your GitHub Enterprise Server instance).
- End users in your Maple workspace **install** the App on one or more GitHub orgs / users from the **Settings → Integrations** page.
- The Maple API mints short-lived **installation tokens** (1h, RS256-signed JWT exchange) per installation to call the GitHub REST API.
- On install, Maple **backfills 90 days of commits** from each connected repository's default branch via a Cloudflare Queue worker.
- A GitHub **webhook** delivers `push`, `installation`, and `installation_repositories` events to the API, which enqueues sync jobs for each event.
- A **6-hour cron trigger** reconciles every active installation (catches missed webhooks, refreshes repo lists, updates installation metadata).
- The Settings UI surfaces installation status, per-repo sync toggles, and a manual backfill button.

## Infrastructure

The integration's Cloudflare infrastructure (queue, cron trigger, env-var bindings) is fully declared in `apps/api/alchemy.run.ts`. Running `alchemy deploy` provisions everything idempotently — no manual `wrangler queues create` step required. Local dev (`bun dev`) uses miniflare's built-in queue simulator from `wrangler.jsonc`.

## Required setup (one-time, operator)

### 1. Register a GitHub App

Cloud Maple users skip this step — the Maple-owned App is already published.

Self-hosted operators register their own App so the install flow and webhook callbacks point at their own deployment:

1. Navigate to <https://github.com/settings/apps/new> (or your GitHub Enterprise Server's equivalent).
2. Configure the App:
   - **GitHub App name**: e.g. `maple-yourcompany`. This becomes the slug in the install URL.
   - **Homepage URL**: your Maple base URL (e.g. `https://app.your-domain.com`).
   - **Callback URL**: leave empty (we do not use OAuth user auth).
   - **Setup URL**: `https://app.your-domain.com/api/integrations/github/callback` and check **Redirect on update**. This is where GitHub redirects users after they pick repos to install on.
   - **Webhook URL**: `https://app.your-domain.com/api/webhooks/github`.
   - **Webhook secret**: generate a random 32+ character string. You will set this as `GITHUB_APP_WEBHOOK_SECRET` below.
3. Set **repository permissions**:
   - `Metadata` → Read-only (required)
   - `Contents` → Read-only (required, lets us list commits)
   - `Pull requests` → Read-only (groundwork — used in a future release to attach PR numbers to commits)
   - `Members` → Read-only (used for author avatar fallback when the commit author is a private org member)
4. Subscribe to the following **webhook events** (check the boxes under "Subscribe to events"):
   - `Push` (required — drives the new-commit hot path)
   - `Release` (groundwork — payloads accepted but not processed in v1)
   - `Pull request` (groundwork — accepted but not processed in v1)

   You do **not** need to subscribe to `installation` or `installation_repositories` — those are App lifecycle events that GitHub delivers to every GitHub App automatically, regardless of subscription. The webhook handler processes them either way.
5. **Where can this GitHub App be installed?** — Choose "Any account" so any of your customers' orgs (or for self-hosted, any of your own orgs) can install it.
6. Click **Create GitHub App**, then:
   - Note the **App ID** and **App slug** (visible at the top of the settings page).
   - Click **Generate a private key** at the bottom of the page. GitHub downloads a `.pem` file.

### 2. Set env vars

Five env vars need to be set on the API worker:

```bash
# Numeric, from the App settings page
wrangler secret put GITHUB_APP_ID --env production

# The lowercase URL-safe slug (e.g. "maple-yourcompany"). Used to construct
# https://github.com/apps/<slug>/installations/new
wrangler secret put GITHUB_APP_SLUG --env production

# The PEM file you downloaded. CRITICAL: pipe the file directly to avoid the
# Cloudflare dashboard collapsing newlines.
cat path/to/maple-yourcompany.private-key.pem | wrangler secret put GITHUB_APP_PRIVATE_KEY --env production

# The webhook secret you generated in step 1.
wrangler secret put GITHUB_APP_WEBHOOK_SECRET --env production
```

Two optional env vars override the GitHub API host (for GitHub Enterprise Server):

```bash
# Defaults to https://api.github.com
GITHUB_API_BASE_URL=https://github.your-ghes.com/api/v3

# Defaults to https://github.com — used to construct the install URL and the
# "uninstall on GitHub" link shown after disconnect.
GITHUB_APP_BASE_URL=https://github.your-ghes.com
```

### 3. Verify

1. Open Maple → Settings → Integrations. The **GitHub** card shows "Not connected" but the **Connect GitHub** button is enabled (it disables if env vars are missing, with an inline banner listing what's missing).
2. Click **Connect GitHub** → a popup opens `https://github.com/apps/<slug>/installations/new?state=…`.
3. Pick an org/user account and choose which repositories to grant access to (you can pick "All repositories" or specific ones).
4. After install, GitHub redirects to your Setup URL, the popup auto-closes, and the Settings UI refreshes to show your installation with its repository list.
5. Within ~30 seconds the **backfill_status** column transitions from `pending` → `running` → `complete`. You can refresh manually with the **Backfill** button per repo.

## What gets synced

For each connected repo:

| Action | Trigger |
|---|---|
| Backfill last 90 days of default-branch commits | Repo first connected / **Backfill** button |
| New commits from any branch | GitHub `push` webhook |
| Refresh installation metadata + repo list | `installation` / `installation_repositories` webhooks + 6h cron |
| Resolve unknown SHAs surfaced in traces | First hover on an unresolved commit chip (debounced, tombstoned after 3 failures) |

Commits live in the `github_commits` table in the operational D1 database. The schema is keyed on `(org_id, sha)` so each Maple org has its own commit rows — no cross-tenant data sharing.

## Multi-installation, multi-org

A single Maple org can install the App on multiple GitHub accounts (e.g. your main org plus your contractors' orgs). Each installation is a separate row in `github_installations`. Click **Add another GitHub installation** in the Settings UI to kick off another install flow.

## Disconnecting

The **Disconnect** button on each installation:
- Marks the installation as suspended in Maple (no further syncs).
- Shows a follow-up toast linking to `https://github.com/settings/installations/<id>` where the user can fully uninstall the App on GitHub's side.
- Does **not** delete historical commit rows — traces referencing those SHAs continue to render with enriched data.

## Troubleshooting

**"GitHub App not configured on this Maple instance"** — one or more env vars are missing. The banner lists which.

**Webhook deliveries return 401** — `GITHUB_APP_WEBHOOK_SECRET` doesn't match what's set in the App settings page. Check `wrangler tail` and re-set the secret.

**Backfill status stuck on `running`** — After 5 retries, the queue drops the message. Recovery paths: the 6h `ReconcileInstallation` cron re-runs the install reconcile, and the per-repo Backfill button in the UI re-enqueues a fresh job. Check `wrangler tail` during the retry window for the `[github-sync] job failed, will retry` log line that shows the underlying error (usually rate-limiting or a revoked installation token — the user can reconnect).

**Commits not resolving despite repo being connected** — the commit may be on a branch that hasn't been pushed since connect. Wait for the next `push` event, click **Backfill** on the repo, or hover the unresolved SHA to trigger an on-demand resolve.

## Future work (groundwork in place, not yet active)

- **GitHub Releases**: the `github_releases` table exists and the `release` webhook is subscribed. Sync logic + UI to follow.
- **PR enrichment**: `github_commits.pr_number` column is populated by the resync path when GitHub returns it. UI surfacing is pending.
