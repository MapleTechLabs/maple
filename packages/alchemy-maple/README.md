# @maple-dev/alchemy

[Alchemy](https://alchemy.run) provider for [Maple](https://maple.dev) resources. Declare Maple API keys, ingest keys, dashboards, alert destinations, and alert rules in your `alchemy.run.ts` — right next to the infrastructure they observe.

```bash
npm install @maple-dev/alchemy alchemy effect
```

`alchemy` and `effect` are peer dependencies — this release is built and tested against
`alchemy@2.0.0-beta.80` and `effect@4.0.0`, the minimum supported versions.

## Usage

```typescript
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Maple from "@maple-dev/alchemy"
import { Effect, Layer } from "effect"

export default Alchemy.Stack(
	"my-app",
	{ providers: Layer.mergeAll(Cloudflare.providers(), Maple.providers()) },
	Effect.gen(function* () {
		// A notification channel…
		const oncall = yield* Maple.AlertDestination("oncall", {
			type: "pagerduty",
			name: "On-call PagerDuty",
			integration_key: process.env.PAGERDUTY_ROUTING_KEY!,
		})

		// …an alert rule that delivers to it (dependency resolved automatically)…
		yield* Maple.AlertRule("checkout-errors", {
			name: "Checkout error rate",
			severity: "critical",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05, // error rates are 0–1 ratios
			window_minutes: 5,
			destination_ids: [oncall.destinationId],
		})

		// …a dashboard…
		yield* Maple.Dashboard("service-health", {
			name: "Service health",
			tags: ["golden-signals"],
			time_range: { type: "relative", value: "12h" },
		})

		// …a scoped API key (secret captured once, kept in Alchemy state)…
		const key = yield* Maple.ApiKey("ci", {
			name: "ci-pipeline",
			scopes: ["dashboards:write"],
		})

		// …and your org's ingest keys as outputs for other resources.
		const ingest = yield* Maple.IngestKeys("ingest")
		// e.g. env: { MAPLE_INGEST_KEY: ingest.privateKey }
	}),
)
```

```bash
MAPLE_API_KEY=maple_ak_… alchemy deploy
```

## Authentication

Set `MAPLE_API_KEY` to a Maple API key (create one in the Maple dashboard, or with this provider). Requirements:

- **Dashboards** need the `dashboards:write` scope.
- **Alert rules & destinations** need `alerts:write` **and** an org-admin key.
- **API keys & ingest keys** need `api_keys:write` / `ingest_keys:read` **and** an org-admin key.

`MAPLE_API_URL` overrides the API base URL (defaults to `https://api.maple.dev`).
`Maple.providers()` reads those variables and uses the runtime's global `fetch`.

To supply configuration or transport explicitly, compose the open provider
layer with both services. These layers are used directly; no internal default
overrides them:

```typescript
import * as Maple from "@maple-dev/alchemy"
import { Layer, Redacted } from "effect"
import { HttpClient } from "effect/http"

const mapleProviders = Maple.providersWithDependencies().pipe(
	Layer.provide(
		Layer.succeed(Maple.MapleEnvironment, {
			baseUrl: "https://maple.internal.example",
			apiKey: Redacted.make("maple_ak_…"),
		}),
	),
	Layer.provide(Layer.succeed(HttpClient.HttpClient, myHttpClient)),
)
```

`Maple.MapleApiFromHttpClient()` exposes the same environment-and-transport
seam when constructing the API client without the Alchemy provider collection.

## Resources

| Resource                 | Semantics                                                                                                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Maple.Dashboard`        | Full CRUD over typed native v2 dashboard data (`snake_case`, see `/v2/docs`). Updates PATCH in place. Set `dashboardId` to adopt an existing dashboard, and `refresh_interval_seconds` to manage its refresh cadence.                                                        |
| `Maple.AlertDestination` | Full CRUD for declaratively provisionable types (PagerDuty, webhook, Discord, Telegram, email). Channel secrets are write-only — accept `Redacted` values. Chat-connector and Hazel destinations use integrations linked in Maple. Changing `type` replaces the destination. |
| `Maple.AlertRule`        | Full CRUD. `destination_ids` accepts outputs from `Maple.AlertDestination`. Lost state is recovered only when the rule's ownership tag matches the stack, stage, and logical resource. Other rules require explicit adoption.                                                |
| `Maple.ApiKey`           | Create / roll / revoke (the API has no key update). Changing props replaces the key; bumping the `rotate` prop rolls it in place (same name/scopes, new secret). `secret` is captured once and preserved in Alchemy state — it can never be re-read from the API.            |
| `Maple.IngestKeys`       | Read-only per-org singleton. Surfaces `publicKey` / `privateKey` as `Redacted` outputs; delete only stops tracking it.                                                                                                                                                       |

## Reusable dashboard data

`DashboardData`, `DashboardWidget`, `DashboardVariable`, `DashboardSection` and
`DashboardTimeRange` are Effect schemas and corresponding data types for the native
v2 wire representation. Their `.make` constructors validate trusted definitions;
use Effect Schema's decoders for external data. Layout, display and data-source
discriminants are typed; query-builder query/formula bags retain the native wire
contract's open records. These schemas ship inside this package, without private
Maple workspace dependencies.

```typescript
const data = Maple.DashboardData.make({
	name: "Service health",
	refresh_interval_seconds: 60,
	time_range: { type: "relative", value: "24h" },
	widgets: [
		Maple.DashboardWidget.make({
			id: "requests",
			visualization: "stat",
			data_source: {
				kind: "raw_sql",
				sql: "SELECT count() AS value FROM traces WHERE $__orgFilter",
				transform: { reduce_to_value: { field: "value", aggregate: "first" } },
			},
			display: { title: "Requests" },
			layout: { x: 0, y: 0, w: 3, h: 4 },
		}),
	],
})

yield *
	Maple.Dashboard("service-health", {
		...data,
		dashboardId: "dash_existing",
	})
```

`dashboardId` pins an existing dashboard: a missing or invalid ID fails deployment
instead of creating a substitute. Alchemy adopts it on the first deployment and
manages subsequent updates and deletion. The ID cannot be changed after deployment;
removing the prop keeps the remembered identity. Omit it initially to create a new
dashboard. Refresh accepts `0`, `5`, `10`, `30`, `60`, `300`, `900`, or `null`; `0`
and `null` disable automatic refresh.

## Worker telemetry

`Maple.Telemetry` exports a Cloudflare Worker's traces, logs and metrics to Maple through the
Maple SDK, the way `Axiom.Telemetry` wraps alchemy's built-in exporter. Provide it on the
Worker's init Effect: at deploy time it binds the ingest key (as a secret), endpoint and
environment onto the Worker; at runtime alchemy's bridge builds the SDK into every event's
request scope, traces the request with it, and flushes after the response.

```typescript
import * as Cloudflare from "alchemy/Cloudflare"
import * as Maple from "@maple-dev/alchemy"
import { Telemetry } from "@maple-dev/alchemy/telemetry"
import { Effect } from "effect"

const Ingest = Maple.IngestKeys("ingest")

export default Cloudflare.Worker(
	"api",
	{ main: import.meta.url },
	Effect.gen(function* () {
		// ...
	}).pipe(Effect.provide(Telemetry({ serviceName: "api", ingestKey: Ingest }))),
)
```

The `@maple-dev/alchemy/telemetry` subpath keeps the API client out of the Worker bundle.
Omit `ingestKey` when the Worker's env already carries `MAPLE_INGEST_KEY`, or when `endpoint`
points at a local `maple start` or your own collector, which take keyless writes; the remaining
options (`anticipatedErrorIdentifiers`, `dropSpanNames`, `serviceNamespace`, …) are the SDK's
Cloudflare options, forwarded unchanged.

Full docs: [maple.dev/docs/iac/alchemy](https://maple.dev/docs/iac/alchemy).

## Notes

- Alert rules reserve one of Maple's 20 tag slots for an `alchemy:` ownership tag, leaving up to 19 user tags. Keep the ownership tag intact. To take over an existing rule deliberately, wrap the resource in Alchemy's `adopt(true)` or deploy with `--adopt`. Use distinct rule names for different stages in the same Maple organization.
- Existing tracked dashboards and rules gain configuration snapshots on their next deploy; existing tracked rules also gain an ownership tag. If an older rule's state was lost before it had ownership tags, recovery requires explicit adoption.
- `alchemy sync` restores declared dashboard fields and alert-rule configuration. Fields omitted from those props remain unmanaged. Alert destinations default to `enabled: true` on both create and update.
- Store your Alchemy state somewhere durable: the `ApiKey.secret` output lives only there.
- The client retries 429/5xx with bounded exponential backoff (the v2 API allows 600 requests per 60s per key).
- Deleting an `AlertDestination` fails with a conflict while alert rules still reference it — Alchemy's dependency ordering handles this automatically when the rule is declared in the same stack.
