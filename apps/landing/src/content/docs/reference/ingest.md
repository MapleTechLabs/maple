---
title: "Ingest API"
description: "The OTLP ingest endpoint: paths, authentication, content types, compression, request limits, status codes, and how to retry."
group: "Reference"
order: 3
---

Every signal reaches Maple through one OTLP/HTTP gateway. Any OpenTelemetry SDK or Collector that can export OTLP over HTTP works without a Maple-specific exporter.

|              |                                                                |
| ------------ | -------------------------------------------------------------- |
| Base URL     | `https://ingest.maple.dev` (EU: `https://ingest.eu.maple.dev`) |
| Protocol     | OTLP over HTTP, `POST`                                         |
| Auth         | `Authorization: Bearer maple_pk_…` (or `maple_sk_…`)           |
| Encodings    | Protobuf (recommended) or JSON, optionally gzip                |
| Max body     | 20 MiB per request, measured on the compressed body            |
| Request time | 30 seconds per request                                         |

## Endpoints

| Path                        | Payload                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `POST /v1/traces`           | OTLP `ExportTraceServiceRequest`                                                   |
| `POST /v1/logs`             | OTLP `ExportLogsServiceRequest`                                                    |
| `POST /v1/metrics`          | OTLP `ExportMetricsServiceRequest`                                                 |
| `POST /v1/events`           | [Product events](/docs/product-events/api)                                         |
| `POST /v1/sessionReplays/*` | Session replay chunks, sent by the [browser SDK](/docs/session-replay/browser-sdk) |
| `POST /v1/sessionEvents`    | Session timeline events, sent by the browser SDK                                   |

Use the base URL of your organisation's [data region](/docs/instrumentation#data-regions); a key from one region is rejected by the other. A standard exporter appends the signal path itself:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.maple.dev"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer maple_pk_…"
export OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"
```

## Authentication

Send your ingest key on every request, either as a Bearer token or in the `x-maple-ingest-key` header. The `Bearer` prefix is case-insensitive.

```http
Authorization: Bearer maple_pk_…
x-maple-ingest-key: maple_pk_…
```

Ingest keys are write-only and scoped to one organisation. Use the **public** key (`maple_pk_…`) in browsers and mobile apps, where it ships to end users, and the **private** key (`maple_sk_…`) on servers. Find both under **Settings → Ingestion** in the dashboard.

The literal key `MAPLE_TEST` is accepted and returns `200`, but the data is discarded. Use it in CI or example code where you want the exporter to run without sending anything.

## Content types and compression

| `Content-Type`                                   | Read as       |
| ------------------------------------------------ | ------------- |
| `application/x-protobuf`, `application/protobuf` | OTLP protobuf |
| `application/octet-stream`                       | OTLP protobuf |
| anything containing `json` (`application/json`)  | OTLP JSON     |
| header missing                                   | OTLP protobuf |
| anything else                                    | `415`         |

For compression, send `Content-Encoding: gzip`. Omit the header (or send `identity`) for an uncompressed body. **gzip is the only compression supported.** `zstd`, `deflate` and `br` are rejected with `415`, so set your exporter's compression to `gzip` or `none`.

## Browsers

The gateway answers CORS preflights from any origin, so a browser can export directly. Allowed request headers are `Authorization`, `Content-Type`, `Content-Encoding`, `x-maple-ingest-key` and the `x-maple-*` headers the browser SDK sends. No response headers are exposed to scripts, so browser code cannot read `Retry-After`; back off on a fixed schedule instead.

## Status codes

Errors carry a JSON body with the same envelope as the [Maple API](/docs/api#errors) (`type`, `code`, `message`, `retryable`, `recovery`) plus `retry_after_seconds` when a retry makes sense. Checks run in this order, so a request fails on the first one it trips:

| Status | `code`                          | Cause                                                  | Retry?                            |
| ------ | ------------------------------- | ------------------------------------------------------ | --------------------------------- |
| `200`  |                                 | Accepted and durably queued                            |                                   |
| `401`  | `ingest_unauthorized`           | Missing, malformed or unknown ingest key               | No. Fix the key.                  |
| `429`  | `ingest_rate_limited`           | Too many concurrent requests for your organisation     | Yes, after `Retry-After`          |
| `413`  | `ingest_payload_too_large`      | Body over 20 MiB                                       | No. Send smaller batches.         |
| `415`  | `ingest_unsupported_media_type` | Unknown `Content-Type` or `Content-Encoding`           | No. Fix the exporter config.      |
| `400`  |                                 | Invalid gzip, or a body that is not valid OTLP         | No                                |
| `402`  | `ingest_plan_limit_reached`     | No active subscription, or the plan's limit is reached | No. Check **Settings → Billing**. |
| `429`  | `ingest_queue_throttled`        | Your organisation's ingest queue is full               | Yes, after `Retry-After`          |
| `429`  | `ingest_export_lane_full`       | The write path is backed up                            | Yes, after `Retry-After`          |
| `503`  | `ingest_unavailable`            | Key lookup temporarily unavailable                     | Yes, after `Retry-After`          |
| `503`  | `ingest_request_timeout`        | The request took longer than 30 seconds                | Yes, after `Retry-After`          |

OpenTelemetry SDKs and the Collector already retry `429` and `503` with backoff, and drop on the other `4xx` codes, which is the right behaviour here.

## Batching

A request is limited by its compressed size, not its span or record count. The default batch sizes of the OpenTelemetry SDKs and the Collector's `batch` processor stay far below 20 MiB. If you raise them, keep a compressed batch under a few MiB so one slow request doesn't hold a large amount of data.

## Related

- [OpenTelemetry conventions](/docs/concepts/otel-conventions): the attributes Maple reads from what you send
- [Instrumentation guides](/docs/instrumentation): per-language exporter setup
- [Limits](/docs/reference/limits): query ranges, SQL and API rate limits
