---
title: "Prometheus API and Grafana"
description: "Query Maple metrics with PromQL through the Prometheus HTTP API, and add Maple to Grafana as a Prometheus data source."
group: "Reference"
order: 7.5
navLabel: "Prometheus API"
---

Maple serves the Prometheus HTTP query API over your metrics. Grafana, and any other tool that speaks to Prometheus, can query Maple with PromQL.

|                |                                                                                |
| -------------- | ------------------------------------------------------------------------------ |
| URL (US)       | `https://api.maple.dev/v2/metrics/prometheus`                                  |
| URL (EU)       | `https://api.eu.maple.dev/v2/metrics/prometheus`                               |
| Auth           | `Authorization: Bearer maple_ak_…`, or Basic auth with the key as the password |
| Required scope | `metrics:read`                                                                 |
| Rate limit     | 600 requests per minute per API key                                            |

## Connect Grafana

1. Create an [API key](/docs/reference/authentication) with the `metrics:read` scope.
2. In Grafana, go to **Connections > Data sources > Add data source** and pick **Prometheus**.
3. Set **Prometheus server URL** to `https://api.maple.dev/v2/metrics/prometheus` (or the EU URL).
4. Add the key in one of two ways:
    - Under **HTTP headers**, add a header named `Authorization` with the value `Bearer <your API key>`.
    - Or turn on **Basic authentication**, enter any user name, and paste the API key as the **Password**.
5. Leave **HTTP method** on POST, or pick GET. Both work.
6. Under **Performance**, set **Prometheus type** to Prometheus and **Prometheus version** to 3.x.
7. Click **Save & test**.

Grafana's metric browser, label filters and query builder read the same API, so metric and label names autocomplete.

### One key for every viewer

Grafana sends the data source's key with every query, whoever is looking at the dashboard. All viewers share that key's 600 requests per minute, and every query is recorded in Maple's audit log as that key.

A dashboard with many panels and template variables makes one request per panel and variable on each refresh, so a busy dashboard with a short refresh interval can reach the limit. Past it, Maple answers `429` with a `Retry-After` header and Grafana shows the error on the panel.

Use a dedicated key per Grafana instance, and a longer refresh interval on large dashboards.

### Provisioning

To set the data source up from a file, put this in Grafana's `provisioning/datasources/` directory with the key in the `MAPLE_API_KEY` environment variable:

```yaml
apiVersion: 1
datasources:
    - name: Maple
      type: prometheus
      access: proxy
      url: https://api.maple.dev/v2/metrics/prometheus
      jsonData:
          httpMethod: POST
          prometheusType: Prometheus
          prometheusVersion: 3.5.0
          httpHeaderName1: Authorization
      secureJsonData:
          httpHeaderValue1: Bearer ${MAPLE_API_KEY}
```

With Basic authentication instead of the header:

```yaml
apiVersion: 1
datasources:
    - name: Maple
      type: prometheus
      access: proxy
      url: https://api.maple.dev/v2/metrics/prometheus
      basicAuth: true
      basicAuthUser: maple
      jsonData:
          httpMethod: POST
          prometheusType: Prometheus
          prometheusVersion: 3.5.0
      secureJsonData:
          basicAuthPassword: ${MAPLE_API_KEY}
```

Basic auth is accepted only on the Prometheus API. The user name is ignored, and the password must be a Maple API key; a session token or a malformed header is refused with `401`.

## Metric and label names

OpenTelemetry metrics get the names the Prometheus OTLP translation gives them: dots become underscores, the unit is added as a suffix, and monotonic sums end in `_total`. A sum `http.server.requests` is `http_server_requests_total`, and a histogram `http.server.duration` in seconds is `http_server_duration_seconds_bucket`, `_count` and `_sum`. The stored OpenTelemetry name also works.

Attributes become labels the same way (`http.route` is `http_route`). `job` is the service name, prefixed with `service.namespace/` when the service sets one, and `instance` is `service.instance.id`.

To find a metric's name, open Grafana's **Metrics browser**, or list them all with `label/__name__/values`. The [metrics explorer](/docs/explore/metrics) shows the stored OpenTelemetry names and their types.

