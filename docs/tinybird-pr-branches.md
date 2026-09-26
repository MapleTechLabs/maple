# Per-PR Tinybird branches

Every PR preview deploy gets its own **empty ephemeral Tinybird branch**, so schema changes can be
deployed and exercised without touching production. The branch is created on PR open, refreshed on
each push, and removed when the PR closes.

Branches carry **no production data**. They used to be created with `--last-partition`, which
attached the latest production partition of every datasource. That put live customer telemetry in
an environment readable by anyone with the preview URL, retained until a best-effort teardown
removed it. A preview that needs rows seeds its own (see [Getting data in](#getting-data-in)).

## How it works

The PR-preview pipeline (`.github/workflows/deploy-pr-preview.yml`) wraps the Alchemy deploy with
two extra steps backed by `scripts/tinybird-pr-branch.ts`:

1. **`up <pr>`** (on `opened` / `synchronize` / `reopened`)
    - `tb branch create pr_<n>` creates the branch empty. Idempotent: re-running on a new commit
      reuses the branch.
    - Reads the branch's own admin token from the environments API (`GET /v1/environments`,
      authorized by the parent workspace token).
    - `tb deploy --allow-destructive-operations`, run as the branch token, deploys _this PR's_
      datasources and materialized views into the branch.
    - Writes `TINYBIRD_HOST` / `TINYBIRD_TOKEN` to `$GITHUB_ENV`, **overriding** the Infisical
      `dev` values for the steps that follow. The host stays the parent's; the branch token does
      the routing.
2. **`alchemy:deploy:pr`** then binds the whole preview stack (the Workers and the Rust ingest
   gateway) to the branch with no app code changes, because the stack reads `TINYBIRD_HOST` /
   `TINYBIRD_TOKEN` from the deploy env (`packages/infra/src/env.ts`) and the runtime reads them
   through `packages/backend/src/platform/Env.ts`.
3. **`down <pr>`** (on `closed`, after `alchemy:destroy:pr`) runs `tb branch rm pr_<n> --yes`.

The close-event teardown is best effort. The scheduled `cleanup-preview-orphans.yml` workflow runs
`bun scripts/tinybird-pr-branch.ts sweep`, which removes every `pr_<n>` branch whose PR is closed.

Every `tb` call in the script is `tb --cloud --host … --token …`, never `--branch=`. The CLI
resolves `--branch=` through the user-workspaces endpoint, which lists branches only for a human
login token, so under a workspace token every branch is "not found".

## Getting data in

A fresh branch has the PR's schema and no rows, so charts render empty until you seed it:

- **Demo seed.** The internal `demo.seed` route (`apps/api/src/routes/internal/demo.http.ts`,
  backed by `packages/backend/src/services/org/DemoService.ts`) writes synthetic services, routes
  and queries into the branch. Enough for most UI and query work.
- **Point ingest at the branch.** Send real OTLP traffic from a local collector, or run
  `bun scripts/ingest-dummy-traces.ts`, which generates synthetic spans.

Neither path uses customer data. If a change can only be validated against production cardinality,
benchmark it against production instead (`apps/api/scripts/BENCH.md`, `docs/query-benchmarking.md`)
rather than copying rows into a preview.

## Caveats

- **Branches share compute with production.** That is why teardown on PR close is mandatory and
  branches are scoped to the open-PR set. Do not leave stray branches around.
- Requires a Tinybird plan that supports branches.
- The Infisical `dev` environment's `TINYBIRD_HOST` / `TINYBIRD_TOKEN` must be the **parent
  workspace admin** host and token. The script uses them to create the branch and read its token
  before swapping in the branch's own credentials.

## Doing it manually

`--branch=` works only when the CLI is logged in as a person (`tb login`), not with a workspace
token.

```bash
# create empty, then deploy this checkout's schema into it
tb --cloud branch create pr_123
tb --cloud --branch=pr_123 deploy

tb --cloud branch ls            # list branches
tb --cloud --branch=pr_123 open # open the branch in the Tinybird UI

tb --cloud branch rm pr_123 --yes   # tear it down
```
