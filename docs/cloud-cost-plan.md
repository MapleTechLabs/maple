# Cloud cost: plan

Status: **phase 1 built, 2026-11-11, behind the `cloudCost` org flag.** AWS spend is synced daily
into `cost_daily` and shown on `/cost`. OpenRouter, GitHub, Vercel and Cloudflare followed on
2026-11-12, PlanetScale, Anthropic and OpenAI on 2026-11-13.
Phase 0 checked the provider APIs against docs, public schemas and one real AWS account.
Recommendations (phase 2) and the other providers are not built.

## Goal

An org sees what its cloud and platform accounts cost, per day, service and resource, next to the
telemetry Maple already has for the same resources. Maple then lists what to cut, with the usage
chart that backs each suggestion and an estimated monthly saving.

It reads from the connections an org already has (AWS, Vercel, GCP, Cloudflare, Railway,
PlanetScale, Supabase). No second onboarding.

Non-goals for v1:

- Buying, selling or changing anything in the customer's account. Maple only advises.
- Invoices, tax and payment data.
- Converting currencies. Rows keep the provider's billing currency.
- Seeded sample data. An org with no cost source sees how to connect one.

## What exists to build on

| Piece                         | Where                                                                    | Reuse                            |
| ----------------------------- | ------------------------------------------------------------------------ | -------------------------------- |
| Provider connections          | `packages/backend/src/services/integrations/`                            | each gains a cost adapter        |
| AWS `cost` module (unoffered) | `AWS_MODULE_SPECS.cost`, `packages/domain/src/aws.ts`                    | turned on in phase 1             |
| Poll leases and fleets        | `lease.ts`, `poll-fleet.ts`, `integration-sources.ts`                    | the sync lane                    |
| Provider-polled daily table   | `search_console_daily` and `SearchConsoleImportService`                  | model for `cost_daily`           |
| Finding lifecycle             | `security_audit_findings` (fingerprint, open, fixed, dismissed, reopen)  | model for `cost_recommendations` |
| Notifications                 | `NotificationDispatcher`, managed alert signal types                     | budgets and anomalies            |
| Org rollout flags             | `packages/domain/src/organization-feature-flags.ts`                      | a `cloudCost` flag               |
| Utilization metrics           | `aws.*`, `gcp.*`, `railway.*`, `planetscale_*`, Supabase `pg_*`/`node_*` | evidence for Maple's own rules   |

An earlier standalone prototype (the `maple-cost` repo) has a FOCUS-based cost line model, decimal
money handling and an AWS CUR 2.0 normalizer. Those are ported in. Its separate API, database and
warehouse are not.

## Architecture

### Cost provider contract

One adapter per provider, in `packages/backend/src/services/cost/providers/`, behind one port.
The registry covers cost only. The integrations themselves are not refactored. A provider that is
not read through an integration's connection keeps a pasted credential, and
`cost_sources.connection_ref` points at its row. OpenRouter has a table of its own
(`openrouter_cost_connections`). Every later provider shares `cost_connections`: one row per org
and provider, with the sealed credential, the vendor's account id and a label. `CostConnectionStore`
seals, upserts (refusing a credential of another account), removes and loads it, and
`reconcileCostConnectionSources` keeps `cost_sources` in step for each provider named in
`COST_CONNECTION_PROVIDERS`. A new provider of this kind needs no migration, slot or reconcile: it
adds its literal there, and brings its own vendor check, adapter and endpoints. GitHub keeps no
credential: its source points at the GitHub App installation (`vcs_installations.id`), and the
adapter reaches GitHub through the VCS provider port, like every other reader of that installation.
A connection that exists for more than cost (a GitHub installation, a Vercel team) supplies cost
only once the org adds it on the Cost page: its `cost_sources` row is the opt-in, and no column on
the connection says so.

```ts
interface CostProvider {
	readonly provider: CostProviderId
	// What this connection can supply today, and what the customer must enable for more.
	readonly capabilities: (connection) => Effect<CostCapabilities, CostProviderError>
	// Daily cost rows for a window. Re-pulling a day replaces it.
	readonly pullCost: (connection, window) => Stream<CostRow, CostProviderError>
	// The provider's own recommendations, normalized.
	readonly recommendations: (
		connection,
	) => Effect<ReadonlyArray<CostRecommendationInput>, CostProviderError>
}
```

### Warehouse: `cost_daily`

One row per cost source, UTC day, cloud service, usage type, region, resource and charge category.
Money and quantity columns follow FOCUS (`BilledCost`, `EffectiveCost`, `ListCost`,
`ConsumedQuantity`, `ChargeCategory`). Where Maple's warehouse already has a meaning for a name,
Maple's meaning wins:

- `ServiceName` is the telemetry service a resource resolves to, as in every other table, and is
  empty when none does. This is the join to requests and traces. The provider's own service is
  `CloudService`.
- `Basis`: `billed` (the provider reported the money) or `estimated` (usage times list price). The
  UI always shows which.
- `Estimated`: 1 while the provider can still restate the day.
- `IngestedAt` is the pull version. Each pull writes a source's whole day under one value, and
  queries read the newest per `(SourceId, Date)`. Providers restate recent days and can drop keys,
  so rows are never updated in place and never picked per key.

