---
title: "Cloudflare Workers instrumentation"
description: "Send traces and logs from any Cloudflare Worker to Maple with Workers Observability OTLP destinations. No SDK or code changes."
group: "Instrumentation"
order: 4.5
navLabel: "Cloudflare Workers (native)"
---

Cloudflare Workers Observability can export a Worker's traces and logs over OTLP to any endpoint. This guide points that export at Maple. The Workers runtime records the spans itself, so there is no SDK to install, no exporter to flush in `ctx.waitUntil`, and no code to change. It works for any Worker, whatever language or framework it is written in.

If your Worker is written with Effect, the [Effect SDK for Cloudflare Workers](/docs/sdks/effect-cloudflare) gives you your own spans, logs and metrics as well. Both can run on the same Worker.

## What you get

Cloudflare records these automatically:

- **Handler spans** for `fetch`, `scheduled` and `queue` invocations.
- **Outbound `fetch` calls**, with timing and status code.
- **Binding calls**, such as KV and R2 operations and Durable Object invocations, including RPC to Durable Objects.
- **Logs** from `console.log`, `console.error` and the other `console` methods, plus the invocation log for each request.

Spans carry Cloudflare attributes (`cloudflare.script_name`, `cloudflare.colo`, `cloudflare.ray_id`, `faas.trigger`, CPU and wall time, and more). Maple recognizes them and shows a **Cloudflare Worker** panel on the span, with the script, version, handler, CPU and wall time, TTFB, edge location and Ray ID.

Metrics are not exported this way. For Worker request counts, error rates and CPU time, connect the [Cloudflare integration](/docs/integrations/cloudflare), which pulls them from Cloudflare's analytics API.

## Prerequisites

- A Cloudflare account on the **Workers Paid** plan. OTLP export is not available on Workers Free. Cloudflare bills exported events beyond the included allowance; see Cloudflare's [pricing for exported events](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/).
- Permission to edit Workers Observability settings in the Cloudflare dashboard.
- An ingest key from **Settings → Ingestion** in Maple. Use the private key (`maple_sk_…`). It is stored in Cloudflare and never reaches the browser.
- Your organization's ingest endpoint: `https://ingest.maple.dev`, or `https://ingest.eu.maple.dev` for EU organizations.

## 1. Create the destinations

A destination carries one signal, so create two: one for traces and one for logs.

1. In the Cloudflare dashboard, open **Workers & Pages → Observability**, then the **Destinations** tab.
2. Click **Add destination** and fill in:

    | Field            | Value                                     |
    | ---------------- | ----------------------------------------- |
    | Destination name | `maple-traces`                            |
    | Destination type | Traces                                    |
    | OTLP endpoint    | `https://ingest.maple.dev/v1/traces`      |
    | Custom headers   | `Authorization`: `Bearer YOUR_INGEST_KEY` |

3. Save, then add a second destination for logs:

    | Field            | Value                                     |
    | ---------------- | ----------------------------------------- |
    | Destination name | `maple-logs`                              |
    | Destination type | Logs                                      |
    | OTLP endpoint    | `https://ingest.maple.dev/v1/logs`        |
    | Custom headers   | `Authorization`: `Bearer YOUR_INGEST_KEY` |

The endpoint is the full signal URL, not the base URL. Use `https://ingest.eu.maple.dev/v1/traces` and `https://ingest.eu.maple.dev/v1/logs` for EU organizations.

Destinations belong to the Cloudflare account, not to one Worker. Every Worker in the account can reference the same two.

## 2. Point your Worker at them

Add an `observability` block to the Worker's Wrangler config. The names must match the destination names exactly.

```jsonc
// wrangler.jsonc
{
	"observability": {
		"traces": {
			"enabled": true,
			"destinations": ["maple-traces"],
		},
		"logs": {
			"enabled": true,
			"destinations": ["maple-logs"],
		},
	},
}
```

Or in `wrangler.toml`:

```toml
[observability.traces]
enabled = true
destinations = ["maple-traces"]

[observability.logs]
enabled = true
destinations = ["maple-logs"]
```

Deploy with `wrangler deploy`. Export starts with the next invocation.

### Optional settings

Both `traces` and `logs` accept two more keys:

- **`head_sampling_rate`**: a number from `0` to `1`, the share of invocations to record. `1` (every invocation) is the default. For high-traffic Workers, `0.1` keeps cost down while leaving enough traces to investigate.
- **`persist`**: defaults to `true`, which also keeps the data in Cloudflare's own dashboard. Set it to `false` to send it only to Maple and skip Cloudflare's storage charges.

```jsonc
"traces": {
	"enabled": true,
	"destinations": ["maple-traces"],
	"head_sampling_rate": 0.1,
	"persist": false
}
```

## Verify

1. Send a few requests to the Worker.
2. In Maple, open **Explore → Traces** and filter by the service. Cloudflare names the service after the Worker script.
3. Each request is one trace: a root span for the handler, with `fetch` and binding spans nested under it. Click a span to see the **Cloudflare Worker** panel.
4. Open **Explore → Logs** to see `console` output from the same invocations.

The Worker also appears on the **Services** page once its first spans arrive.

## Things to know

- **Traces stop at the Worker.** Cloudflare does not yet propagate trace context to services outside Cloudflare, so a backend called by the Worker starts its own trace instead of joining the Worker's.
- **Some spans show 0 ms.** The Workers runtime only advances the clock on I/O, as a Spectre mitigation. Pure CPU work between two I/O calls reports no duration.
- **Non-2xx responses are marked `Error`.** Cloudflare sets the span status to `Error` for any non-2xx `fetch`, including 404s from bots probing `/wp-admin`. Maple does not open error issues for a 4xx span that has no exception attached, so this noise stays out of [Errors](/docs/errors/overview). 5xx responses and thrown exceptions still count.
- **Span and attribute names can change.** Cloudflare's tracing is in beta and its names are not final.

## Troubleshooting

- **Nothing arrives.** Check that the destination names in the Wrangler config match the dashboard exactly, that the Worker was redeployed after the change, and that the destination is enabled in **Observability → Destinations**.
- **`401` from the destination.** The key is wrong, was copied from the other region, or the header is malformed. The header name is `Authorization` and the value is `Bearer ` followed by the key. See [Ingest API status codes](/docs/reference/ingest#status-codes).
- **Traces arrive but logs do not (or the reverse).** Each destination handles one signal. Check that the traces destination uses `/v1/traces` with type **Traces**, and the logs destination uses `/v1/logs` with type **Logs**.
- **The Worker has no Cloudflare edge section on the service map.** With the [Cloudflare integration](/docs/integrations/cloudflare) connected, Maple matches the traced service to the script by service name or `faas.name`. Both come from Cloudflare, so this only breaks if the script was renamed.

## Next steps

- [Cloudflare integration](/docs/integrations/cloudflare): Worker metrics, zones, Queues and Durable Objects.
- [Effect SDK on Cloudflare Workers](/docs/sdks/effect-cloudflare): your own spans, logs and metrics from inside the Worker.
- [Explore traces](/docs/explore/traces)
- [Create alert rules](/docs/alerting/alert-rules)
