# Per-PR Tinybird branches

Every PR preview deploy gets its own **empty ephemeral Tinybird branch** so schema changes can be
deployed and exercised without touching production. The branch is created on PR open, refreshed on
each push, and removed when the PR closes.

Branches carry **no production data**. They used to be created with `--last-partition`, which
attached the latest production partition of every datasource — live customer telemetry, in an
environment readable by anyone with the preview URL and retained until a best-effort teardown
removed it. A preview that needs rows seeds its own (see [Getting data in](#getting-data-in)).

## How it works

The PR-preview pipeline (`.github/workflows/deploy-pr-preview.yml`) wraps the existing Alchemy
deploy with two extra steps backed by `scripts/tinybird-pr-branch.ts`:

1. **`up <pr>`** (on `opened` / `synchronize` / `reopened`)
    - `tb branch create pr_<n>` — creates the branch empty. Idempotent: re-running on a new commit
      reuses the branch.
    - `tb --branch=pr_<n> deploy` — deploys _this PR's_ datasources/materialized views into the
      branch.
    - Resolves the branch's admin token and writes `TINYBIRD_HOST` / `TINYBIRD_TOKEN` to
      `$GITHUB_ENV`, **overriding** the Infisical `dev` values for the steps that follow.
2. **`alchemy:deploy:pr`** then binds the whole preview stack (api / web / alerting / chat-agent
   and, if pointed at it, the Rust ingest gateway) to the branch — no app code changes, because
   every `alchemy.run.ts` already reads `TINYBIRD_HOST` / `TINYBIRD_TOKEN` from `process.env`
   (see `apps/api/src/lib/Env.ts`, used in `apps/api/src/lib/WarehouseQueryService.ts`).
3. **`down <pr>`** (on `closed`, after `alchemy:destroy:pr`) — `tb branch rm pr_<n> --yes`.

## Getting data in

A fresh branch has the PR's schema and no rows, so charts render empty until you seed it:

- **Demo seed** — the internal `demo.seed` route (`apps/api/src/routes/internal/demo.http.ts`,
  backed by `packages/backend/src/services/org/DemoService.ts`) writes synthetic
  services, routes and queries into the branch. Enough for most UI and query work.
- **Point ingest at the branch** — send real OTLP traffic from a local collector or
  `bun scripts/ingest-dummy-traces.ts`, which generates synthetic spans.

Neither path uses customer data. If a change can only be validated against production cardinality,
benchmark it against production instead (`apps/api/scripts/BENCH.md`) rather than copying rows into
a preview.

## Caveats

- **Branches share compute with production.** That's why teardown on PR close is mandatory and we
  scope branches to the open-PR set. Avoid leaving stray branches around.
- Requires a Tinybird plan that supports branches.
- The Infisical `dev` environment's `TINYBIRD_HOST` / `TINYBIRD_TOKEN` must be the **parent workspace
  admin** host+token — the script uses them to create the branch before swapping in the branch's
  own credentials.
- If the CLI's `token ls` output can't be parsed for the admin token, pin it explicitly with the
  `TB_BRANCH_ADMIN_TOKEN_NAME` env var.

## Doing it manually

```bash
# create empty, then deploy this checkout's schema into it
tb --cloud branch create pr_123
tb --cloud --branch=pr_123 deploy

tb --cloud branch ls            # list branches
tb --cloud --branch=pr_123 open # open the branch in the Tinybird UI

tb --cloud branch rm pr_123 --yes   # tear it down
```