Money is `Float64`, like every other measure in the warehouse, and is rounded to cents when shown.
The table is written through the managed ingest route only, like `search_console_daily`: an org on
its own ClickHouse still reads cost from Maple's warehouse. A disconnected source keeps its rows
until the TTL (760 days), so reads name the org's active sources.

It is a small table (hundreds of rows per source per day), so it needs no rollup.

### Postgres

- `cost_sources`: one row per connection that supplies cost. Its lease, frontiers (newest and
  oldest day pulled), last error and its reason, and the provider requests made this month. A
  connection that stops supplying cost pauses its source and keeps its history. Only a deleted
  connection deletes it. A Vercel source is also deleted when the org removes it on the Cost page
  and when its connection moves to another team, whose spend would overwrite the source's days.
- `cost_recommendations` (phase 2): followed across runs by `(source, fingerprint)`. Kind,
  resource, title, estimated monthly saving and currency, effort, risk, evidence (jsonb), origin
  (`provider` or `maple`), status (`open`, `dismissed`, `accepted`, `resolved`). A resolved one
  that comes back reopens. A dismissed one stays dismissed.

### Sync

A `cost_sync` lane on the `2-59/5` cron (the `*/5` one is at its lane limit), so a new source has
cost within minutes. A connection that turns cost on, off or loses its grant updates its source in
the same write, so the Cost page shows the wait before the first tick. Per source:

- First pull: the previous month through today.
- Then the last four days about daily, and the open months about weekly. The previous month stays
  in the weekly pull until one has run after the tenth, so its last pull is after the provider
  finalizes it.
- History walks down one calendar month per step, to thirteen months back.
- A source held for long resumes from its watermark, so no day in between is skipped.

The windows above are the AWS ones. Each provider has a profile (`COST_SYNC_PROFILES` in
`sync-plan.ts`): the oldest day it serves and how far its newest day trails today. No window
reaches outside them, because a day the provider no longer serves comes back empty, and an empty
day replaces the stored one. OpenRouter serves 30 completed days: its sync asks for 28 at most and
never for today. GitHub's report is asked for one calendar month at a time, back to the first day
of the month three months before the current one. Vercel serves a year in one request, today
included: its history starts at the first day of the month eleven months back, so no window is
longer than a year. Cloudflare serves a year of completed days: its history stops at the first day
of the eleventh month back, and it never asks for today. PlanetScale bills by the month: it reads
twelve months back, through today, and its daily pull takes the whole open month, since a day
there is a share of the month's invoice.

Each step writes its days whole under one `IngestedAt`. A day a pull returned nothing for gets a
marker row (`ChargeCategory = 'none'`), so it supersedes the older pull. Reads leave it out.

What bounds the provider's bill for requests:

- One request at a time, two retries, a page cap of two pages per day of the window (never under
  20), and detail for the 12 largest regions at most.
- Per source and month: past 500 requests history waits for the next month, past 1,500 the source
  stops until then.
- A pull too large to read or to store is held a day. A source whose org left the rollout is not
  pulled, and is asked about again within the hour.
- A source resuming after a gap starts at the month before its watermark's, so days pulled while
  their month was still open get their final amounts.

### Reads

Every read names the org's cost sources, since a disconnected source keeps its rows, and is scoped
to one currency: the largest in the window unless the request names one. The response says which
currency the figures are in and lists the others. Nothing is added across currencies.

Answers are cached by their window, and a past window is held for 15 minutes. A sync writes past
days, so the key also carries when the org's sources were last written: a sync step shows on the
next read.

### Surfaces

- Web: `/cost` behind the `cloudCost` flag. One page: the window against the period before, a
  daily chart, a breakdown by service, provider, category, region, resource or account, a filter
  rail with a section per dimension, and each source's sync state. A row click narrows to the
  row and regroups by the next dimension (a service under a region goes on to its resources).
  The resource section and that step show only where some cost names a resource: a GitHub
  repository, a Vercel project, a PlanetScale database's branch. Sources are added from the page:
  AWS through its connection (which has a Cost switch), OpenRouter by pasting a management key,
  Cloudflare by pasting an API token and Anthropic and OpenAI by pasting an Admin API key, which
  the page can also replace or remove, GitHub by picking
  one of the organizations the GitHub App is installed on, and Vercel and PlanetScale by adding
  the team or organization the org has connected, all three of which the page can remove again.
  The pasted-credential step is one form described by data (`credential-sources.ts`).
  Recommendations (list and detail with the evidence chart) come with phase 2.
- API: four internal endpoints in the query-engine group (`cost-totals`, `cost-timeseries`,
  `cost-breakdown`, `cost-sources`), `PUT` / `DELETE` on `/internal/cost/openrouter` and
  `/internal/cost/cloudflare`, `/internal/cost/anthropic` and `/internal/cost/openai` for the
  pasted credentials, `GET /internal/cost/github` with `PUT` /
  `DELETE /internal/cost/github/{installationId}` for GitHub sources, and `GET` / `PUT` /
  `DELETE` on `/internal/cost/vercel` and `/internal/cost/planetscale` for the Vercel and
  PlanetScale sources. A public `/v2/cost/*` is not built.
