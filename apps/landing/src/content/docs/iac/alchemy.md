---
title: "Alchemy"
description: "Send a Cloudflare Worker's traces, logs and metrics to Maple from your alchemy.run.ts, then declare alerts and dashboards next to the infrastructure they watch."
group: "Infrastructure as Code"
order: 1
icon: "alchemy"
navLabel: "Alchemy"
---

`@maple-dev/alchemy` connects [Alchemy](https://alchemy.run) stacks to Maple. Add one layer to a Cloudflare Worker and every request is traced, with its logs and metrics, without touching the handler. When you want more, the same package declares Maple alert rules, dashboards and keys in your `alchemy.run.ts`, so they deploy with the service they observe.

|                   |                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Package           | [`@maple-dev/alchemy`](https://www.npmjs.com/package/@maple-dev/alchemy)                          |
| Peer dependencies | `alchemy >=2.0.0-beta.80 <3`, `effect ^4.0.0`                                                     |
| Source            | [packages/alchemy-maple](https://github.com/MapleTechLabs/maple/tree/main/packages/alchemy-maple) |

## Quick start

Get a Worker's telemetry into Maple in four steps.

### 1. Install

```bash
npm install @maple-dev/alchemy
```

`alchemy` and `effect` are peer dependencies, which your stack already has.

### 2. Register the provider

Merge `Maple.providers()` into your stack's providers. It lets the stack read your organization's ingest key, so you never copy it by hand.

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Maple from "@maple-dev/alchemy"
import { Effect, Layer } from "effect"
import Api from "./src/worker.ts"

export default Alchemy.Stack(
	"my-app",
	{ providers: Layer.mergeAll(Cloudflare.providers(), Maple.providers()) },
	Effect.gen(function* () {
		yield* Api
	}),
)
```

### 3. Add telemetry to the Worker

Declare the ingest keys once, then provide `Telemetry` on the Worker's init Effect:

```typescript
// src/maple.ts
import * as Maple from "@maple-dev/alchemy"

export const Ingest = Maple.IngestKeys("ingest")
```

```typescript
// src/worker.ts
import * as Cloudflare from "alchemy/Cloudflare"
import { Telemetry } from "@maple-dev/alchemy/telemetry"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/http"
import { Ingest } from "./maple.ts"

export default Cloudflare.Worker(
	"api",
	{ main: import.meta.url },
	Effect.gen(function* () {
		const fetch = Effect.succeed(HttpServerResponse.text("Hello from Maple"))
		return { fetch }
	}).pipe(Effect.provide(Telemetry({ serviceName: "api", ingestKey: Ingest }))),
)
```

That is the whole integration. Each request becomes a server span, Effect logs and spans inside the handler are attached to it, and the batch is sent after the response so it adds no latency.

### 4. Deploy

Create an API key in **Settings → Keys**. An org admin's key with full access is simplest; see [Authentication](#authentication) for the minimum scopes. Then deploy:

```bash
MAPLE_API_KEY=maple_ak_… alchemy deploy
```

Send a request to the Worker and open [Traces](/docs/explore/traces) in Maple. The `api` service appears within a few seconds.

> **Already have the ingest key in the Worker's env?** If `MAPLE_INGEST_KEY` is set on the Worker another way, call `Telemetry({ serviceName: "api" })` without `ingestKey`. You then don't need `Maple.providers()` or an API key at all.

## Telemetry options

`Telemetry` binds these onto the Worker at deploy time:

| Option        | Bound as                    | Notes                                                                                 |
| ------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| `ingestKey`   | `MAPLE_INGEST_KEY` (secret) | A `Maple.IngestKeys` resource (its private key is used) or a `Redacted` key           |
| `endpoint`    | `MAPLE_ENDPOINT`            | Defaults to `https://ingest.maple.dev`. Use `https://ingest.eu.maple.dev` for EU orgs |
| `environment` | `MAPLE_ENVIRONMENT`         | Becomes `deployment.environment.name`, e.g. your Alchemy stage                        |

Every other option (`serviceName`, `serviceNamespace`, `dropSpanNames`, `anticipatedErrorIdentifiers`, …) is the Effect SDK's and is forwarded unchanged. See [Effect SDK on Cloudflare Workers](/docs/sdks/effect-cloudflare) for the full list.

Import `Telemetry` from the `/telemetry` subpath, not the package root, so the Maple API client stays out of the Worker bundle.

## Add alerts and dashboards

The same stack can declare what you watch the Worker with. Add a notification channel, an alert rule that delivers to it, and a dashboard:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Maple from "@maple-dev/alchemy"
import { Effect, Layer, Redacted } from "effect"
import Api from "./src/worker.ts"

export default Alchemy.Stack(
	"my-app",
	{ providers: Layer.mergeAll(Cloudflare.providers(), Maple.providers()) },
	Effect.gen(function* () {
		yield* Api

		const oncall = yield* Maple.AlertDestination("oncall", {
			type: "pagerduty",
			name: "On-call PagerDuty",
			integration_key: Redacted.make(process.env.PAGERDUTY_ROUTING_KEY!),
		})

		// Alchemy creates the destination first, because the rule uses its output.
		yield* Maple.AlertRule("api-errors", {
			name: "API error rate",
			severity: "critical",
			signal_type: "error_rate",
			comparator: "gt",
			threshold: 0.05, // error rates are 0-1 ratios
			window_minutes: 5,
			service_names: ["api"],
			destination_ids: [oncall.destinationId],
		})

		yield* Maple.Dashboard("api-health", {
			name: "API health",
			tags: ["api"],
			time_range: { type: "relative", value: "12h" },
		})
	}),
)
```

Change a threshold and redeploy, and the rule is updated in place. Remove it from the stack and the next deploy deletes it.

| Resource                                                                      | What it manages                                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| [`Maple.Dashboard`](/docs/iac/alchemy-resources#mapledashboard)               | Dashboards, their widgets, sections and variables        |
| [`Maple.AlertDestination`](/docs/iac/alchemy-resources#maplealertdestination) | PagerDuty, webhook, Discord, Telegram and email channels |
| [`Maple.AlertRule`](/docs/iac/alchemy-resources#maplealertrule)               | Alert rules on any signal, delivering to destinations    |
| [`Maple.ApiKey`](/docs/iac/alchemy-resources#mapleapikey)                     | Scoped API keys, with in-place rotation                  |
| [`Maple.IngestKeys`](/docs/iac/alchemy-resources#mapleingestkeys)             | Your organization's ingest keys, as outputs (read-only)  |

Every prop and output is in [Alchemy resources](/docs/iac/alchemy-resources).

## Authentication

`Maple.providers()` reads two environment variables at deploy time:

| Variable        | Required | Default                 | Meaning                                                                             |
| --------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `MAPLE_API_KEY` | Yes      |                         | A `maple_ak_…` API key with the scopes your resources need                          |
| `MAPLE_API_URL` | No       | `https://api.maple.dev` | API base URL. Use `https://api.eu.maple.dev` for [EU](/docs/reference/regions) orgs |

The key needs these permissions, depending on which resources the stack declares:

| Resource                                    | Scope              | Org admin key |
| ------------------------------------------- | ------------------ | ------------- |
| `Maple.IngestKeys` (used by `Telemetry`)    | `ingest_keys:read` | Yes           |
| `Maple.Dashboard`                           | `dashboards:write` | No            |
| `Maple.AlertRule`, `Maple.AlertDestination` | `alerts:write`     | Yes           |
| `Maple.ApiKey`                              | `api_keys:write`   | Yes           |

A key with no scopes has full access. See [API keys and scopes](/docs/reference/api#authentication).

### Custom configuration or transport

`Maple.providers()` reads the environment and uses the runtime's global `fetch`. To source the key elsewhere, point at another deployment, or use your own `HttpClient`, build the providers with `providersWithDependencies()` and supply both services yourself:

```typescript
import * as Maple from "@maple-dev/alchemy"
import { Layer, Redacted } from "effect"
import { HttpClient } from "effect/http"

const mapleProviders = Maple.providersWithDependencies().pipe(
	Layer.provide(
		Layer.succeed(Maple.MapleEnvironment, {
			baseUrl: "https://api.eu.maple.dev",
			apiKey: Redacted.make(mySecretStore.get("maple")),
		}),
	),
	Layer.provide(Layer.succeed(HttpClient.HttpClient, myHttpClient)),
)
```

`Maple.MapleApiFromHttpClient()` gives you the same API client outside the Alchemy provider collection, for scripts that call the Maple API directly.

## Next steps

- [Alchemy resources](/docs/iac/alchemy-resources)
- [Alert rules](/docs/alerting/alert-rules)
- [Build dashboards](/docs/dashboards/build-dashboards)
- [Explore traces](/docs/explore/traces)
