# Per-PR Tinybird branches

Every PR preview deploy gets its own **ephemeral Tinybird branch** so changes can be tested
against realistic data without touching production. The branch is created on PR open, refreshed on
each push, and removed when the PR closes.

## How it works

The PR-preview pipeline (`.github/workflows/deploy-pr-preview.yml`) wraps the existing Alchemy
deploy with two extra steps backed by `scripts/tinybird-pr-branch.ts`:

1. **`up <pr>`** (on `opened` / `synchronize` / `reopened`)
    - `tb branch create pr_<n> --last-partition` — creates the branch with the latest production
      partition of each datasource. Idempotent: re-running on a new commit reuses the branch.
    - `tb --branch=pr_<n> deploy` — deploys _this PR's_ datasources/materialized views into the
      branch.
    - Resolves the branch's admin token and writes `TINYBIRD_HOST` / `TINYBIRD_TOKEN` to
      `$GITHUB_ENV`, **overriding** the Infisical `preview` values for the steps that follow.
2. **`alchemy:deploy:pr`** then binds the whole preview stack (api / web / alerting / chat-agent
   and, if pointed at it, the Rust ingest gateway) to the branch — no app code changes, because
   every `alchemy.run.ts` already reads `TINYBIRD_HOST` / `TINYBIRD_TOKEN` from `process.env`
   (see `apps/api/src/lib/Env.ts`, used in `apps/api/src/lib/WarehouseQueryService.ts`).
3. **`down <pr>`** (on `closed`, after `alchemy:destroy:pr`) — `tb branch rm pr_<n> --yes`.

## `--last-partition` behavior

`--last-partition` references the latest active partition via ClickHouse immutable parts (no full
copy). Partitions **under 50 GB attach**; datasources with larger partitions are created **empty**
in the branch. To add more data to a branch, use the in-app demo seed (`POST /demo/seed`,
`apps/api/src/services/DemoService.ts`) or point ingest at the branch.

## Caveats

- **Branches share compute with production.** That's why teardown on PR close is mandatory and we
  scope branches to the open-PR set. Avoid leaving stray branches around.
- Requires a Tinybird plan that supports branches.
- The Infisical `preview` environment's `TINYBIRD_HOST` / `TINYBIRD_TOKEN` must be the **parent workspace
  admin** host+token — the script uses them to create the branch before swapping in the branch's
  own credentials.
- If the CLI's `token ls` output can't be parsed for the admin token, pin it explicitly with the
  `TB_BRANCH_ADMIN_TOKEN_NAME` env var.

## Doing it manually

```bash
# create with recent prod data, then deploy this checkout's schema into it
tb --cloud branch create pr_123 --last-partition
tb --cloud --branch=pr_123 deploy

tb --cloud branch ls            # list branches
tb --cloud --branch=pr_123 open # open the branch in the Tinybird UI

tb --cloud branch rm pr_123 --yes   # tear it down
```