- MCP: `cost_overview`, `cost_breakdown`, `compare_cost_periods`, `list_cost_recommendations`,
  `inspect_cost_recommendation`.

## Providers: what phase 0 found

"Live" means checked against a real account on 2026-11-11. "Docs", "spec" and "schema" mean read,
not run.

### AWS (billed)

- Spend: Cost Explorer `GetCostAndUsage`, endpoint `us-east-1` only. Live: works on a standalone
  account with no setup beyond having opened Cost Explorer once.
- Live: at most two `GroupBy` keys ("Only two values for GroupBy are allowed"). Service, usage
  type and region are three, and a usage type does not always name its region (`us-east-1` usage
  types carry no prefix). So region is a filter, not a key: one `SERVICE` x `USAGE_TYPE` pull per
  region, each filtered on `REGION`.
- Live: the per-region pulls of a closed month add up to the unfiltered total. Charges with no
  region come back under `global` or an empty region and are stored that way.
- Live: `GetDimensionValues` listed 19 regions for an account that runs in two. The other 17 held
  under a cent a month. One `SERVICE` x `REGION` pull finds the regions worth a filtered pull. The
  rest keep that pull's service-level rows, with no usage type.
- Live: a page holds 2,500 groups. A small account produces about 250 groups a day at
  `SERVICE` x `USAGE_TYPE`, so a 10 day pull is 2 requests.
- Docs: each request costs the account owner USD 0.01. A pull is one request plus one per region
  with real spend, more when a region passes a page. The connect screen says so, each source
  counts its requests, and the schedule keeps a small account to a few dollars a month.
- Live: a closed month reports `Estimated: false`. Every day of the open month reports `true`.
- Docs: history is the current month and the 13 before it. Data refreshes at least daily.
- Docs: a member account of an organization sees only its own cost, and the management account can
  turn that off. Credits and discounts can be hidden from members.
- Live: resource-level cost (`GetCostAndUsageWithResources`) is refused until the payer opts in.
  Docs: it then covers 14 days. Resource-level history needs a CUR 2.0 export (phase 5).
- Live: cost allocation tags are empty until activated in the payer account.
- Recommendations: Cost Optimization Hub covers rightsizing, idle resources, Savings Plans and
  reservations in one deduplicated list, with `estimatedMonthlySavings`, `implementationEffort`,
  `restartNeeded` and `rollbackPossible`. Docs: free, opt-in, and rightsizing also needs Compute
  Optimizer opted in. Live: a fresh account is enrolled in neither.
- Live: `GetSavingsPlansPurchaseRecommendation` and `GetSavingsPlansCoverage` answer without any
  opt-in. They are the fallback when the hub is off.
- Permissions: the `cost` module now lists every read above (23 actions, all `Resource: "*"`). IAM
  Access Analyzer validates the rendered policy with no findings. No write action is included:
  enrolling in the hub or starting a recommendation run stays with the customer.

### OpenRouter (billed)

- Spec: `GET /api/v1/activity` returns one row per UTC day, model and serving endpoint for the
  last 30 completed days, all in one answer. `usage` is USD billed by OpenRouter.
- It needs a management key. A regular API key gets 403, so the key an org's AI turns run on
  cannot be reused. The org pastes a management key on the Cost page, which Maple checks
  (`GET /key`, then one activity read) and stores sealed.
- Live: `GET /key` names the key's account: `organization_id`, or `creator_user_id` on a personal
  account (`organization_id` is then null). That id is the source's account. A replacement key
  must name the same one, since another account's spend would overwrite the source's days. A
  replaced key also makes a failing source due again at once.
- Spec: a management key can be scoped to one workspace, and then reads only that workspace.
  Live: a key for the whole account answers 404 for a workspace the account does not have, where
  the spec says a scoped key answers 403. Maple asks that when the key is saved and refuses a
  scoped key, since its pulls would miss the rest of the account's spend without saying so.
- Requests are free, so the source counts none.
- Rows: the model is `CloudService`, the serving provider is `UsageType`, the category is "AI and
  Machine Learning", the region is `global`. Rows OpenRouter billed nothing for are left out.
- Not counted: spend on the account's own provider keys (`byok_usage_inference`). OpenRouter
  estimates it at market rates, and the page does not yet tell billed from estimated.
- Not split: workspaces and API keys. The activity API can filter by either.
- Spec: the EU host documents inference only. Every instance reads activity from the global host.
- Open: whether a completed day is ever restated. The four newest days are pulled again daily,
  and yesterday is marked as not final, since it may have ended minutes before the pull.
- A day OpenRouter answers nothing for is stored as empty, like any provider's. An empty answer
  for an account that had spend would hide up to 28 days until the next weekly re-pull.

### GitHub (billed)

"Live" here means checked on 2026-11-12 with an organization owner's token.

- Spec: `GET /organizations/{org}/settings/billing/usage?year=&month=` returns one line per usage
  record: date, product, SKU, quantity, unit, gross, discount and net amount, and the repository.
  It takes no paging parameters and is marked as usable by GitHub Apps.
- The source is opt-in: the org picks an organization the GitHub App is installed on. Nothing is
  stored but the `cost_sources` row. A user account has no billing report and is not offered.
