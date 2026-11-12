# Cloud cost: plan

Status: **phase 1 built, 2026-11-11, behind the `cloudCost` org flag.** AWS spend is synced daily
into `cost_daily` and shown on `/cost`. OpenRouter followed on 2026-11-12 as the second source.
Phase 0 checked the provider APIs against docs, public schemas and one real AWS account.
Recommendations (phase 2) and the other providers are not built.

## Goal

An org sees what its cloud and platform accounts cost, per day, service and resource, next to the
telemetry Maple already has for the same resources. Maple then lists what to cut, with the usage
chart that backs each suggestion and an estimated monthly saving.

It reads from the connections an org already has (AWS, GCP, Cloudflare, Railway, PlanetScale,
Supabase). No second onboarding.

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
not an integration (OpenRouter) keeps its credential in a table of its own, and
`cost_sources.connection_ref` points at that row.

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
  connection deletes it.
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
never for today.

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

### Surfaces

- Web: `/cost` behind the `cloudCost` flag. One page: the window against the period before, a
  daily chart, a breakdown by service, provider, category, region, usage type or account with
  filters, and each source's sync state. Sources are added from the page: AWS through its
  connection (which has a Cost switch), OpenRouter by pasting a management key, which the page can
  also replace or remove. Recommendations (list and detail with the evidence chart) come with
  phase 2.
- API: four internal endpoints in the query-engine group (`cost-totals`, `cost-timeseries`,
  `cost-breakdown`, `cost-sources`), and `PUT` / `DELETE /internal/cost/openrouter` for the
  OpenRouter key. A public `/v2/cost/*` is not built.
- MCP: `cost_overview`, `cost_breakdown`, `compare_cost_periods`, `list_cost_recommendations`,
  `inspect_cost_recommendation`.

## Providers: what phase 0 found

"Live" means checked against a real account on 2026-11-11. "Docs" and "schema" mean read, not run.

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

### Cloudflare (billed for pay-as-you-go, else estimated)

- Schema: `GET /accounts/{id}/billable-usage` returns FOCUS-style daily rows with `BilledCost`. It
  is marked alpha, covers usage overages (not plan fees), and is not available to enterprise
  accounts. Plan fees come from the subscription endpoints.
- All of it needs the "Billing Read" permission. Open: whether the OAuth app can be granted a
  billing scope. If not, this source needs an API token.
- Fallback: usage from the GraphQL analytics datasets (already authorized) times list price.

### Railway (estimated per service, billed per workspace)

- Schema: `usage(workspaceId, startDate, endDate, groupBy, measurements)` returns quantities
  grouped by project, service and environment. No time bucket, so one call per day. 90 days of
  history. Money is computed from the public unit prices, as Railway's own CLI does.
- Schema: `workspace.customer` has the current period's usage in money, invoices and the next
  invoice total. That is the check on the estimate.
- Open: whether a workspace token can read `customer`.
- Recommendations are Maple's own: CPU and memory usage against the limit is already polled.

### PlanetScale (billed, monthly)

- Schema: invoices and line items per database, with scope `organization:read_invoices`. The scope
  must be added to the registered OAuth app, and connected orgs must authorize again.
- Schema: `cluster-size-skus?rates=true` returns rates with the scope Maple already holds. Daily
  figures are an estimate from those rates, corrected by the invoice.

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
3. **More providers.** OpenRouter is built. Railway, GCP, PlanetScale, Supabase, Cloudflare, one
   PR each. Each provider adds a literal to `CostProvider`, an adapter, a reconcile function and a
   sync profile.
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

- Cloudflare: is there an OAuth billing scope.
- Railway: can a workspace token read `customer`.
- PlanetScale: the time unit of SKU `rate`, and whether the open invoice is listed.
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