## Endpoints

All paths are under `/v2/metrics/prometheus/api/v1/` and follow Prometheus' parameters and response format. POST takes an `application/x-www-form-urlencoded` body, as Grafana sends it.

| Endpoint              | Methods   | Notes                                                                         |
| --------------------- | --------- | ----------------------------------------------------------------------------- |
| `query`               | GET, POST | Instant query.                                                                |
| `query_range`         | GET, POST | Range query.                                                                  |
| `series`              | GET, POST | Needs at least one `match[]`.                                                 |
| `labels`              | GET, POST |                                                                               |
| `label/<name>/values` | GET       | `__name__` lists metric names.                                                |
| `metadata`            | GET       | Type, help and unit from the metric catalog.                                  |
| `format_query`        | GET, POST | Pretty-prints a PromQL expression.                                            |
| `query_exemplars`     | GET, POST | Always an empty list.                                                         |
| `rules`               | GET       | Always an empty list: Maple evaluates no Prometheus rules.                    |
| `alerts`              | GET       | Always an empty list. Use [Maple alerts](/docs/alerting/alert-rules) instead. |
| `status/buildinfo`    | GET       | Reports Prometheus 3.5.0, so Grafana enables the matching features.           |
| `status/config`       | GET       | An empty configuration.                                                       |
| `status/flags`        | GET       | No flags.                                                                     |

```bash
curl -H "Authorization: Bearer $MAPLE_API_KEY" \
  "https://api.maple.dev/v2/metrics/prometheus/api/v1/query" \
  --data-urlencode 'query=sum by (job) (rate(http_server_requests_total[5m]))'
```

## Limits

| Limit                                   | Value                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Metric retention                        | 90 days. A `query_range` over a longer range is evaluated as asked; steps before the retention have no samples. |
| Points per series in `query_range`      | 11,000, as in Prometheus. Use a larger `step` for long ranges.                                                  |
| Series per query                        | 10,000                                                                                                          |
| Samples a query may load                | 5,000,000                                                                                                       |
| Samples in one response                 | 500,000                                                                                                         |
| How far back a query may read           | 400 days, counting range selectors, `offset`, `@` and subqueries                                                |
| Query length                            | 10,000 characters                                                                                               |
| Selectors per query, `match[]` per call | 20                                                                                                              |
| Metrics one selector may match          | 100                                                                                                             |
| Discovery window                        | The last 32 days of the requested range. Without `start` and `end`, the last hour (24 hours for `metadata`).    |
| Discovery results                       | 10,000 names, values or series per call                                                                         |
| Query time                              | 30 seconds in the metric store, or less with the `timeout` parameter                                            |

`labels`, `label/<name>/values` and `series` never fail on a long range: a dashboard set to the last 90 days fills its template variables from the most recent 32 days.

### Errors

Errors use Prometheus' envelope, `{"status":"error","errorType":"…","error":"…"}`:

| Status | `errorType`   | When                                                                                       |
| ------ | ------------- | ------------------------------------------------------------------------------------------ |
| 400    | `bad_data`    | The query does not parse, or a parameter is invalid.                                       |
| 422    | `execution`   | The query is valid but too large: too many series or samples, or more memory than allowed. |
| 503    | `timeout`     | The query ran past the `timeout` parameter or the 30 second limit.                         |
| 503    | `unavailable` | The metric store could not be reached. Retry.                                              |

For `execution` and `timeout`, narrow the selector with more label matchers, aggregate with `sum by (...)`, or use a larger `step`. Authentication and rate-limit errors (`401`, `403`, `429`) use the [v2 API error format](/docs/reference/api#errors) instead.

## Not supported

- Writing data: no remote write, and `/api/v1/admin/*` is not served. Send metrics with [OpenTelemetry](/docs/getting-started/quickstart) or [Prometheus scraping](/docs/integrations/prometheus).
- Recording and alerting rules: `rules` and `alerts` are always empty.
- Exemplars: `query_exemplars` is always empty.
- `parse_query`, `targets`, `status/tsdb`, `status/runtimeinfo` and the other status endpoints, and `label/<name>/values` over POST (Prometheus serves it as GET only too).