- Spec: an installation token needs the organization permission "Administration: read", which
  the token lists as `organization_administration`. The App does not ask for it yet, so until it
  does and an organization accepts it, adding is refused with what to accept and where. Maple
  reads the current month once before it makes the source, so a missing permission never becomes
  a failing source. Docs: the usage reporting guide says the billing endpoints do not take
  fine-grained personal access tokens. Open: no installation has been read live yet.
- Docs: only organizations on the enhanced billing platform have the report. What another
  organization is answered is not documented: a refusal whose body names the billing platform is
  stored as "not ready", any other unexpected status as a failed request.
- Live: `date` is a timestamp and not always at midnight; the day is its first ten characters.
  Several lines can share a day, product, SKU and repository, and are summed.
- Live: `quantity` is a float, where the spec says integer. Every Actions line named its
  repository. Seat products may not, so the repository is optional.
- Live: usage covered by a plan allowance, or free for a public repository, has a gross amount, a
  discount of the same size and a net amount of zero. Rows keep both: `BilledCost` and
  `EffectiveCost` are the net amount, `ListCost` the gross one. A line with neither is left out.
- Live: a month with no usage answers an empty list.
- Live: usage from five months back was still served. Docs: no retention is stated for this
  endpoint (its sibling summary endpoints state 24 months). The sync stops at the first day of
  the month three months back.
- Rows: the product is `CloudService` (`actions` reads "Actions"), the SKU is `UsageType`, the
  repository is `ResourceId`, the category is "Developer Tools", the region is `global`, the
  currency is USD. Today and yesterday are stored as not final.
- Requests are free, so the source counts none. A window is one request per calendar month.
- A source is removed by the sync when its installation is gone, suspended, or no longer an
  organization's. A suspended installation that comes back has to be added again.
- Not built: user accounts, enterprise-level billing, Copilot seat endpoints, budgets.

### Vercel (billed)

Nothing here was run against a real team: there was none to test with. The request and the
response shape are Vercel's OpenAPI spec. The adapter, the normalizer and the page are tested
against a fake server that answers what the spec describes.

- Spec: `GET /v1/billing/charges?teamId=&from=&to=` returns the team's billed charges as FOCUS
  v1.3 JSONL, one charge per line, at one-day granularity. `from` is inclusive and `to` exclusive,
  both ISO 8601 in UTC, a year apart at most. The answer is streamed, so Maple reads it line by
  line and sums as it goes.
- It takes the access token of the Vercel connection the org already has. No second credential
  and no new table: the source points at `vercel_connections.id`. Its account, and the account
  on every row, is the team's id, not its slug: a team can rename its slug, and rows already
  stored keep the account they were pulled with, so a slug would split one team into two
  accounts. The slug is read with the sources and is what the page shows ("Vercel <slug>").
- Adding names the team the dialog showed. A connection that reads another team by then, or
  whose token was replaced while the check read was in flight, is refused as changed.
- Spec: readable by the team's Owner, Member, Developer, Security, Billing and Enterprise Viewer
  roles. A token of another role answers 403, which the source reports as not ready with the
  roles that work. Adding the source reads yesterday and today once first (the days every daily
  pull ends on), so that refusal shows in the dialog and not as a first sync that fails.
- Spec: 401 is a rejected token (the source needs the team connected again), 404 and 410 a team
  or billing data that is gone, 429 a rate limit. A connection whose token the integration's
  poller already found rejected is not asked at all. A new token saved for the same team makes
  a source due at the next tick, whenever it last synced. A 400 is a request Vercel calls
  invalid: the source keeps Vercel's own message, and an add shows it in the dialog, since the
  request shape is the part not run live.
- Requests are free, so the source counts none.
- Rows: the product (`ServiceName`) is `CloudService`, its `SkuId` the `UsageType` (left empty
  when it equals the product name), `ServiceCategory` the category (`Other` when absent),
  `RegionId` the region (`global` when absent), and the project (`Tags.ProjectName`, else
  `Tags.ProjectId`) the resource, which the page groups and filters by. On the page the team
  reads as "Vercel <slug>" (the slug comes with the sources read, the key is the team id), and
  its services and regions wear the Vercel mark where no other
  platform of the org could have billed them. `ChargeCategory` maps
  onto Maple's (`Usage`, `Purchase`, `Credit`, `Tax`, `Adjustment`), so plan fees and credits
  are their own rows. Lines of one day,
  product, SKU, project, region and kind of charge are summed. A sum with no billed and no
  effective cost is left out. Credits are negative and kept.
- Spec: no list price is reported, so `ListCost` is the billed cost.
- Every field but `BilledCost`, `ChargePeriodStart` and `ServiceName` is read as optional, since
  the spec is the only source. A line that is not such a charge fails the whole pull as an
  invalid response: storing part of a day would hide the older pull of it. So does a
  `ChargePeriodStart` that is not a UTC date-time on a real calendar day (no February 31st, a
  February 29th in leap years only), an amount or quantity that is not finite (`1e309` is valid
  JSON), lines that sum past what a number holds, and any answer but a 200 (a 204 or a 206
  would store days empty or by halves).
- Open risk: a 200 with an empty body reads as a team with no charges, and the window's days
  are stored empty. Nothing in the answer tells an empty month from a broken one, so a broken
  empty answer would hide up to two months until the next re-pull of them. The JSONL has no
  count or end marker to check against.
