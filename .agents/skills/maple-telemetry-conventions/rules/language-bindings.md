# Language bindings: emit the same attributes everywhere

Attribute keys are identical across languages. The snippets below emit the canonical `executeSql`-style annotation block in TS, Rust, and (forward-looking) Python.

---

## TypeScript: Effect + `@maple-dev/effect-sdk`

Maple's TS code creates spans through Effect's tracer; `@maple-dev/effect-sdk` (`packages/effect-sdk`) installs the tracer and OTLP exporter. Two patterns:

### Pattern A: `Effect.fn(name)`, a declarative span on a function

```typescript
import { Effect } from "effect"

const executeQuery = Effect.fn("MyService.executeQuery")(function* (
    tenant: TenantContext,
    sql: string,
) {
    // Annotate the current span (created by Effect.fn).
    yield* Effect.annotateCurrentSpan("orgId", tenant.orgId)
    yield* Effect.annotateCurrentSpan("tenant.userId", tenant.userId)
    yield* Effect.annotateCurrentSpan("db.system.name", "clickhouse")
    yield* Effect.annotateCurrentSpan("db.query.text", sql.slice(0, 16_384))
    yield* Effect.annotateCurrentSpan("query.context", "myQuery")

    const result = yield* runQuery(sql)
    yield* Effect.annotateCurrentSpan("result.rowCount", result.length)
    return result
})
```

Status is set automatically: a failed effect records `Error`, a successful one `Ok`. Do not set status manually. Pass `{ kind: "client" }` as the second argument to `Effect.fn` when the function makes a network call.

### Pattern B: `Effect.withSpan(name, { attributes })`, wrapping an inline effect

```typescript
yield* doWork.pipe(
    Effect.withSpan("BucketCacheService.fillMissingRanges", {
        attributes: {
            orgId: request.orgId,
            "cache.missingRangeCount": missing.length,
            "cache.existingBucketCount": existingBuckets.length,
        },
    }),
)
```

Use this when attributes are known at span-open time instead of via `annotateCurrentSpan` calls inside.

### Cloudflare Workers: `MapleCloudflareSDK`

Workers get their tracer from `MapleCloudflareSDK` in `packages/effect-sdk/src/cloudflare/index.ts`, which configures the OTLP exporter and resource. Maple's own Workers install it through `WorkerTelemetry` (`packages/infra/src/cloudflare/worker-telemetry.ts`). After that, use the same `Effect.fn` / `Effect.annotateCurrentSpan` / `Effect.withSpan` API as elsewhere.

### Canonical TS example

The reference implementation is `executeSql` in `packages/query-engine/src/execution/executor.ts`. Read it when unsure how to structure a new query span.

---

## Rust: `tracing` + `tracing-opentelemetry`

Rust code declares spans and fields with `tracing` macros. The reserved fields (`otel.name`, `otel.kind`, `otel.status_code`, `otel.status_description`) drive OTel semantics; the rest become attributes.

### Pattern A: declarative span via `tracing::info_span!`

```rust
use tracing::Instrument;

let span = tracing::info_span!(
    "ingest",
    otel.name = %otel_name,
    otel.kind = "server",
    otel.status_code = tracing::field::Empty,
    "http.request.method" = "POST",
    "http.route" = %route,
    "http.request.body.size" = body_bytes,
    "http.response.status_code" = tracing::field::Empty,
    "error.type" = tracing::field::Empty,
    "maple.signal" = signal.path(),
    "maple.org_id" = tracing::field::Empty,
);
let span_handle = span.clone();

// Run the work under the span; record fields after the work resolves.
let result = handle_inner().instrument(span).await;
match result {
    Ok(_) => {
        span_handle.record("http.response.status_code", 200);
        span_handle.record("otel.status_code", "Ok");
    }
    Err(err) => {
        span_handle.record("http.response.status_code", err.status_code());
        span_handle.record("error.type", err.kind());
        // Inbound handlers: use otel_status_for_rejection (see status-and-kind.md).
        span_handle.record("otel.status_code", "Error");
    }
}
```

