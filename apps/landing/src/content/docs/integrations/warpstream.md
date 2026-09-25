---
title: "WarpStream"
description: "Monitor WarpStream clusters in Maple. Scrape Agent /metrics endpoints directly, or pull consumer lag, request latency, and object-store health from WarpStream's hosted Prometheus endpoint."
group: "Integrations"
order: 1
---

WarpStream exposes Prometheus metrics in two places. Every Agent serves a local `/metrics` endpoint, and the WarpStream control plane offers a hosted, authenticated Prometheus endpoint per virtual cluster. Both work with [Maple's Prometheus scraping](/docs/integrations/prometheus). Pick the one that matches your network topology.

## Option A: Hosted Prometheus endpoint (recommended)

The control plane serves cluster health (consumer group lag, partition sizes, agent heartbeats) at a single internet-reachable URL. Maple can scrape it without network changes:

```
https://api.warpstream.com/api/v1/monitoring/prometheus/virtual_clusters/$VIRTUAL_CLUSTER_ID
```

1. In WarpStream, create a **read-only Agent Key** for the cluster (least privilege; an account-level API key also works if you want one key for several clusters).
2. In Maple, open **Integrations → WarpStream** (or **Prometheus**), click **Add Target**, and configure:
    - **URL**: the hosted endpoint above, with your virtual cluster ID (`vci_…`)
    - **Authentication**: **Basic Auth**, with **Username** `prometheus` and **Password** set to the API key
    - **Scrape Interval (seconds)**: 30 to 60 is enough for control-plane metrics

    To tag every series with a cluster name, set `labels_json` (for example `{"cluster": "prod-kafka"}`) through the [scrape targets API](/docs/integrations/prometheus#add-a-scrape-target).

See WarpStream's [Hosted Prometheus Endpoint docs](https://docs.warpstream.com/warpstream/agent-setup/monitor-the-warpstream-agents/hosted-prometheus-endpoint) for the metric set, which includes Tableflow and Schema Registry metrics on those cluster types.

## Option B: Scrape the Agents directly

Each WarpStream Agent serves the full agent-level metric set (request latency histograms, produce/fetch byte counters, object-store operation latency) on its internal port. The endpoint is enabled by default and has no authentication:

```
http://$AGENT_IP:8080/metrics
```

Because Agents run inside your VPC under WarpStream's BYOC model, Maple's scraper can only reach them if you expose the endpoint (for example through an internal load balancer with auth, which you can pair with Maple's **Bearer Token** or **Basic Auth** options). If the Agents are fully private, run an OpenTelemetry Collector next to them with a `prometheus` receiver scraping `:8080/metrics` and an OTLP exporter pointed at Maple's [ingest endpoint](/docs/reference/ingest) instead.

Add one Maple target per agent (or per load-balanced agent pool), with the agent host in **URL**. Every series already carries an `instance` attribute with the target host. To add cluster or agent names, set `labels_json` such as `{"cluster": "...", "agent": "..."}` through the API.

## Metrics worth alerting on

All WarpStream metrics carry the `warpstream_` prefix. From WarpStream's [Important Metrics and Logs](https://docs.warpstream.com/warpstream/agent-setup/monitor-the-warpstream-agents/important-metrics-and-logs):

| Metric                                                                 | Why it matters                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `warpstream_consumer_group_lag`                                        | Consumer lag in offsets. The main "are we keeping up" gauge.                |
| `warpstream_agent_kafka_request_latency`                               | Produce/fetch latency histogram by request type.                            |
| `warpstream_agent_kafka_request_outcome`                               | Success vs. error counters per Kafka request type.                          |
| `warpstream_blob_store_operation_latency`                              | Object-store PUT/GET health. Check this first when latency spikes.          |
| `warpstream_agent_control_plane_operation_latency`                     | Agent ↔ control-plane RPC health.                                           |
| `warpstream_topics_count` / `warpstream_partitions_count` (+ `_limit`) | Headroom against cluster limits.                                            |

Once samples arrive, build dashboards and alert rules on these like any other Maple metric. For example, alert when `warpstream_consumer_group_lag` stays above a threshold for 5 minutes.

## Troubleshooting

- **401 from the hosted endpoint.** The Basic Auth username must be exactly `prometheus`. The password is the API or Agent key.
- **Timeouts scraping Agents.** Confirm the Agent's internal port (8080 by default) and that the endpoint is reachable from the internet. `curl $AGENT_IP:8080/v1/status` should return `OK`.
- Use the target's **Test** button in Maple to see the exact upstream error.