- Open: when a day stops changing. Today and yesterday are stored as not final, and the four
  newest days are pulled again daily.
- Open: how large a busy team's answer is. A day above 10,000 rows is refused like any
  provider's.
- Not split: the team's telemetry service per project. `ServiceName` (Maple's) stays empty.

### GCP (billed, needs a customer export)

- Docs: no API returns cost. The customer must enable the detailed usage cost export to BigQuery
  (console only, by a billing account Costs Manager). A multi-region dataset backfills from the
  start of the previous month. A regional one starts on the day it is enabled.
- The reader service account needs `roles/bigquery.dataViewer` on that dataset and
  `roles/bigquery.jobUser` on one project. Queries are billed to the project that runs them.
- Rows are append-only. A correction is a new row with the same usage date. Net cost is `cost` plus
  the (negative) `credits`.
- Recommendations: Recommender API with `roles/recommender.viewer`. Each project, location and
  recommender is listed separately. Idle VM, disk, address and image, Cloud SQL idle and
  overprovisioned, Cloud Run cost, commitments. Negative cost is the saving.
- Until the export exists, Maple can still show the recommender's savings and its own rules.

### Cloudflare (billed, pay-as-you-go accounts)

"Live" here means checked against a real pay-as-you-go account on 2026-11-12, and on 2026-11-13
for the token's reach and the OAuth scopes.

- It needs an API token with the "Billing: Read" permission on one account. OAuth clients are
  offered no billing scope, so the integration's connection is not used (see "OAuth is the intended
  home" below): the org pastes a token on the Cost page, which Maple checks and stores sealed in
  `cost_connections`.

**The token is kept least privileged.** A token cannot be asked what it may do: listing its own
policies (`GET /user/tokens/{id}`) needs the "API Tokens Read" permission, and
`GET /user/tokens/verify` answers `id`, `status` and `expires_on` only. So there are two halves.

- The right token is the easy one to make. Live: Cloudflare's dashboard takes a template in the
  URL. The dialog's link (`permissionGroupKeys=[{"key":"billing","type":"read"}]`, with a name,
  `accountId=*` and `zoneId=all`) opens "Create Token" with the name filled in and one permission
  ticked, Account > Billing > Read, over all accounts. The help text says what is left: pick the
  one account, optionally set an expiry, create, paste.
- A token for several accounts is refused (above), so a billing token for every account the
  person can see does not get stored.
- A token that visibly reads more than billing is refused. After the checks above pass, four
  requests are made side by side, on a save and a replace only, never in a sync pull. Live, with
  two tokens on one account:

    | Request                                    | Billing: Read only | Billing, Workers Scripts and Account Settings Read |
    | ------------------------------------------ | ------------------ | -------------------------------------------------- |
    | `GET /accounts/{id}/members?per_page=1`    | 403 (code 10000)   | 200                                                |
    | `GET /accounts/{id}/workers/subdomain`     | 403 (code 10000)   | 200                                                |
    | `GET /accounts/{id}/audit_logs?per_page=1` | 403 (code 10000)   | 200                                                |
    | `GET /zones?per_page=1`                    | 200, empty list    | 200, zones listed                                  |

    The first three are read off the status: a 200 is access, whatever the account holds. Zones
    answer a billing token with an empty list, so only a list with something in it is access.
    A 401 or 403 is no access. Any other answer (a 5xx, a 404, no answer) fails the save as a
    check that could not be made: it neither passes nor refuses the token.

    The Workers scripts list (`GET /accounts/{id}/workers/scripts`) was a fifth probe and was
    dropped. Live, on a preview: it took 1.8 s where the others took under 0.2 s, and the whole
    save waited for it. The Workers subdomain already tells a Workers-reading token apart. The
    change itself is covered by the fake only, since the test tokens no longer exist.

- The refusal names what was found, so the person knows which permission to drop: "This token
  can do more than read billing: it can also read account members and Workers scripts. Create one
  with only the Billing: Read permission."
- What this does not prove: the probes ask for a few things a billing token must not see. A token
  with some other extra permission none of them touches passes (Live: R2 and KV answer 403 and 401
  to both tokens, so they tell nothing). It catches the common over-broad tokens, an edit-Workers
  or a read-all token, not every one.

**OAuth is the intended home.** The cost source should read through the org's existing Cloudflare
connection, not a pasted token. It cannot today. Live, 2026-11-13: `GET /client/v4/oauth/scopes`
lists 404 scopes, and none is for billing, invoices, subscriptions or usage. The category named
`account_and_billing` holds account settings, memberships and token scopes only. When Cloudflare
adds one:

- add it to `CLOUDFLARE_OAUTH_SCOPES`, and read billing through the connection as the PlanetScale
  source does with its grant;
- offer "Reconnect to grant billing access" for connections made before the scope;
- retire the pasted token: re-point each existing source's `connectionRef` at the connection, then
  delete the stored tokens.

The billing API facts, which hold for either credential:

