# EU region: plan

Goal: a customer whose contract says their data never leaves the EU can run on Maple. That is a
full EU instance under `*.eu.maple.dev`: EU ingest, EU Tinybird, EU Postgres, and every Worker
that touches customer data executing in the EU. An org's region is the instance it was created on.

This replaced an earlier draft that shared the control plane and routed per org. That shape kept
issue metadata and Worker execution in the US, which is fine under a DPA that says so, and is not
fine for a customer who requires all processing in the EU. The full instance is also less code:
there is no per-org routing anywhere, because each instance knows exactly one region.

## Where we start (2026-09-16)

- Prod reads and writes go to the `maple_us` Tinybird workspace in AWS us-east-1. The old
  `api.tinybird.co` workspace is GCP Frankfurt and is being wound down. It is not the EU target.
- The ingest gateway (`apps/ingest`) runs on ECS Fargate in us-east-1. Region already exists as a
  deploy-time axis: `MapleRegion` in `packages/infra/src/aws/stage.ts` maps `eu` to eu-central-1
  and its own CIDR, resource names take a region suffix with `us` unsuffixed, and the root
  `alchemy.run.ts` reads `MAPLE_REGION` and guards it against `AWS_REGION`.
- The Cloudflare half of the stack does not honour the region: `resolveWorkerName` and
  `resolveMapleDomains` in `packages/infra/src/cloudflare/stage.ts` know only stage, and
  `CLOUDFLARE_WORKER_PLACEMENT` is a constant `aws:us-east-1`.
- Every Worker binds one `MAPLE_DB` Hyperdrive, one Tinybird host, one replay bucket. There is no
  per-org region anywhere, and after this plan there still is none.
- The web app is a SPA. Its Worker serves assets; the browser calls the API directly. The only
  server-side data paths in the web Worker are OG images and share-link previews.

## What "never leaves the EU" touches

| System | Today | EU instance |
| --- | --- | --- |
| Ingest gateway + OTel collector | ECS us-east-1 | ECS eu-central-1 |
| Tinybird | `maple_us`, us-east-1 | `maple_eu`, AWS eu-central-1 |
| Postgres | PlanetScale `maple`, US, dashboard Hyperdrive configs | PlanetScale `maple-eu`, eu-central, roles and Hyperdrive configs declared by the deploy |
| Electric | ECS us-east-1 | ECS eu-central-1, in the EU ingest VPC |
| api / ai / alerting / electric-sync / web Workers | placement us-east-1 | placement eu-central-1 (best effort, see risks) |
| `ChatSession` Durable Object | no jurisdiction | `jurisdiction: "eu"` |
| Replay blobs | R2, non-jurisdictional | R2, `jurisdiction: "eu"` |
| Queues, Workflows | no jurisdiction control | see risks |
| Clerk | one US instance | same instance, `app.eu.maple.dev` as a satellite domain |
| AI features | OpenRouter, Workers AI | OpenRouter EU in-region endpoint (`eu.openrouter.ai`) |
| Maple self-telemetry | US internal org | EU internal org, in `maple_eu` |
| Repository sandbox (`apps/sandbox`) | prd Worker, US | per instance, EU Worker |
| Landing, billing | shared | shared, no customer data |
| GitHub App, chat connector apps | US apps | EU apps of their own, see Phase 0 step 8 |
| OAuth clients (Cloudflare, PlanetScale, Hazel) | US redirect URIs | same clients, EU redirect URIs added |
| Scraper (Railway) | US service | EU service of its own |

The landing site stays one site. Billing metadata is not customer telemetry. The GitHub App was
first listed here as shared, which does not work: an App has one webhook URL and one post-install
callback, both on `api.maple.dev`, so an EU install lands on the US API (whose database has no
connect session for it) and EU repositories' push and pull request events are delivered to the US.

The sandbox clones the customer's repository, so it deploys per instance from day one:
`stageDeploysSandbox` already gates it to prd, and the EU deploy is prd with `MAPLE_REGION=eu`, so the only work is the region-suffixed name. Cloudflare's Sandbox container
has no jurisdiction setting, so it sits under the same best-effort placement as the Workers.

## Why `app.eu.maple.dev` and not a shared app

