---
title: "Quickstart"
description: "Send your first trace to Maple in about five minutes, with a zero-code Node.js setup or a single curl request."
group: "Getting Started"
order: 2
---

You need a Maple account and either a Node.js app or a terminal with `curl`.

## 1. Sign up and pick a region

Sign up at [app.maple.dev](https://app.maple.dev). During onboarding you pick the region your organization lives in, US or EU. The region cannot be changed later, and each region has its own ingest endpoint:

| Region         | Ingest endpoint               |
| -------------- | ----------------------------- |
| United States  | `https://ingest.maple.dev`    |
| European Union | `https://ingest.eu.maple.dev` |

## 2. Copy your ingest key

Open **Settings → Ingestion** and copy the private key (`maple_sk_…`). It is for servers and scripts. The public key (`maple_pk_…`) is for browser code. Both can only send telemetry. See [Authentication](/docs/reference/authentication#ingest-keys).

## 3. Set the exporter variables

Every OpenTelemetry SDK reads these standard variables:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"   # EU: https://ingest.eu.maple.dev
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer YOUR_INGEST_KEY"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
export OTEL_SERVICE_NAME="quickstart"
```

The endpoint is the base URL. Exporters append `/v1/traces`, `/v1/logs` and `/v1/metrics` themselves.

## 4. Send a trace

### Node.js, no code changes

Install the auto-instrumentations package and start your app through its `register` entry point, in the same shell as the variables above:

```bash
npm install @opentelemetry/api @opentelemetry/auto-instrumentations-node
node --require @opentelemetry/auto-instrumentations-node/register app.js
```

Send a request to your app. Each incoming HTTP request becomes a trace, with child spans for outgoing calls and database queries. For ES module apps and the full setup with logs and metrics, see the [Node.js guide](/docs/guides/instrumentation-nodejs).

Using another language? Pick its guide from [Instrument your application](/docs/instrumentation). The variables from step 3 stay the same.

### curl, no SDK

To check the key and endpoint before touching your app, post one span as OTLP JSON. Run it in the shell from step 3 so it uses your region's endpoint:

```bash
NOW=$(date +%s)
curl -i "${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces" \
  -H "Authorization: Bearer YOUR_INGEST_KEY" \
  -H "Content-Type: application/json" \
  -d '{
  "resourceSpans": [{
    "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": "quickstart" } }] },
    "scopeSpans": [{
      "spans": [{
        "traceId": "5b8efff798038103d269b633813fc60c",
        "spanId": "eee19b7ec3c1b174",
        "name": "GET /hello",
        "kind": 2,
        "startTimeUnixNano": "'"${NOW}"'000000000",
        "endTimeUnixNano": "'"${NOW}"'250000000",
        "status": { "code": 1 }
      }]
    }]
  }]
}'
```

A `200` response means Maple accepted the span. Change the `traceId` to send another trace with the same command.

## 5. Verify

Open **Explore → Traces** and filter **Service** to `quickstart` (or your `OTEL_SERVICE_NAME`). The trace appears within about a minute. Click it to see its spans.

## Troubleshooting

- **`401` from the ingest endpoint.** The key is wrong, or it belongs to the other region. A US key is rejected by `ingest.eu.maple.dev` and the other way around. See [Regions](/docs/reference/regions).
- **Nothing shows up.** Maple accepts OTLP over HTTP only. An exporter set to `grpc` or pointed at port `4317` cannot reach it; use `http/protobuf` and the endpoint without a port. Set `OTEL_LOG_LEVEL=debug` to print export errors.
- **The trace is there, but under a name like `unknown_service:node`.** `OTEL_SERVICE_NAME` was not set in the shell that started the app, so the SDK fell back to a default `service.name`.
- **Still nothing.** Check the time range on the Traces page. For the curl span, your machine's clock sets the timestamp.

More status codes and their meaning are in the [Ingest API reference](/docs/reference/ingest#status-codes).

## Next steps

- [Instrument your application](/docs/instrumentation): full guides per language, with logs and metrics.
- [Traces](/docs/explore/traces): search, filter and open traces.
- [Service map](/docs/explore/service-map): see calls between services once two of them are instrumented.
- [Alert rules](/docs/alerting/alert-rules): get notified when error rate or latency crosses a threshold.
