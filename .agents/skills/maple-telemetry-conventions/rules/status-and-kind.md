# Span status codes and span kinds

## Status codes: always Title Case

Maple stores span status as the rendered string, in Title Case:

| Value | When | Note |
|---|---|---|
| `"Ok"` | Successful operation | Not `OK`, `SUCCESS`, `ok`, or `Success` |
| `"Error"` | Failed operation | Not `ERROR`, `FAILED`, `error`, or `Failed` |
| `"Unset"` | Status not explicitly set | OTel default; usually only on Internal-kind spans with no discrete success/fail outcome |

### Why it matters

Tinybird MVs and dashboard widgets filter on the literal string. The error path uses `WHERE StatusCode = 'Error'` (`error_events_mv` and the error-rate widgets). Uppercase or lowercase variants silently produce zero rows on the error-rate widget and zero traces in the errors list. CLAUDE.md: "Span status codes: Title case: `"Ok"`, `"Error"`, `"Unset"`."

### How status is set

**TypeScript (Effect):** The tracer maps an effect's outcome to span status. `Effect.fail(...)` or a defect records `Error`; success records `Ok`. Do not set the string manually. One exception is handled for you: `@maple-dev/effect-sdk` exports a span as `Ok` (no `exception` event) when its failure is entirely an anticipated 4xx error. Maple's Workers pass `ANTICIPATED_ERROR_IDENTIFIERS` (`packages/domain/src/anticipated-errors.ts`, generated from every domain error annotated with a 4xx `httpApiStatus`) through `workerTelemetryConfig` in `packages/infra/src/cloudflare/worker-telemetry.ts`. A new 4xx domain error needs a 4xx `httpApiStatus` and a regenerated identifier list (a drift test in `anticipated-errors.test.ts` catches a stale one).

**Rust (ingest gateway):** Status is set explicitly through the `otel.status_code` field:

```rust
let span = tracing::info_span!(
    "ingest",
    otel.name = %otel_name,
    otel.kind = "server",
    otel.status_code = tracing::field::Empty,  // declared empty, recorded later
    // ...
);
// on success:
span_handle.record("otel.status_code", "Ok");
// on error, for inbound request handlers, follow the rejection rule below:
span_handle.record("otel.status_code", otel_status_for_rejection(status, error_kind));
```

**HTTP SERVER spans: 5xx is `Error`; a 4xx is `Error` only when it drops a healthy sender's data.** Per OTel HTTP semconv, a server span sets `Error` for 5xx and leaves caller faults alone. The ingest gateway centralizes this in `otel_status_for_rejection(status, error_kind)` (`apps/ingest/src/main.rs`), which returns `Error` when `status >= 500` or `rejection_loses_data(error_kind)` (`apps/ingest/src/otel.rs`), else `Ok`.

- **Caller faults stay `Ok`:** `auth` (401), `billing` (402), `throttle` (429), `payload_too_large`, `unsupported_media`. These are expected and high-volume, and must not flood `StatusCode = 'Error'` dashboards.
- **Data loss is `Error`:** `decode`, `enrich`, `bad_request`. The sender believes it is shipping telemetry and none of it is stored. A bug that rejected 99.2% of one org's logs for over 24h hid behind a 0% error rate under the old 5xx-only rule.
- **Server faults are `Error`:** any 5xx, e.g. auth resolver unavailable (503).

The status code, `error.type`, and `maple.ingest.reject_reason` are recorded for every rejection, so 4xx stays observable. Stage spans use the same rule through `record_stage_error` (`otel.rs`). Non-HTTP spans (forward and export `Client` spans, internal stages) record `Error` on any failure.

Record the reason in `maple.ingest.reject_reason`, never only in `otel.status_description`. `tracing-opentelemetry` turns a description into `Status::error(...)`, and a later `Ok` replaces it, so on an `Ok` rejection the reason would be lost.

**Python (forward-looking):** `span.set_status(Status(StatusCode.ERROR))`. The exporter encodes the enum as the OTLP status code, which Maple stores as `Error`. Never call `span.set_attribute("otel.status_code", "ERROR")`: it is a plain attribute, not the span status.

---

## Span kinds

The OTel spec defines five kinds:

| Kind | Use for | Example |
|---|---|---|
| `Server` | Inbound network request handlers | Ingest gateway `POST /v1/traces`, API HTTP handlers |
| `Client` | Outbound network calls | Ingest forward to the downstream collector, warehouse queries (`executeSql`), Postgres queries, Cloudflare Email send |
| `Internal` | Everything in-process | Query compilation, cache lookups, validation, DSL evaluation |
| `Producer` | Enqueueing a message | Queue producers |
| `Consumer` | Handling a dequeued message | Queue consumers |

The service map treats `Producer` like `Client` and `Consumer` like `Server`.

### How span kind is set

**TypeScript (Effect):** `Effect.fn(name, { kind: "client" })` or `Effect.withSpan(name, { kind: "server" })`. Effect uses lowercase kind strings. Spans default to `internal`; set `server` / `client` explicitly when they cross a network boundary. Example: `Effect.fn("WarehouseQueryService.executeSql", { kind: "client" })` in `packages/query-engine/src/execution/executor.ts`.

**Rust (tracing crate):** Use the `otel.kind` field:

```rust
let span = tracing::info_span!("ingest", otel.kind = "server", /* ... */);
```

See `handle_signal` and `handle_cloudflare_logpush` in `apps/ingest/src/main.rs` (Server inbound), and `forward_client_span` / `export_client_span` in `apps/ingest/src/otel.rs` (Client outbound).

**Python:** `tracer.start_as_current_span(name, kind=trace.SpanKind.SERVER)`.

### Rule: always set Server / Client at boundaries

If a span handles an inbound request, set `Server`. If it makes an outbound network call, set `Client`. The service map draws a service edge only by joining a `Client`/`Producer` span to its child `Server`/`Consumer` span, and counts a database call only on a `Client`/`Producer` span. Leaving the default `Internal` on either side drops the edge.

---

## Reserved OTel fields (Rust ingest)

`tracing-opentelemetry` interprets these `tracing` field names as OTel span fields rather than custom attributes:

| Field | Maps to | Example value |
|---|---|---|
| `otel.name` | Span name | `"POST /v1/traces"` |
| `otel.kind` | Span kind | `"server"`, `"client"`, `"internal"` (lowercase in `tracing`; stored as `Server`/`Client`/`Internal`) |
| `otel.status_code` | Span status | `"Ok"` / `"Error"` (write Title Case to match the rest of the codebase) |
| `otel.status_description` | Span status message | Sets an `Error` status with this description |

Do not invent custom span attributes named `otel.*`. Those slots are reserved.