A shared `app.maple.dev` calling a regional API is possible, since the web Worker holds no
customer data. It buys one login URL for a customer with orgs in both regions. It costs runtime
region lookups for the API, sync and ingest URLs, an exception for the OG and share paths, webhook
filtering on both instances, and a compliance story with an asterisk. With `app.eu.maple.dev` the
region is the hostname, the application code has no region logic, and a routing bug cannot leak
across regions because there is no routing.

## Phase 0. Accounts (no code)

1. **Tinybird**: `maple_eu` on `https://api.eu-central-1.aws.tinybird.co`. AWS eu-central-1, not
   GCP Frankfurt: same-region egress is $0.01/GB against $0.09/GB, and export egress is the ingest
   bill. Deploy the schema with the local recipe used for `maple_us`.
2. **Three Tinybird tokens, three roles**: workspace admin token as `TINYBIRD_SIGNING_KEY`, a scoped
   runtime read token as `TINYBIRD_TOKEN`, an append-only token for the gateway. Sign a throwaway
   JWT to prove the signing key before trusting it (the 2026-09-04 incident).
3. **PlanetScale**: the `maple-eu` database in eu-central, empty, on a cluster size whose
   `max_connections` seats the instance: Electric's default pool (20) plus its replication
   connection, the two declared Hyperdrive configs (`originConnectionLimit: 8` each, raise with
   the cluster), the gateway through PSBouncer and a few admin slots, so 50 or more. The size
   first chosen gave 25 and Electric crash-looped on `too_many_connections`. That is all: the
   deploy adopts
   its `main` branch and applies the migrations, and declares on it the gateway's role, Electric's
   replication role, one role per Worker consumer and a Hyperdrive config on each
   (`declareMapleDb` in `alchemy.run.ts`).
   The same PlanetScale service token serves both instances; `prod-eu` carries it under the
   same names.
4. **AWS**: eu-central-1 in the existing account. ACM certificates for `ingest.eu.maple.dev` and
   `electric.eu.maple.dev`.
5. **Cloudflare**: `replay-blobs-eu` with `jurisdiction: "eu"`. Regional Services would pin
   execution to EU data centres but is an Enterprise add-on and is out of reach for now; the EU
   Workers rely on placement, which is best effort. See risks for what that means and for the
   non-Enterprise upgrade path.
6. **Infisical**: a second environment, `prod-eu`, holding the same variable names with EU values.
   Same names is the point: the code reads one set, the deploy picks the environment.
7. **Clerk**: one instance. Add `app.eu.maple.dev` as a satellite domain of the production
   instance. Staff names and emails stay in the US; the DPA lists Clerk as a US subprocessor for
   account data only.
8. **Integrations.** Every callback Maple builds comes from the API's own origin, so the EU
   instance already asks providers to return to `api.eu.maple.dev`. What differs is what each
   provider has registered, plus one service that only the US runs:
    - **Per-request redirect URI** (the client sends it, the provider checks it against an
      allowlist). The US client is reusable; add the EU URL to its allowlist:
        - Cloudflare OAuth: `https://api.eu.maple.dev/api/integrations/cloudflare/callback`
        - PlanetScale OAuth: `https://api.eu.maple.dev/api/integrations/planetscale/callback`
        - Hazel OAuth: `https://api.eu.maple.dev/api/integrations/hazel/callback`
    - **One URL per app** (registered on the app, not sent per request). These need an EU app:
        - **GitHub App.** Register "Maple EU" per `docs/github-app-setup.md` with webhook
          `https://api.eu.maple.dev/api/integrations/github/webhook` and callback
          `https://api.eu.maple.dev/api/integrations/github/callback`, then replace all six
          `GITHUB_APP_*` values in `prod-eu`. A repository can then be installed on both Apps, one
          per instance, which is the point.
        - **Discord** (not configured on `prod-eu` yet). The install is the bot invite, and a bot
          token opens a Gateway session that receives every mention, so a shared application would
          have both instances answer. Create an EU application, register
          `https://api.eu.maple.dev/oauth/chat/discord/callback` on it, and set its
          `MAPLE_DISCORD_CLIENT_ID`, `MAPLE_DISCORD_CLIENT_SECRET` and `MAPLE_DISCORD_BOT_TOKEN`
          in `prod-eu` together.
    - **Scraper.** `apps/scraper` is one Railway service polling the US API's target list, so EU
      Prometheus and PlanetScale metrics targets are never scraped. Deploy a second service in an
      EU Railway region with `MAPLE_API_URL=https://api.eu.maple.dev`,
      `MAPLE_INGEST_URL=https://ingest.eu.maple.dev` and `prod-eu`'s `SD_INTERNAL_TOKEN`.

    Until the EU GitHub App exists, remove its keys from `prod-eu`: connecting then fails
    up front with "not configured" instead of sending the user through a flow that cannot finish.