- Live: `GET /accounts` lists the accounts the token reads. A token for one account lists one,
  and its id is the source's account. Its name is stored beside the token and is the source's
  `accountName`, so the page reads "Cloudflare <account name>" and not the 32 character id. A token that lists none or several is refused. A
  replacement token must read the same account, since another account's charges would overwrite
  the source's days. Live: a token Cloudflare does not know answers 403 on this call, and 401 on
  the billing calls.
- Live: `GET /accounts/{id}/billable-usage/info` answers `covered`. Schema: usage-based billing
  data is not available to enterprise accounts. A save is refused and a pull reports "not ready"
  while it is false.
- Live: `GET /accounts/{id}/billable-usage?from=&to=` (marked "Version 1, Alpha") answers
  FOCUS-style rows, one per UTC day and priced metric, in one answer without paging (about 1,100
  rows for six weeks). Most rows bill nothing, being inside the included allowance.
- Live: `to` is exclusive. `from=2026-10-01&to=2026-10-02` answers 1 October only, and equal
  dates are refused.
- Live: a billing period's rows come back only when the period starts inside `[from, to)`. A
  range that starts a day after the period did answers nothing for it. So every request asks from
  31 days before its first day to the day after its last, and keeps only its own days.
- Live: a range over 90 days is refused (`max_date_range_days`), so a window is read in pieces of
  55 days. Requests are free, so the source counts none.
- Live: yesterday is served, today is not, and the oldest day served is one year before today.
  The profile asks from the first day of the eleventh month back through yesterday. The two newest
  days are stored as not final.
- Live: a range that reaches past the year is answered, not refused, with the older days left out,
  and a period that started before the year still returns its days inside it. So the 31 days asked
  before the oldest month cost nothing.
- Live: a wrong or revoked token answers 401 (sync reason `auth`), a token without billing access
  403 (`not_ready`). A 400 is a request Maple wrote wrong (`upstream`).
- Rows: the product family (`Workers`, `R2`, `D1` ...) is `CloudService`, the priced metric is
  `UsageType`, the region is `global`, and the category comes from a small map of the families.
  Rows with no billed and no list cost are left out.
- Live: usage rows do not include plan fees. `GET /accounts/{id}/subscriptions` (paged) lists them
  with `price`, `frequency` and `current_period_start`. Each paid subscription becomes a purchase
  row (`CloudService` "Subscriptions", the rate plan as `UsageType`, the zone as the resource) on
  the day each billing period started, stepped back from the current period by its frequency
  (a week, a month or three months) and never before the subscription was created. A yearly one
  gets one row on its current period's start.
- A subscription made on the 29th to 31st has later starts clamped to shorter months, so stepping
  back lands days before it was made: that first period's fee goes on the day it was made.
- Live: `created_date` was on every subscription. Schema: the published response does not list
  it. Without it only the current period's fee is stored, since earlier periods cannot be told
  from months before the subscription existed.
- A priced subscription Maple cannot place on a day (another frequency, or no period start) has
  no row. The pull's span counts them as `maple.cost.cloudflare.fees_skipped`.
- Assumed: Cloudflare reports the current period only, so earlier months use today's price. A plan
  whose price changed shows the new price for its past months too.
- Schema: a subscription's `state` is one of `Trial`, `Provisioned`, `Paid`, `AwaitingPayment`,
  `Cancelled`, `Failed`, `Expired`. Live: every listed one was `Paid`, free items included.
  Assumed: `Trial`, `Failed` and `Expired` were not charged, so they get no fee row.
- Known limit: a fee is known only while its subscription is listed. If Cloudflare drops a
  cancelled subscription from the list, the next re-pull of the open months stores those days
  without its fee. Months already walked as history keep theirs.
- Live: the listing's `result_info` has `per_page`, `total_pages` and `total_count`. Schema: only
  the count is documented, so the page count falls back to the count over the page size. A list
  read short of its count, over 10 pages, or a full page that says nothing of its paging, fails
  the pull as an answer Maple cannot read: part of the list would under-count.
- Every answer must say `success: true`. Read as an answer, a 200 with an empty result would
  store every day of the window as empty. Live: the usage answer has no `result_info`. One that
  appears and lists more rows than it returned fails the pull too.
- Open: whether a completed day is ever restated. The four newest days are pulled again daily.
- Not built: enterprise contracts, zone-level analytics, the restricted "Version 2" endpoints,
  invoices and credits.

### Anthropic (billed, Claude API only)

- Read with an Admin API key (`sk-ant-admin...`) the org pastes, kept in `cost_connections`. `GET
  /v1/organizations/me` names the organization (its id is the account, its name the label).
- `GET /v1/organizations/cost_report`, daily buckets grouped by `workspace_id` and `description`, 31
  buckets a page, followed by `next_page`. `amount` is a decimal string in cents. The docs call it
  legacy beside `/v1/organizations/analytics/cost`, which Console organizations only get as an
  early-access preview, so the legacy report is the one every org can read.
- Rows: a model's lines are `anthropic/<model>` (the Cost page shows the model's mark), web search,
  code execution and Managed Agents sessions their own names, anything else `Anthropic API`. The
  description is the usage type, the workspace the resource (`default` for the default workspace),
  and the inference geography a tag.
- Not covered: Claude subscriptions billed through claude.ai, and Claude on Bedrock, Vertex AI or
  Foundry, which bill through those clouds.

