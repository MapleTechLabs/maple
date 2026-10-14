---
title: "Set up span attributes"
description: "Which attributes to add so Maple can link telemetry to GitHub commits, draw database nodes, group query shapes, and name caches, queues and users. With code for Node.js, Python and Go."
group: "Instrumentation"
navLabel: "Span attributes"
order: 0.5
---

Auto-instrumentation gets spans into Maple. A handful of attributes decide how much Maple can do with them: link a trace to the commit that served it, put your database on the service map, group thousands of statements into a few query shapes. This page shows what to add for each feature and where to add it.

For the full list of attributes Maple reads and how each one is rendered, see [OpenTelemetry conventions](/docs/concepts/otel-conventions).

## Checklist

| Feature                                                   | Attributes                                                                     | Set on                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------- |
| Commit hover cards, deploy markers, Releases, Last deploy | `vcs.ref.head.revision`                                                        | Resource                    |
| Source code access for the AI assistant and MCP tools     | `vcs.repository.url.full`                                                      | Resource                    |
| Per-version and per-environment slices                    | `service.version`, `deployment.environment.name`                               | Resource                    |
| Database nodes on the service map                         | `db.system.name`, `db.namespace`                                               | `Client` span               |
| Database query shapes                                     | `db.query.summary`, `db.query.text`, `db.operation.name`, `db.collection.name` | `Client` span               |
| Queue and RPC dependencies                                | `messaging.system`, `messaging.destination.name`, `rpc.system`, `rpc.service`  | `Client` or `Producer` span |
| Cache hit/miss badges                                     | `cache.system`, `cache.result`, `cache.operation`                              | Any span                    |
| User context on logs and spans                            | `user.id`                                                                      | Any span                    |

**Resource** attributes describe the process. Set them once when you configure the SDK and every span, log and metric carries them. **Span** attributes describe one operation and are set where the span is created.

## Link telemetry to GitHub

Two resource attributes connect your telemetry to your code:

| Attribute                 | Example                                    | What it unlocks                                                                                                                                   |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vcs.ref.head.revision`   | `c0b92f68e1d4a7b3f9c2e5d8a1b4c7e0f3a6d9b2` | Commit hover card on traces and services, deploy markers on service charts, **Recent deploys**, the **Releases** page, the **Commit SHA** filter. |
| `vcs.repository.url.full` | `https://github.com/acme/api`              | Tells the AI assistant and the [MCP source tools](/docs/reference/mcp) which repository to read when it investigates an error.                    |

Use the full 40-character SHA. Maple resolves the SHA against commits synced by the [GitHub integration](/docs/integrations/github), and a short SHA does not resolve to a hover card. Deploy markers and the Releases page work without the integration. The hover card (author, message, link to GitHub) needs it.

Use these keys exactly. Legacy spellings like `git.commit`, `deployment.commit_sha` or `app.repo_url` are not read.

### Get the SHA at build or deploy time

Read the commit from your CI or hosting platform. Do not shell out to `git` at runtime, since most deploy images do not contain the `.git` directory.

| Platform                  | Variable                 |
| ------------------------- | ------------------------ |
| GitHub Actions            | `GITHUB_SHA`             |
| GitLab CI                 | `CI_COMMIT_SHA`          |
| Vercel                    | `VERCEL_GIT_COMMIT_SHA`  |
| Railway                   | `RAILWAY_GIT_COMMIT_SHA` |
| Render                    | `RENDER_GIT_COMMIT`      |
| Cloudflare Pages          | `CF_PAGES_COMMIT_SHA`    |
| Cloudflare Workers Builds | `WORKERS_CI_COMMIT_SHA`  |

Platform variables are often only present during the build. If your runtime does not see them, bake the SHA in. For a Docker image:

```dockerfile
ARG GIT_SHA
ENV OTEL_RESOURCE_ATTRIBUTES="vcs.ref.head.revision=${GIT_SHA},vcs.repository.url.full=https://github.com/acme/api"
```