## Phase 1. The stack honours the region on Cloudflare (built)

Built on the `worktree-eu-region` branch; `docs/infra.md` § Regions is the reference.

- The region rides on the alchemy stage string: `prd` is US, `prd-eu` is the EU instance.
  `parseMapleDeployment` in `packages/infra/src/cloudflare/stage.ts` is the one parser, and
  because alchemy keys its state by stage the two instances can never plan against each
  other's resources. `MAPLE_REGION` as a deploy env var is gone.
- `resolveWorkerName(base, stage, region)` and `resolveMapleDomains(stage, region)`; `us` stays
  unsuffixed so nothing in prod renames. EU prd domains: `app`, `api`, `ingest`, `sync`,
  `electric` under `eu.maple.dev`; no landing or local-ui (`regionHostsSharedApps`).
- `resolveWorkerPlacement(region)` replaces the placement constant.
- `resolveStorageJurisdiction(region)` pins the EU replay bucket to the `eu` jurisdiction at
  creation (a new bucket, never a replace) and the ingest gateway's writer token and S3 endpoint
  follow it. The chat Durable Object's jurisdiction is a property of the object id, so it is
  applied where ids are minted: `chatSessionStub` reads the stack-derived `MAPLE_REGION`.
- `MapleStack` carries `region`; every Worker module reads it from there. `appUrlsEnv` defaults
  to the deploy's own hostnames, so EU emails and share links point at the EU app.
- `resolveDatabaseMode(stage, region)` is `"declared"` for the EU prd: the Workers bind the
  Hyperdrive configs the deploy created, from their props, so there are no dashboard ids to
  paste and no way to deploy the instance with no `MAPLE_DB`. The US prd stays `"ref"`.
- `MAPLE_INTERNAL_ORG_ID` comes from the environment already, so the EU value is an org created
  on the EU instance.

## Phase 2. Deploy (built, opt-in)

- `deploy-prd-instance.yml` is the per-instance body; `deploy-prd.yml` calls it for `us` on
  every green CI run and for `eu` only while the `MAPLE_DEPLOY_EU` repository variable is `1`.
  One `region` input picks the stage, the `production` / `production-eu` GitHub environment,
  the `prod` / `prod-eu` Infisical environment and the AWS region; the composite action took an
  `aws-region` input for that, and the stack still refuses an `AWS_REGION` that disagrees.
- Still to do before flipping `MAPLE_DEPLOY_EU`: the `production-eu` GitHub environment, the
  `prod-eu` Infisical environment, and the empty `maple-eu` database.
- Tinybird schema deploys target `maple_us` and `maple_eu` (and GCP Frankfurt while it lives).
  `tinybird-cd.yml` is disabled, so this joins the manual checklist.
- The EU ingest fleet and Electric come out of the existing factories unchanged.

## Phase 3. Sign-up and the wrong door

- Landing sign-up gets a region choice, "United States" or "European Union", and sends the user
  to the matching app hostname. It is the only place a user meets the concept.
- On the wrong app, a signed-in user with no org sees one line naming the other region's URL,
  rather than the create-org flow. Cheap, and it removes the most likely support ticket.
- Settings shows the region read-only. Orgs do not move between instances in v1; a move is a
  Tinybird copy plus an R2 copy plus a Postgres export, and is its own project.
- Guided setup, credentials, SDK snippets and the install modal already print `ingestUrl` from
  build-time env, which the EU build sets to `ingest.eu.maple.dev`. No change.
- Docs and the CLI: the EU endpoint is documented; the CLI already accepts an endpoint override.

## Phase 4. AI features on OpenRouter's EU endpoint

