# PR previews

A PR carrying the `preview` label gets the whole Maple stack as alchemy stage `pr-<n>`, torn down
when the label comes off or the PR closes (`.github/workflows/deploy-pr-preview.yml`).

## What a preview runs

| Piece                                                   | Where                                                  | Notes                                                                                  |
| :------------------------------------------------------ | :----------------------------------------------------- | :------------------------------------------------------------------------------------- |
| web, api, ai, alerting, chat-bot, electric-sync Workers | `app-pr-<n>`, `api-pr-<n>`, `sync-pr-<n>` `.maple.dev` | Clerk development instance                                                             |
| Postgres                                                | Neon branch `pr-<n>` of `NEON_PROJECT_ID`              | Migrated by the deploy (`declarePreviewDb` in `alchemy.run.ts`), deleted on destroy    |
| Hyperdrive                                              | `maple-db-pr-<n>`, shared by every Worker              | One of the account's 25 configs                                                        |
| Warehouse                                               | Tinybird branch `pr_<n>`                               | Empty; `scripts/tinybird-pr-branch.ts` swaps host, token, signing key and workspace id |
| Ingest gateway                                          | `ingest-pr-<n>.maple.dev` (ECS on EC2)                 | Reads ingest keys from the preview's own branch                                        |
| Electric                                                | `electric-pr-<n>.maple.dev` (ECS Fargate)              | Replicates from the branch; electric-sync points at it                                 |
| Landing, local-ui                                       | `landing-pr-<n>.maple.dev`                             |                                                                                        |

Not in a preview: the repository sandbox (`sandbox_*` tools report unavailable), chat
connectors (no webhook hostname; a socket would fight dev's bot), and OAuth / GitHub App
callbacks, which are registered for fixed hosts.

The app's own browser telemetry still goes to the shared ingest (`VITE_MAPLE_SELF_INGEST_URL`);
setup snippets and connect flows hand out the preview's gateway.

## Web-only previews (`preview:web`)

For UI work that does not need ingest, label the PR `preview:web` instead. It deploys the
Workers (web, api, ai, alerting, chat-bot, electric-sync) on the same Neon and Tinybird
branches, seeded and smoke-tested the same way, but creates nothing on AWS: no ingest gateway, no
Electric (live sync stays off), no landing or local-ui. It holds no VPC, so it does not count
against `MAX_LIVE_PREVIEWS`, and deploys faster. Its only data is the seed: setup snippets
point at the shared ingest, which cannot see the preview's ingest keys, so connect flows and
test events do not reach it. Use `preview` to test ingest.

`preview` wins when both labels are on. Removing one while the other stays redeploys in the
remaining mode; removing the last one tears the stage down.

## Signing in

Previews run Clerk's development instance, where reviewers have no account and the OAuth
buttons lead nowhere useful. The sign-in page on a preview shows a **PR preview** form: the
shared access key `PREVIEW_SIGNIN_KEY` (Infisical) buys a single-use Clerk sign-in ticket for
`preview-reviewer+clerk_test@maple.dev`, a user created on first use with its own `Preview` org,
apart from anyone's dev account. From a terminal:

```bash
infisical run --env dev -- bun run preview:signin <pr>
```

prints a signed-in link. The endpoint (`/api/auth/preview/sign-in`, `PreviewSignInService`)
answers 404 unless the API runs on a `pr-<n>` stage with an `sk_test_` Clerk key and the access
key bound, and alchemy binds the key on PR stages only. The repo is public, so the key never
goes in the PR comment; rotate it in Infisical if it leaks.

## After the deploy

`scripts/preview-seed-smoke.ts` calls the preview sign-in endpoint (which provisions the
reviewer and its org), seeds demo telemetry into the reviewer's org through the preview's API,
and fails the job if a Postgres- or warehouse-backed route returns a 5xx. Without
`PREVIEW_SIGNIN_KEY` it seeds the dev test user instead. The PR comment reports the outcome.

## Limits and cost

- At most `MAX_LIVE_PREVIEWS` (3) open PRs may carry `preview`; the deploy refuses the next one.
  `MAX_TOTAL_PREVIEWS` (8) caps both labels together: every preview takes 1 of the account's
  25 Hyperdrive configs.
  Each preview's ingest needs a VPC in the prd AWS account, and us-east-1 allows 5: the default
  VPC and prd hold 2.
- A preview runs an EC2 host, two ALBs and a Fargate task while it is live. Neon compute stays
  awake while Electric holds its replication slot.
- `cleanup-preview-orphans.yml` sweeps Tinybird, destroys the stage of any PR that is closed or
  carries neither `preview` nor `preview:web` (`scripts/preview-stage-orphan-sweep.ts`), then sweeps Queues,
  Workers and Hyperdrive. That also reaps a stage whose teardown was cancelled. A stage with a
  queued or running preview deploy is skipped until the next sweep.

## One-time setup

1. **Neon project.** Create a project (US East, Postgres 17) whose default branch stays empty,
   and enable logical replication on it (Settings, Logical replication). Electric needs it,
   and the owner role only gets `REPLICATION` once it is on.
2. **Infisical** (the preview environment, `dev` unless `PREVIEW_INFISICAL_ENV_SLUG` says
   otherwise): `NEON_API_KEY` (an org or project API key), `NEON_PROJECT_ID`, and
   `PREVIEW_SIGNIN_KEY` (any long random string, e.g. `openssl rand -base64 24`).
3. **AWS.** The deploy role must trust `repo:MapleTechLabs/maple:environment:pr-preview`.
4. Optional: a dedicated Infisical environment for previews, then set the repo variable
   `PREVIEW_INFISICAL_ENV_SLUG`, so previews stop sharing every `dev` credential.

## Debugging

- Plan locally: `CI=true AWS_ACCOUNT_ID=<id> PR_NUMBER=<n> infisical run --env dev -- bun node_modules/alchemy/bin/alchemy.ts plan --stage pr-<n>`
  with `aws configure export-credentials --profile maple --format env` in the environment.
- Destroy by hand: the same with `bun run alchemy:destroy:pr`. State is the shared Cloudflare
  store, so a local run sees CI's stack.