```bash
docker build --build-arg GIT_SHA=$(git rev-parse HEAD) .
```

For a bundled frontend, inject it as a build-time constant (for example `VITE_COMMIT_SHA` or `NEXT_PUBLIC_COMMIT_SHA`) and pass it to the browser SDK's resource.

### Set the resource attributes

The shortest path is the standard environment variable, which every OpenTelemetry SDK reads:

```bash
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=production,service.version=1.4.2,vcs.repository.url.full=https://github.com/acme/api,vcs.ref.head.revision=$GITHUB_SHA"
```

Or set them in code.

**Node.js**

```javascript
import { NodeSDK } from "@opentelemetry/sdk-node"
import { resourceFromAttributes } from "@opentelemetry/resources"

const sdk = new NodeSDK({
	resource: resourceFromAttributes({
		"service.name": "api",
		"service.version": process.env.APP_VERSION,
		"deployment.environment.name": process.env.NODE_ENV ?? "development",
		"vcs.repository.url.full": "https://github.com/acme/api",
		"vcs.ref.head.revision": process.env.GITHUB_SHA,
	}),
	// exporters and instrumentations...
})
```

**Python**

```python
import os
from opentelemetry.sdk.resources import Resource

resource = Resource.create({
    "service.name": "api",
    "service.version": os.getenv("APP_VERSION", ""),
    "deployment.environment.name": os.getenv("APP_ENV", "development"),
    "vcs.repository.url.full": "https://github.com/acme/api",
    "vcs.ref.head.revision": os.getenv("GITHUB_SHA", ""),
})
```

**Go**

```go
res, err := resource.New(ctx,
	resource.WithFromEnv(), // still reads OTEL_RESOURCE_ATTRIBUTES
	resource.WithAttributes(
		attribute.String("service.name", "api"),
		attribute.String("deployment.environment.name", os.Getenv("APP_ENV")),
		attribute.String("vcs.repository.url.full", "https://github.com/acme/api"),
		attribute.String("vcs.ref.head.revision", os.Getenv("GIT_SHA")),
	),
)
```

Then [connect the GitHub App](/docs/integrations/github) and deploy. Open a trace from the new deploy and hover the short SHA in its header.

## Databases

Database spans drive two things: the database node on the [service map](/docs/explore/service-map), and the **Top query shapes** list in a database node's panel. The MCP tool `db_query_volume` ranks the same shapes by call volume, with errors and latency.

### Use the instrumentation library first

Most drivers have an OpenTelemetry instrumentation that sets every attribute below for you. Check that it is enabled before adding anything by hand:

- **Node.js:** `@opentelemetry/auto-instrumentations-node` covers `pg`, `mysql2`, `mongodb`, `ioredis`, `redis` and more. Prisma ships its own (`@prisma/instrumentation`). Drizzle and Kysely run on top of `pg` or `mysql2`, so the driver instrumentation covers them.
- **Python:** the `opentelemetry-instrumentation-*` packages for `psycopg`, `asyncpg`, `sqlalchemy`, `pymongo` and `redis`. `opentelemetry-bootstrap -a install` installs the ones matching your dependencies.
- **Go:** `github.com/XSAM/otelsql` wraps `database/sql`, `github.com/exaring/otelpgx` wraps `pgx`.
- **Java:** the OpenTelemetry Java agent instruments JDBC, Hibernate, R2DBC and the Mongo and Redis clients.

Older instrumentations still emit the legacy `db.system`, `db.name` and `db.statement` keys. Maple reads both spellings, so you do not need to upgrade just for Maple.

### Attributes