### OpenAI (billed, API only)

- Read with an Admin API key (`sk-admin-...`), kept in `cost_connections`. `GET
  /v1/organization/costs`, daily buckets grouped by `project_id` and `line_item`, 180 a page.
- No endpoint answers an admin key with its organization. Live: the `openai-organization`
  response header names the key's owner (`user-...`), and `/v1/me` lists every organization of
  that user. A save reads the last 180 days of costs and takes the one `organization_id` the results
  carry (on real answers, not in the schema). No spend in those days is refused as nothing to read
  yet, spend without an organization or with two is refused too. The label is the id.
- Rows: a line item `<model>[ <modality>], <part>` is `openai/<model>` (live: `gpt-realtime-2
  audio, input`), any other `openai/<line item>`. The line item is the usage type, the project the
  resource, the quantity and its unit kept.
- Live (2026-11-13, a real organization): grouped by `group_by[]`, the pull matched the raw answer
  to the cent; the key is sealed in the row and read back by the sync.

Neither vendor offers an admin key that can only read cost: the key can also manage members and
keys. The dialog says so and suggests a key made for Maple alone; Maple only calls the endpoints
above. Retention of either report is not documented, so history starts three months back. Live
(2026-11-13): Anthropic accepts an `ending_at` of tomorrow, `group_by[]` and a year's range, and its
newest bucket trails by about a day, inside the two open days; the key checked against an
organization with no spend, so its row shapes are still from the docs. Open: Anthropic rows from a
real organization with spend, restated days, and how far back OpenAI serves.

### Railway (estimated per service, billed per workspace)

- Schema: `usage(workspaceId, startDate, endDate, groupBy, measurements)` returns quantities
  grouped by project, service and environment. No time bucket, so one call per day. 90 days of
  history. Money is computed from the public unit prices, as Railway's own CLI does.
- Schema: `workspace.customer` has the current period's usage in money, invoices and the next
  invoice total. That is the check on the estimate.
- Open: whether a workspace token can read `customer`.
- Recommendations are Maple's own: CPU and memory usage against the limit is already polled.

### PlanetScale (billed, monthly invoices spread over days)

"Live" here means checked on 2026-11-12 against a real organization's invoices, with a service
token that has only `read_invoices`. The endpoints and shapes are the same for the OAuth grant the
source reads with; that path is covered by tests against a fake only, since Maple's one PlanetScale
OAuth application redirects to production and a reconnect cannot run on a preview.

- Live: `GET /organizations/{org}/invoices` lists one invoice per calendar month, newest first,
  the open month included (`paid: false`). `billing_period_end` is exclusive: the first instant of
  the next month. An organization's first invoice can start mid-month, and months with no invoice
  are simply missing.
- Live: `GET /organizations/{org}/invoices/{id}/line-items` names the database, the branch (with
  when it was made and deleted), the SKU (`metric_name`) and a `subtotal` in USD as a decimal
  string. Vitess and Postgres clusters look the same.
- Live: a closed invoice's line items add up to its `total`. The open invoice's `total` lags its
  line items, so Maple reads line items only.
- Live: a cluster's line on the open invoice already carries the whole month's charge, not a
  month-to-date figure.
- Live: a branch deleted or resized mid-month has its charge line plus a negative "Prorated ...
  discount" line with the same database, branch and SKU. The two together are what it cost.
- There are no daily figures. Each line item is spread evenly over the days of the invoice's month
  on which its branch existed (the whole month for a line with no branch), a discount line the
  same way, so a branch's days net out to what it cost. The shares of a line add up to its
  subtotal. The open month shows its days so far. The source's row on the page says that its
  days are an even share of a monthly invoice and can change until the invoice closes.
- It connects through the PlanetScale integration the org already has, with nothing pasted. The
  source is a `cost_sources` row whose `connection_ref` is the `planetscale_connections` row and
  whose account is the connection's organization. Adding on the Cost page makes the row, removing
  deletes it, and the connection itself is never changed from there.
- Invoices are read with the integration's OAuth grant, as `Authorization: Bearer <access token>`,
  through the grant's own token handling: a 401 forces one refresh. A fresh token the invoice API
  refuses too fails the cost read and leaves the grant as it is. The grant is shared with metrics
  and webhooks, the OAuth path has not run against PlanetScale yet, and a 401 for a missing scope
  would otherwise revoke a healthy grant. Only the integration's own reads stamp it revoked; a
  grant so stamped is then asked nothing.
- Scope: `organization:read_invoices`, ticked on Maple's OAuth application on 2026-11-13 and added
  to the default of `PLANETSCALE_OAUTH_SCOPES`. A grant made before that lacks it. The stored grant
  records its scopes, so the Cost page says "Reconnect PlanetScale to grant access to invoices"
  without a request, an add is refused under its own error code, and a pull is held as not ready.
  A 403 from the API reads the same. A grant PlanetScale reported no scopes for is not ruled out:
  the read itself then answers.