Key idioms:
- **Quote field names that contain dots** (`"http.request.method"`). The reserved `otel.*` fields are the exception: the macro accepts them bare.
- **Declare empty fields up front** with `tracing::field::Empty` and `record` them later. `record` silently ignores a field the span did not declare, and the declaration site then lists every field.
- **Use `%expr`** to record the `Display` impl and `?expr` for `Debug`. Use plain `field = value` for primitives.

### Pattern B: `#[instrument]` attribute macro

For function-level spans, use `#[instrument(fields(...))]`:

```rust
#[tracing::instrument(
    name = "resolve_connector",
    skip(state),
    fields(
        otel.kind = "internal",
        "maple.org_id" = tracing::field::Empty,
        "maple.cloudflare.connector_id" = %connector_id,
    ),
)]
async fn resolve_connector(state: &AppState, connector_id: &str) -> Result<Resolved> {
    // ...
    tracing::Span::current().record("maple.org_id", resolved.org_id.as_str());
    Ok(resolved)
}
```

### Canonical Rust example

`handle_signal` in `apps/ingest/src/main.rs` (Server-kind inbound handler) and `forward_client_span` / `export_client_span` in `apps/ingest/src/otel.rs` (Client-kind outbound).

---

## Python: forward-looking

There is no Python service in this repo today. Follow these conventions when adding one.

```python
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode, SpanKind

tracer = trace.get_tracer(__name__)

def execute_query(tenant, sql: str):
    with tracer.start_as_current_span(
        "MyService.execute_query",
        kind=SpanKind.INTERNAL,
    ) as span:
        # Same attribute keys as TS / Rust. Do not invent Python-specific ones.
        span.set_attribute("orgId", tenant.org_id)
        span.set_attribute("tenant.userId", tenant.user_id)
        span.set_attribute("db.system.name", "clickhouse")
        span.set_attribute("db.query.text", sql[:16_384])
        span.set_attribute("query.context", "myQuery")

        try:
            result = run_query(sql)
            span.set_attribute("result.rowCount", len(result))
            # On success, leave status alone: Maple stores it as Unset.
            return result
        except Exception as exc:
            span.set_status(Status(StatusCode.ERROR))
            span.set_attribute("error.type", classify(exc))
            raise
```

### Python status

Python's OTel SDK uses the enums `StatusCode.ERROR` / `StatusCode.OK`. The exporter encodes them as OTLP status codes, which Maple stores as `"Error"` / `"Ok"`. So:

- Correct: `span.set_status(Status(StatusCode.ERROR))`. Call `span.set_status(Status(StatusCode.OK))` explicitly if the span must read `Ok`.
- Wrong: `span.set_attribute("otel.status_code", "ERROR")`. That is a plain attribute, not the span status.

---

## Cross-language consistency table

The same logical attribute uses the same key in every language. These are the most-confused spots:

| Concept | TypeScript | Rust | Python | Notes |
|---|---|---|---|---|
| Customer org ID (on span) | `orgId` | `maple.org_id` | `orgId` (or `maple.org_id` if mirroring ingest) | TS/Rust mismatch is intentional, kept for dashboard filter compatibility |
| User ID | `tenant.userId` | `tenant.userId` (not `tenant.user_id`) | `tenant.userId` | Dotted camelCase is canonical |
| SQL statement | `db.query.text` | `db.query.text` | `db.query.text` | Same key everywhere (legacy spans: `db.statement`) |
| SQL duration | `db.duration_ms` | `db.duration_ms` | `db.duration_ms` | Same key everywhere |
| OTel HTTP method | `http.request.method` | `http.request.method` | `http.request.method` | Semconv 1.20+ keys everywhere (the legacy email-path exception is gone) |
| OTel status code | (managed by Effect tracer) | `otel.status_code` field on `tracing` span | `span.set_status(Status(...))` | Title Case strings on the wire |

When in doubt, grep the codebase for the key. If TS uses it and you're writing Rust, use the same spelling.