| Attribute                                    | Example                                   | What Maple does with it                                                                              |
| -------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `db.system.name` (legacy `db.system`)        | `postgresql`, `mysql`, `mongodb`, `redis` | **Required.** Marks the span as a database call. Without it the call is an HTTP or other dependency. |
| `db.namespace` (legacy `db.name`)            | `users_db`                                | With `db.system.name`, keys the database node. Falls back to `server.address`.                       |
| `server.address`                             | `db.internal`                             | Fallback node identity when `db.namespace` is missing.                                               |
| `db.query.text` (legacy `db.statement`)      | `SELECT * FROM users WHERE id = $1`       | Shown in span detail. Normalized into a query shape when no summary or fingerprint is set.           |
| `db.query.summary`                           | `SELECT users`                            | Preferred label for the query shape.                                                                 |
| `db.operation.name` (legacy `db.operation`)  | `SELECT`, `HSET`                          | With `db.collection.name`, builds the label when there is no summary.                                |
| `db.collection.name` (legacy `db.sql.table`) | `users`                                   | The table or collection in the composed label.                                                       |
| `db.query.fingerprint`                       | `a1b2c3d4`                                | Overrides how statements are grouped. Spans with the same fingerprint are one shape.                 |

The span kind must be `Client`. Maple builds database nodes and dependencies only from `Client` and `Producer` spans.