- Reconnecting keeps the connection row and its id. A new grant makes the source due at the next
  tick, in the grant's own transaction, since it may carry the scope: a grant that sees several
  organizations is not bound again, so the bind cannot be what releases it. Binding another
  organization removes the source (its invoices would overwrite the source's days), decided in the
  bind's transaction by the source's own account, as does a disconnect. The sync also removes a
  source whose connection is gone or reads another organization.
- An add reads one page of the invoice list first, so a refusal shows before the source exists,
  and names the organization the dialog showed: one bound since is refused. The read is bounded
  at twenty seconds. After a refusal the dialog reads the connection again.
- Live, with a service token: an organization the token cannot see answers 404. Docs: a grant
  without `read_invoices` answers 403.
- Rows: the database is `CloudService` (the engine is not in the response), the SKU is
  `UsageType`, the category is "Databases", the region is `global`. The resource is the branch
  with its database (`orders/main`): nearly every database has a `main`, and under the page's
  Resource grouping a branch name alone would add them up as one. A line with no branch has none.
- On the page a database wears the PlanetScale mark by its shape (one lowercase word) only in an
  org that has the source and no Vercel source beside it: Vercel also bills a product named in one
  lowercase word. A charge filed under the provider's own name always does.
- Sync: twelve months back, through today. A pull is one invoice list plus one line-item read per
  month in its window. Requests are free, so the source counts none. The daily pull takes the
  whole open month, not the trailing days: a new line changes the share of every day of it.
  Through the tenth it takes the month before too, since a closed month still gains lines (a
  branch deleted on its last day is discounted after). A month with more than 5,000 line items
  is refused as too large.
- A settle after pulls stopped over a month end goes back to the month before the watermark's
  when the last settle was before that month closed. The watermark sits inside the usual start
  then, so the gap rule sees nothing to resume.
- Not used: `cluster-size-skus?rates=true`. A daily estimate from rates would only be replaced by
  the invoice.
- Only today and yesterday are marked as not final, as with the other providers. The whole open
  month can still move, but the page dims a day when any source marks it: a month of marked days
  would dim every provider's bars and count them all in "not final yet". The row says it instead.

### Supabase (estimated)

- Schema: no invoice or spend endpoint. Plan, compute size, replica type and disk size per project
  are readable with the scopes Maple already holds. Compute hours, disk and the plan fee can be
  estimated. Egress, MAU and storage overage cannot be read.

## Phases

Each phase is one PR stack.

1. **Core and AWS spend.** Domain model, `cost_daily`, `cost_sources`, the sync lane, the Cost
   Explorer adapter, the AWS module turned on, `/v2/cost`, and the Overview, Explorer and Sources
   pages behind `cloudCost`.
2. **Recommendations.** Table, lifecycle, API, list and detail pages, MCP tools. Hub and Savings
   Plan imports. First Maple rules, each backed by a metric already ingested: load balancers with
   no requests, databases with idle connections and low CPU, container services reserving far more
   than they use.
3. **More providers.** OpenRouter, GitHub, Vercel, Cloudflare, PlanetScale, Anthropic and OpenAI are built. Railway,
   GCP, Supabase, one PR each. Each provider adds a literal to `CostProvider`, an adapter and a
   sync profile. One read with a pasted credential also adds itself to
   `COST_CONNECTION_PROVIDERS`, a connection service that checks the credential with the vendor,
   its `PUT` / `DELETE` endpoints, and on the Cost page two commands and an entry in
   `CREDENTIAL_SOURCES`. One read through a connection adds a reconcile function instead, and
   when the org opts in on the Cost page (GitHub, Vercel, PlanetScale) a source service with its
   endpoints and a step in the Add source dialog.
4. **Closing the loop.** Budgets and cost anomalies as managed alert signals, a cost block in the
   weekly digest, cost per request on service pages, realized savings once an accepted
   recommendation stops firing.
5. **Depth.** CUR 2.0 for resource-level history, allocation of shared cost (NAT, cluster nodes),
   and cost tools for the investigation agent.

## Verification

- A closed month for a real account matches the provider's console to the cent.
- Normalizers and rules are pure functions tested on recorded provider responses.
- The new tables join the tenant isolation harness.
- Each phase is checked on a preview with a real connected account, with screenshots of the empty,
  loading, populated and error states.

## Open questions

- Cloudflare: move the cost source to OAuth once a billing scope exists. Checked on 2026-11-13,
  OAuth clients are offered none, so the source is a pasted token for now (see its section).
- GitHub: does an installation token with "Administration: read" read the billing report (the
  spec says so, no installation has been read yet), and how long the report keeps usage.
- Railway: can a workspace token read `customer`.
- AWS: the request rate limit of Cost Explorer is not published. The adapter backs off on
  `LimitExceededException`.
- AWS: a management account's rows include its member accounts and carry the connected account's
  id. Cost Explorer takes two group-by keys, so splitting by linked account multiplies the
  requests. The CUR 2.0 export carries the account on every row (phase 5).
- AWS: Cost Explorer rows do not say what kind of charge they are (`ChargeCategory = 'unknown'`):
  credits, refunds and commitment fees are netted into their service. Only tax stands apart.
- AWS: an account is too large for the Cost Explorer pull past 10,000 cost rows on one day (a day
  is always written whole), or past about 5,000 rows a day in one region. Its source reports
  "too large" and syncs nothing. It needs the CUR 2.0 export (phase 5).
- Packaging: part of every plan, or an add-on.
