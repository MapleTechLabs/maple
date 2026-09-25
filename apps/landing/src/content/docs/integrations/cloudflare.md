---
title: "Cloudflare"
description: "Connect a Cloudflare account with OAuth. Maple polls zone traffic, Workers, security, DNS, Queues, and Durable Objects analytics every 5 minutes and shows them under Infrastructure and on the service map."
group: "Integrations"
order: 6
---

The Cloudflare integration connects one or more Cloudflare accounts to Maple through OAuth. Maple polls Cloudflare's GraphQL Analytics API every 5 minutes and stores the results as OpenTelemetry metrics. You get zone traffic, cache, and latency; Workers invocations, errors, and CPU time; firewall and DNS activity; and Queues and Durable Objects stats. The data appears under **Infrastructure → Cloudflare**, on the service map, and in the [metrics explorer](/docs/explore/metrics). You do not need to set up Logpush or run an agent.

## Prerequisites

- You are an admin of the Maple organization.
- You can authorize OAuth applications on the Cloudflare account.

## Connect

1. Open **Integrations → Cloudflare** in Maple.
2. Click **Connect Cloudflare**. A Cloudflare consent screen opens in a popup.
3. Choose the accounts to share and approve. One authorization can cover several accounts.

The popup closes and the card lists your **Connected accounts**. Maple starts collecting right away.

### Permissions requested

| Scope                                                   | Used for                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `account-analytics.read`                                | Workers, Queues, and Durable Objects analytics.            |
| `analytics.read`                                        | Zone HTTP, firewall, and DNS analytics.                    |
| `zone.read`                                             | Listing your zones.                                        |
| `query-cache.read`                                      | Listing Hyperdrive configs for the service map. Optional.  |
| `account-settings.read`, `workers-scripts.read`, `workers-scripts.write`, `workers-observability.write`, `workers-observability-telemetry.write` | Also requested on the consent screen. Analytics collection needs only the three scopes above. |

Maple also requests `offline_access` so the connection can refresh its token without you reconnecting.

## What Maple collects

Maple reads these Cloudflare datasets in 5-minute buckets: HTTP requests (with breakdowns by path, country, and client), Workers invocations, firewall events, DNS queries, Queue backlog and consumers, and Durable Object invocations. On connect it backfills the last 24 hours, or less if your Cloudflare plan keeps less history.

The data is stored as metrics named `cloudflare.*`, for example:

| Metric                                           | Service name                   |
| ------------------------------------------------ | ------------------------------ |
| `cloudflare.http.requests`, `cloudflare.http.bytes`, `cloudflare.http.edge.ttfb`, `cloudflare.http.origin.duration` | `cloudflare/<zone name>` |
| `cloudflare.firewall.events`, `cloudflare.dns.queries` | `cloudflare/<zone name>`       |
| `cloudflare.worker.requests`, `cloudflare.worker.errors`, `cloudflare.worker.cpu_time`, `cloudflare.worker.duration` | `cloudflare-worker/<script name>` |
| `cloudflare.queue.backlog.messages`, `cloudflare.queue.consumer.concurrency` | `cloudflare-queue/<queue id>` |

Counters are delta sums per 5-minute bucket. Latency percentiles are gauges with a `quantile` attribute (`0.5`, `0.95`, `0.99`). Chart and alert on them like any other metric.

## Where the data shows

### Infrastructure → Cloudflare

- **Zones**: **Zone**, **Requests**, **Error rate**, **Cache hit**, **Bandwidth**, and **TTFB p99**, with more sort options (visits, TTFB p50, origin p99).
- **Workers**: **Script**, **Invocations**, **Error rate**, **CPU p99**, and **Duration p99**.
- **Platform**: Queues (backlog and consumers) and Durable Objects (requests and error rate).

Click a zone for its detail page:

- A stat rail with **Edge requests**, **5xx error rate**, **Bandwidth**, and **Visits**.
- Charts: **Requests by status class**, **Requests by cache status**, and **Latency percentiles**.
- **Security events by action** and a table of top security rules (**Rule**, **Source**, **Action**, **Host**, **Events**).
- **DNS queries by response code** and a table of query names with **Queries** and **NXDOMAIN** counts.

### Service map

When a Worker also sends traces, Maple matches the script to the traced service by service name or `faas.name`. The service's panel on the [service map](/docs/explore/service-map) then gets a **Cloudflare edge** section with edge-reported (unsampled) **Requests**, **Error Rate**, and CPU p99. Scripts without a matching traced service, and zones, do not create nodes of their own.

### Integrations → Cloudflare

The integration card shows each connected account, a **Zones** board with a status per zone (**Live**, **Issues**, **No data**, **Paused**, or **Disabled**) and 24-hour request counts, and a **Workers** card.

## Verify

Cloudflare publishes analytics in 5-minute batches and needs about 10 minutes before a batch is complete. The first numbers usually land within 15 minutes of connecting.

While you wait, **Infrastructure → Cloudflare** shows progress: **Finding your zones and Workers**, **Collecting your first Cloudflare data**, how many zones are reporting, and the backfill percentage. When data flows, it reads **Receiving Cloudflare data** and the zones table fills in.

## Troubleshooting

- **"No Cloudflare data has arrived" after 30 minutes.** Check that the zones received traffic in the last day and that the authorization included the accounts you expect. Reconnect to pick different accounts.
- **"Update access to collect analytics".** The connection predates a required scope. Click **Update access** and approve the new permissions.
- **"Cloudflare access was revoked".** Click **Reconnect**.
- **"Analytics isn't enabled for this zone in Cloudflare."** Enable analytics for the zone in Cloudflare.
- **"Some analytics aren't available on this Cloudflare plan."** Some datasets require a higher Cloudflare plan. Maple collects what your plan allows.
- **"This zone was removed from your Cloudflare account."** The zone no longer exists in the connected account.
- **A Worker has no Cloudflare edge section on the service map.** The Worker's traced `service.name` (or `faas.name`) must match its script name.

## Disconnect

On **Integrations → Cloudflare**, click **Disconnect** (or **Disconnect all** with several accounts). To change which accounts are connected, click **Reconnect** or **Edit accounts** and pick them again on Cloudflare's consent screen.

## Next steps

- [Service map](/docs/explore/service-map): Workers and Hyperdrive on the map.
- [Metrics](/docs/explore/metrics): chart any `cloudflare.*` metric.
- [Alert rules](/docs/alerting/alert-rules): alert on zone error rate or Worker errors.
