---
title: "WarpStream"
description: "Monitor WarpStream clusters in Maple — scrape agent /metrics endpoints directly or pull consumer lag, request latency, and object-store health from WarpStream's hosted Prometheus endpoint."
group: "Integrations"
order: 1
---

WarpStream exposes rich Prometheus metrics in two places: every Agent serves a local `/metrics` endpoint, and the WarpStream control plane offers a hosted, authenticated Prometheus endpoint per virtual cluster. Both work with [Maple's Prometheus scraping](/docs/integrations/prometheus) — pick the one that matches your network topology.

## Option A: Hosted Prometheus endpoint (recommended)

The control plane aggregates cluster health — consumer group lag, partition sizes, agent heartbeats — behind a single internet-reachable URL, so Maple can scrape it with no network changes on your side:

```
https://api.warpstream.com/api/v1/monitoring/prometheus/virtual_clusters/$VIRTUAL_CLUSTER_ID
```

1. In WarpStream, create a **read-only Agent Key** for the cluster (least privilege; an account-level API key also works if you want one key for several clusters).
2. In Maple, open **Integrations → WarpStream** (or **Prometheus**), click **Add Target**, and configure:
    - **URL**: the hosted endpoint above, with your virtual cluster ID (`vci_…`)
    - **Authentication**: `Basic Auth` — username `prometheus`, password = the API key
    - **Scrape Interval**: 30–60s is plenty for control-plane metrics
    - **Labels**: e.g. `{"cluster": "prod-kafka"}` to tag every series

See WarpStream's [Hosted Prometheus Endpoint docs](https://docs.warpstream.com/warpstream/agent-setup/monitor-the-warpstream-agents/hosted-prometheus-endpoint) for the metric set, which includes Tableflow and Schema Registry metrics on those cluster types.

## Option B: Scrape the Agents directly

Each WarpStream Agent serves the full agent-level metric set (request latency histograms, produce/fetch byte counters, object-store operation latency) on its internal port — no authentication, enabled by default:

```
http://$AGENT_IP:8080/metrics
```

Because Agents run inside your VPC under WarpStream's BYOC model, Maple's scraper can only reach them if you expose the endpoint (for example through an internal load balancer with auth, which you can pair with Maple's bearer/basic auth options). If the Agents are fully private, run an OpenTelemetry Collector next to them with a `prometheus` receiver scraping `:8080/metrics` and an OTLP exporter pointed at Maple's ingest gateway instead.

Add one Maple target per agent (or per load-balanced agent pool), with the agent host in **URL** and a `{"cluster": "...", "agent": "..."}` label set to keep series distinguishable.

## Metrics worth alerting on

All WarpStream metrics carry the `warpstream_` prefix. From WarpStream's [Important Metrics and Logs](https://docs.warpstream.com/warpstream/agent-setup/monitor-the-warpstream-agents/important-metrics-and-logs):

| Metric                                                                 | Why it matters                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `warpstream_consumer_group_lag`                                        | Consumer lag in offsets — the canonical "are we keeping up" gauge.          |
| `warpstream_agent_kafka_request_latency`                               | Produce/fetch latency histogram by request type.                            |
| `warpstream_agent_kafka_request_outcome`                               | Success vs. error counters per Kafka request type.                          |
| `warpstream_blob_store_operation_latency`                              | Object-store PUT/GET health — the first thing to check when latency spikes. |
| `warpstream_agent_control_plane_operation_latency`                     | Agent ↔ control-plane RPC health.                                           |
| `warpstream_topics_count` / `warpstream_partitions_count` (+ `_limit`) | Headroom against cluster limits.                                            |

Once samples arrive, build dashboards and alert rules on these like any other Maple metric — e.g. an alert on `warpstream_consumer_group_lag` above a threshold for 5 minutes.

## Troubleshooting

- **401 from the hosted endpoint** — the Basic Auth username must be exactly `prometheus`; the password is the API/Agent key.
- **Timeouts scraping agents** — confirm the agent's internal port (defaults to 8080; it follows the Kinesis port if overridden) and that Maple can reach it; `curl $AGENT_IP:8080/v1/status` should return `OK`.
- Use the target's **Test** button in Maple to see the exact upstream error.
