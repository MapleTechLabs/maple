---
title: "Prometheus scraping"
description: "Point Maple at any Prometheus exposition endpoint. Maple scrapes it on a schedule, converts the samples to OpenTelemetry metrics, and records the health of every scrape."
group: "Integrations"
order: 1
---

Maple can scrape any endpoint that serves the Prometheus or OpenMetrics text format. You add the endpoint as a scrape target. Maple polls it at the interval you choose, converts the samples to OpenTelemetry metrics, and ingests them like your own OTLP traffic. Scraped metrics appear in the [metrics explorer](/docs/explore/metrics), dashboards, and alert rules, and each target keeps a history of its scrapes.

## Prerequisites

- An endpoint reachable from the public internet that serves `/metrics` in the Prometheus exposition format.

## Add a scrape target

Open **Integrations → Prometheus** in Maple and click **Add Target**. The **Add Scrape Target** dialog has these fields:

| Field                         | Notes                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Name**                      | Display name. Used as the service name when **Service Name** is empty.                                                             |
| **Service Name**              | Optional. Sets `service.name` on the resource and the `job` attribute on every data point.                                         |
| **URL**                       | Full endpoint URL, for example `https://myapp.com:9090/metrics`. Loopback, private-range, and cloud-metadata addresses are rejected. |
| **Scrape Interval (seconds)** | 5 to 300. Default 15.                                                                                                              |
| **Authentication**            | **None**, **Bearer Token** (sent as `Authorization: Bearer …`), or **Basic Auth** (**Username** and **Password**).                 |

Credentials are encrypted at rest. The scraper receives the decrypted auth header from Maple's API for each run and sends it directly to your endpoint. Requests carry the user agent `maple-prometheus-scraper`.

Each request times out after the scrape interval minus one second, capped at 60 seconds.

You can also manage targets through the [REST API](/docs/reference/api) under `/v2/scrape_targets`, with endpoints to create, update, delete, probe, and list checks. The API accepts one extra field, `labels_json`: a JSON object of labels added to every sample (for example `{"cluster": "prod"}`). The keys `job` and `instance`, and any key starting with `maple_` or `__`, are reserved and rejected.

## How the data looks

- Metric names are kept as they appear in the exposition.
- Counters become cumulative monotonic sums. Gauges and untyped metrics become gauges. Histograms become OTLP histograms with the original bucket bounds.
- Summaries become three series: `<name>_sum` as a cumulative sum, `<name>_count` as a cumulative monotonic sum, and the quantiles as a gauge named `<name>` with a `quantile` attribute. Summary samples that are not finite numbers (such as a `NaN` quantile with no observations yet) are dropped.
- Every data point carries `job` (the service name) and `instance` (the host of the target URL), plus the target's labels and the sample's own labels.

## Verify

1. On the target row, click **Test**. Maple runs an immediate scrape and reports success or the exact failure: HTTP status, timeout, TLS or connection error.
2. Wait one scrape interval. The status badge changes from **No checks** to **Up**, and the row shows **Last scrape** with a relative time.
3. Open the target to see its check history. Each run lists **Time**, **State**, **Duration**, and **Samples**.
4. Search for one of your metric names in the [metrics explorer](/docs/explore/metrics).

## Troubleshooting

- **Status is Down.** Open the target. The error message and a **How to fix** hint explain the failure. A failed scrape never advances the last successful scrape time, so the data gap stays visible next to the error.
- **The URL is rejected.** The endpoint resolves to a loopback, private, or metadata address. Expose it through an authenticated public endpoint, or use the collector option below.
- **401 or 403.** Check the authentication type and credentials. Basic Auth sends the username and password exactly as entered.
- **The endpoint is only reachable inside your network.** Run an OpenTelemetry Collector inside the network with a `prometheus` receiver and an OTLP exporter pointed at Maple's [ingest endpoint](/docs/reference/ingest).

## Next steps

- [WarpStream](/docs/integrations/warpstream): scrape WarpStream Agents or the hosted Prometheus endpoint.
- [PlanetScale](/docs/integrations/planetscale): branch metrics discovered automatically.
- [Alert rules](/docs/alerting/alert-rules): alert on a scraped metric.