Investigations, chat, the MCP agent tools and AI triage send spans and logs to model providers, so
the EU instance shipped with them off (#997). They are back on through OpenRouter's in-region
routing: with `MAPLE_REGION=eu`, `apps/ai/src/platform/Llm.ts` sends every chat, review, embedding
and decision call to `https://eu.openrouter.ai/api/v1`, where requests are decrypted and served only
by providers inside the EU, and a model with no EU provider is a 404 rather than a hop to the US.
The account behind `prod-eu`'s `OPENROUTER_API_KEY` must be on OpenRouter's Business or Enterprise
plan.

- The EU catalogue is a subset and serves none of the US defaults, so the EU instance defaults to
  `openai/gpt-6-luna` for chat, triage and reviews. `MAPLE_TRIAGE_MODEL_OPENROUTER` and
  `MAPLE_REVIEW_MODEL_OPENROUTER` override it; any override must be in the EU catalogue
  (`GET https://eu.openrouter.ai/api/v1/models`).
- Jev has no EU provider, so there is no decision model and the investigation gate reads "no
  verdict" as "investigate".
- Workers AI has no region pin: `MAPLE_LLM_PROVIDER` must stay unset (OpenRouter) on `prod-eu`.

## Phase 5. Operations

- The "Prod revision skew" alert and its lockstep list cover both instances.
- Token rotation runbook: two instances, each with Worker secret bindings plus an ECS secret.
- A weekly comparison of `GET /v0/datasources` across the two workspaces catches a missed deploy;
  the local-schema gate only catches datasource edits.
- Decided 2026-09-22, for now: the EU Workers report their own telemetry to the **US** internal
  org (`prod-eu` carries the US `MAPLE_ENDPOINT` and ingest keys), stamped `maple.region=eu` by
  `selfObservabilityEnv` so the two instances' `maple-api`s stay apart there; the "Prod revision
  skew" rule has to group by it before the first EU deploy. This crosses the boundary with Maple's
  operational data (org ids, compiled SQL, error text), not the customer's telemetry; the DPA has
  to say so, or the three values move to an EU internal org. The ingest gateway's own telemetry
  cannot follow: it goes through the EU collector into `maple_eu`, tagged with whatever
  `MAPLE_INTERNAL_ORG_ID` says, so it is only readable once an EU internal org exists.

## Risks

- **Queues and Workflows have no jurisdiction setting.** The four queues and the Workflows carry
  customer payloads. Get Cloudflare's written statement on where they store data under Regional
  Services, or keep customer content out of them on the EU instance and pass ids instead.
- **Placement is best effort, and that is all we have without Enterprise.** Cloudflare may run
  a script outside eu-central-1 when the pinned location is unhealthy, and Regional Services, the
  contractual guarantee, is not available on the current plan. The DPA has to say so: storage is
  guaranteed EU (Tinybird, Postgres, R2 and the Durable Object are hard-pinned), execution is EU
  by placement. If a customer needs a hard execution guarantee, the non-Enterprise path is to
  host the request path inside a Durable Object with `jurisdiction: "eu"`, which is a hard
  guarantee on every plan: the Worker's fetch handler does nothing but forward to the DO, and the
  Effect HTTP graph runs inside it. The class-form Workers already host DOs, so this is a
  contained change to the api and ai bridges, not a rewrite. Regional Services can also be bought
  later with no code change.
- **Clerk holds staff names and emails in the US.** Decided: one instance. The DPA lists Clerk as
  a US subprocessor for account data (name, email, org membership), never telemetry.
- **Alchemy state collision.** Two deploys of the same stage into one state store will plan
  against each other's resources. Settle the state key before the first EU deploy.
- **Two of everything drifts.** Same migrations, same Tinybird schema, same secrets by name. The
  `prod-eu` environment with identical variable names is what keeps drift visible as a diff.

## Decisions

Taken 2026-09-16:

1. Clerk: one instance, `app.eu.maple.dev` as a satellite domain.
2. Regional Services: not available; EU Workers run on best-effort placement, with the DO-hosted
   request path as the upgrade if a customer requires a hard execution guarantee.
3. AI features off on `eu` at launch. Turned back on 2026-09-25 over OpenRouter's EU endpoint (Phase 4).

4. Sandbox deploys per instance from day one.

## Order and size

Phase 0 is account work, about two days including the Clerk satellite-domain setup.
Phase 1 is a week and deploys nothing new until `MAPLE_REGION=eu` is set. Phase 2 is three days
plus the first EU deploy, which will take two passes for the certificates. Phase 3 is three days
and is the only user-visible step. Phase 4 is two days: the provider-less AI Worker mode and the web flag.