Keep `db.system.name` spelled the same in every service. `postgresql` in one service and `Postgres` in another draws two nodes. Use the [well-known values](https://opentelemetry.io/docs/specs/semconv/registry/attributes/db/#db-system-name) from the spec.

### How queries are grouped

Maple labels each database span with the first of these that is present:

1. `db.query.summary`
2. `db.operation.name` + `db.collection.name` (or `db.namespace`), for example `SELECT users`
3. The verb and first table parsed from `db.query.text`
4. `db.operation.name`
5. The span name

It groups spans by `db.query.fingerprint` when set. Otherwise it normalizes `db.query.text`: lowercases it, replaces string and number literals with `?`, collapses `IN (...)` lists, and hashes the result. `WHERE id = 1` and `WHERE id = 2` land in the same shape.

Two consequences:

- **Send `db.query.text`.** It gives the best grouping and lets you see the actual statement. Prefer parameterized statements (`$1`, `?`) so no user data ends up in the attribute. Most instrumentations record the statement with placeholders, not bound values.
- **Do not name database spans `execute` or `query`.** A conformant span name is the summary (`SELECT users`). A generic name is the label of last resort and tells you nothing.

### Manual database spans

If your driver has no instrumentation, wrap the call yourself.

**Node.js**

```javascript
import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api"

const tracer = trace.getTracer("db")

export function findUser(id) {
	return tracer.startActiveSpan(
		"SELECT users",
		{
			kind: SpanKind.CLIENT,
			attributes: {
				"db.system.name": "postgresql",
				"db.namespace": "users_db",
				"db.operation.name": "SELECT",
				"db.collection.name": "users",
				"db.query.text": "SELECT * FROM users WHERE id = $1",
				"server.address": "db.internal",
			},
		},
		async (span) => {
			try {
				return await pool.query("SELECT * FROM users WHERE id = $1", [id])
			} catch (error) {
				span.recordException(error)
				span.setStatus({ code: SpanStatusCode.ERROR })
				throw error
			} finally {
				span.end()
			}
		},
	)
}
```

**Python**

```python
from opentelemetry import trace
from opentelemetry.trace import SpanKind

tracer = trace.get_tracer("db")

def find_user(user_id):
    with tracer.start_as_current_span(
        "SELECT users",
        kind=SpanKind.CLIENT,
        attributes={
            "db.system.name": "postgresql",
            "db.namespace": "users_db",
            "db.operation.name": "SELECT",
            "db.collection.name": "users",
            "db.query.text": "SELECT * FROM users WHERE id = %s",
        },
    ):
        return cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))
```

**Go**

```go
ctx, span := tracer.Start(ctx, "SELECT users",
	trace.WithSpanKind(trace.SpanKindClient),
	trace.WithAttributes(
		attribute.String("db.system.name", "postgresql"),
		attribute.String("db.namespace", "users_db"),
		attribute.String("db.operation.name", "SELECT"),
		attribute.String("db.collection.name", "users"),
		attribute.String("db.query.text", "SELECT * FROM users WHERE id = $1"),
	),
)
defer span.End()
```

Databases behind Cloudflare Hyperdrive report an opaque config ID as their name. Maple folds those into one **Hyperdrive** node, so you do not need to override `db.namespace` there. PlanetScale databases are marked on their nodes when the [PlanetScale integration](/docs/integrations/planetscale) is connected.

## Caches

A span with `cache.system` or `cache.result` gets a hit/miss badge and an operation pill in the trace view. Set them on the span that wraps the lookup:

```javascript
span.setAttributes({
	"cache.system": "redis",
	"cache.name": "user-sessions",
	"cache.operation": "GET",
	"cache.result": value === null ? "miss" : "hit",
})
```

If the cache is Redis or Memcached, the client span from the driver instrumentation is still the database call. Put the `cache.*` attributes on the application span around it, where you know whether it was a hit.

## Queues and RPC

Outbound calls that are not HTTP or databases are listed on the service's **Dependencies** tab, named from these attributes:

| Call type | Span kind  | Attributes                                       |
| --------- | ---------- | ------------------------------------------------ |
| Messaging | `Producer` | `messaging.system`, `messaging.destination.name` |
| RPC       | `Client`   | `rpc.system`, `rpc.service`, `rpc.method`        |

```javascript
tracer.startActiveSpan(
	"publish orders",
	{
		kind: SpanKind.PRODUCER,
		attributes: {
			"messaging.system": "kafka",
			"messaging.destination.name": "orders",
		},
	},
	(span) => {
		// inject trace context into the message headers, then send
		span.end()
	},
)
```

When the consumer is instrumented too and reads the trace context from the message, Maple draws a service-to-service edge from the producer to the consumer on the service map.

## Users

Put the signed-in user on the request span so you can filter traces and logs by user:

```javascript
trace.getActiveSpan()?.setAttribute("user.id", user.id)
```

`user.id`, `enduser.id`, `customer.id` and `customer_id` are promoted to the attribute chips on log rows. Use an internal ID, not an email address.

## Custom attributes

Anything else you send is stored and queryable. Filter on it in the trace and log search bars, and group by it in dashboards. Namespace your keys (`checkout.cart_size`, not `cartSize`) and keep values low-cardinality when you plan to group by them.

Do not use the `maple_` prefix. It is reserved for Maple internals.

## Verify

1. Open a trace from a fresh deploy. The header shows the short commit SHA, and hovering it shows the commit when the GitHub integration is connected.
2. Open the [service map](/docs/explore/service-map). Each database shows up as its own node, named after `db.system.name` and `db.namespace`.
3. Click a database node. The **Top query shapes** list shows readable shapes such as `SELECT users`, not `execute`.
4. Ask the assistant to audit your setup. The MCP server's `get_instrumentation_recommendations` tool lists missing resource attributes and legacy keys to rename, from your live data. In Claude Code, the [maple-audit skill](https://github.com/MapleTechLabs/maple/tree/main/skills/maple-audit) does the same per service and fixes the gaps.

## Troubleshooting

- **The SHA shows but has no hover card.** It must be the full 40-character SHA of a commit on a synced tracked branch. See [GitHub troubleshooting](/docs/integrations/github#troubleshooting).
- **No deploy markers or Releases.** `vcs.ref.head.revision` is missing or set as a span attribute instead of a resource attribute. Set it on the resource.
- **All databases collapse into one node.** `db.namespace` and `server.address` are both missing. Set `db.namespace`.
- **The database appears as an HTTP dependency.** `db.system.name` is missing, or the span kind is not `Client`.
- **Every query shape is `execute`.** The driver sends neither a summary nor the statement text. Enable statement capture in the instrumentation, or set `db.query.summary` yourself.

## Next steps

- [OpenTelemetry conventions](/docs/concepts/otel-conventions): every attribute Maple reads.
- [GitHub](/docs/integrations/github): connect your repositories.
- [Service map](/docs/explore/service-map): where database and service edges show up.
