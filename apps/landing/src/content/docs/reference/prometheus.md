---
title: "Prometheus API and Grafana"
description: "Query Maple metrics with PromQL through the Prometheus HTTP API, and add Maple to Grafana as a Prometheus data source."
group: "Reference"
order: 7.5
navLabel: "Prometheus API"
---

Maple serves the Prometheus HTTP query API over your metrics. Grafana, and any other tool that speaks to Prometheus, can query Maple with PromQL.

|                |                                                  |
| -------------- | ------------------------------------------------ |
| URL (US)       | `https://api.maple.dev/v2/metrics/prometheus`    |
| URL (EU)       | `https://api.eu.maple.dev/v2/metrics/prometheus` |
| Auth           | `Authorization: Bearer maple_ak_…`               |
| Required scope | `metrics:read`                                   |

## Connect Grafana

1. Create an [API key](/docs/reference/authentication) with the `metrics:read` scope.
2. In Grafana, go to **Connections > Data sources > Add data source** and pick **Prometheus**.
3. Set **Prometheus server URL** to `https://api.maple.dev/v2/metrics/prometheus` (or the EU URL).
4. Under **HTTP headers**, add a header named `Authorization` with the value `Bearer <your API key>`.
5. Leave **HTTP method** on POST, or pick GET. Both work.
6. Click **Save & test**.

Grafana's metric browser, label filters and query builder read the same API, so metric and label names autocomplete.

## Metric and label names

OpenTelemetry metrics get the names the Prometheus OTLP translation gives them: dots become underscores, the unit is added as a suffix, and monotonic sums end in `_total`. A sum `http.server.requests` is `http_server_requests_total`, and a histogram `http.server.duration` in seconds is `http_server_duration_seconds_bucket`, `_count` and `_sum`. The stored OpenTelemetry name also works.

Attributes become labels the same way (`http.route` is `http_route`). `job` is the service name, prefixed with `service.namespace/` when the service sets one, and `instance` is `service.instance.id`.

## Endpoints

All paths are under `/v2/metrics/prometheus/api/v1/` and follow Prometheus' parameters and response format.

| Endpoint              | Methods   |
| --------------------- | --------- |
| `query`               | GET, POST |
| `query_range`         | GET, POST |
| `series`              | GET, POST |
| `labels`              | GET, POST |
| `label/<name>/values` | GET       |
| `metadata`            | GET       |
| `query_exemplars`     | GET, POST |
| `status/buildinfo`    | GET       |

POST takes an `application/x-www-form-urlencoded` body. Exemplar queries return an empty list. A range query returns at most 11,000 points per series, as in Prometheus.

```bash
curl -H "Authorization: Bearer $MAPLE_API_KEY" \
  "https://api.maple.dev/v2/metrics/prometheus/api/v1/query" \
  --data-urlencode 'query=sum by (job) (rate(http_server_requests_total[5m]))'
```
