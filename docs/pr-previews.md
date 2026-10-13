# PR previews

A PR carrying the `preview` label gets the whole Maple stack as alchemy stage `pr-<n>`, torn down
when the label comes off or the PR closes (`.github/workflows/deploy-pr-preview.yml`).

## What a preview runs

| Piece                                                   | Where                                                  | Notes                                                                                  |
| :------------------------------------------------------ | :----------------------------------------------------- | :------------------------------------------------------------------------------------- |
| web, api, ai, alerting, chat-bot, electric-sync Workers | `app-pr-<n>`, `api-pr-<n>`, `sync-pr-<n>` `.maple.dev` | Clerk development instance                                                             |
| Postgres                                                | Neon branch `pr-<n>` of `NEON_PROJECT_ID`              | Migrated by the deploy (`declarePreviewDb` in `alchemy.run.ts`), deleted on destroy    |
| Hyperdrive                                              | `maple-db-pr-<n>`, shared by every Worker              | One of the account's 25 configs, hence the live-preview cap                            |
| Warehouse                                               | Tinybird branch `pr_<n>`                               | Empty; `scripts/tinybird-pr-branch.ts` swaps host, token, signing key and workspace id |
| Ingest gateway                                          | `ingest-pr-<n>.maple.dev` (ECS on EC2)                 | Reads ingest keys from the preview's own branch                                        |
| Electric                                                | `electric-pr-<n>.maple.dev` (ECS Fargate)              | Replicates from the branch; electric-sync points at it                                 |
| Landing, local-ui                                       | `landing-pr-<n>.maple.dev`                             |                                                                                        |

Not in a preview: the repository sandbox (`sandbox_*` tools report unavailable), chat
connectors (no webhook hostname; a socket would fight dev's bot), and OAuth / GitHub App
callbacks, which are registered for fixed hosts.

The app's own browser telemetry still goes to the shared ingest (`VITE_MAPLE_SELF_INGEST_URL`);
setup snippets and connect flows hand out the preview's gateway.

## After the deploy

`scripts/preview-seed-smoke.ts` signs in as the dev test user, seeds demo telemetry into its
org through the preview's API, and fails the job if a Postgres- or warehouse-backed route
returns a 5xx. The PR comment reports the outcome.

## Limits and cost

- At most `MAX_LIVE_PREVIEWS` (8) open PRs may carry `preview`; the deploy refuses the next one.
- A preview runs an EC2 host, two ALBs and a Fargate task while it is live. Neon compute stays
  awake while Electric holds its replication slot.
- `cleanup-preview-orphans.yml` destroys the stage of any closed PR whose resources are still
  around (`scripts/preview-stage-orphan-sweep.ts`), then sweeps Tinybird, Workers and Hyperdrive.

## One-time setup

1. **Neon project.** Create a project (US East, Postgres 17) whose default branch stays empty,
   and enable logical replication on it (Settings, Logical replication). Electric needs it,
   and the owner role only gets `REPLICATION` once it is on.
2. **Infisical** (the preview environment, `dev` unless `PREVIEW_INFISICAL_ENV_SLUG` says
   otherwise): `NEON_API_KEY` (an org or project API key) and `NEON_PROJECT_ID`.
3. **AWS.** The deploy role must trust `repo:MapleTechLabs/maple:environment:pr-preview`.
4. Optional: a dedicated Infisical environment for previews, then set the repo variable
   `PREVIEW_INFISICAL_ENV_SLUG`, so previews stop sharing every `dev` credential.

## Debugging

- Plan locally: `CI=true AWS_ACCOUNT_ID=<id> PR_NUMBER=<n> infisical run --env dev -- bun node_modules/alchemy/bin/alchemy.ts plan --stage pr-<n>`
  with `aws configure export-credentials --profile maple --format env` in the environment.
- Destroy by hand: the same with `bun run alchemy:destroy:pr`. State is the shared Cloudflare
  store, so a local run sees CI's stack.
