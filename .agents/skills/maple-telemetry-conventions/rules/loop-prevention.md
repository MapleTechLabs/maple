# Loop prevention and sampling

Maple traces itself. The API and the other Workers ship spans to the ingest gateway, which writes them to the same warehouse datasources customer traffic lands in. Viewing a trace in the dashboard issues API calls, which create more spans. Without the guards in this file, that loop inflates span volume.

**Never remove any of these without a documented replacement.** CLAUDE.md: "Self-tracing: the API traces itself through ingest; keep `withTracerDisabledWhen()` and avoid spans on hot paths like token validation."

---

## Guard 1: TypeScript API, `HttpMiddleware.TracerDisabledWhen`

**Where:** `ApiObservabilityLive` in `apps/api/src/http/api-observability.ts`, registered through alchemy's telemetry layer in `apps/api/src/worker.ts`.

```typescript
export const ApiObservabilityLive = Layer.mergeAll(
	Layer.succeed(
		HttpMiddleware.TracerDisabledWhen,
		(request: { url: string; method: string }) =>
			request.url === "/health" ||
			request.method === "OPTIONS" ||
			OAUTH_CALLBACK_PATH.test(request.url) ||
			/\.(png|ico|jpg|jpeg|gif|css|js|svg|webp|woff2?)(\?.*)?$/i.test(request.url),
	),
	Layer.succeed(Headers.CurrentRedactedNames, [/* credential and webhook-signature headers */]),
)
```

It disables the automatic server span for:

| Request kind | Why |
|---|---|
| `/health` exact path | Pinged constantly by orchestrators; would dominate trace volume |
| `OPTIONS` (any path) | CORS preflights: high volume, low value |
| OAuth callbacks (`/api/integrations/*/callback`, `/oauth/chat/*/callback`) | Their query string carries a live authorization `code`, which the server span would record in `url.full`. Each handler opens its own span with safe attributes instead. |
| Static asset extensions (`.png`, `.ico`, `.jpg`, `.jpeg`, `.gif`, `.css`, `.js`, `.svg`, `.webp`, `.woff`, `.woff2`) | Asset fetches produce no useful trace data |

The same layer sets `Headers.CurrentRedactedNames`, so credential headers and webhook signatures never land on the span as `http.request.header.*`.

### Rules

- **Do not extend this filter** to hide paths that look noisy. Silence is debugging-hostile. Find the volume source first. The OAuth callbacks are the exception because tracing them would leak a credential.
- **Do not remove paths from this filter** without a replacement. Health-check spans alone can double Maple's daily trace count.
- **Don't add spans to high-frequency internal paths** such as token validation that runs on every request (CLAUDE.md calls this out).

---

## Guard 2: Rust ingest, OTLP loopback guard

**Where:** `init_tracing` in `apps/ingest/src/main.rs`. `init_metrics` and `init_usage_metrics` apply the same check.

```rust
let deployment_env = resolve_deployment_env();
let forward_explicit = std::env::var("INGEST_FORWARD_OTLP_ENDPOINT").is_ok();
let skip_dev = deployment_env == "development" && !forward_explicit;
let loopback = endpoint_loopback_to_self(forward_endpoint, bind_port);

if skip_dev || loopback {
    if loopback {
        eprintln!(
            "INGEST_FORWARD_OTLP_ENDPOINT={forward_endpoint} resolves to this server's bind port {bind_port}; skipping OTel exporter to avoid recursion"
        );
    }
    // Init tracing-subscriber WITHOUT the OTel layer.
    // ...
    return None;
}
```

Two refusals:

1. **Loopback detection:** if `INGEST_FORWARD_OTLP_ENDPOINT` resolves to ingest's own bind port (hostname/IP comparison in `endpoint_loopback_to_self()`), the OTel exporter is skipped. Otherwise ingest would forward its own spans to itself recursively.
2. **Dev no-op:** in the `development` environment with no explicit `INGEST_FORWARD_OTLP_ENDPOINT`, the OTel exporter is skipped (stdout logs only). This prevents accidental local trace floods.

The gateway's own telemetry goes straight to the downstream collector, not back through its ingest routes.

### Rule

If you add another OTLP-emitting service that shares a host with the ingest gateway, give it a similar loopback guard. Don't rely on configuration alone to prevent loops.

---

## Guard 3: Sampling

The ingest gateway applies a per-org trace sampling policy (`trace_sample_ratio`, with options to always keep error and slow spans). It records the ratio as `maple.ingest.sampling_ratio` and the dropped count as `maple.ingest.sampled_dropped`.

A service that exports through a standard OTel SDK can also head-sample with the parent-based ratio sampler:

```bash
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

This keeps 10% of root traces and children inherit the decision, so a trace is either fully kept or fully dropped. `@maple-dev/effect-sdk` does not read these variables.

### `SampleRate` column

The `traces` datasource has a first-class `SampleRate` column (the `SAMPLE_RATE_EXPR` default in `packages/domain/src/tinybird/datasources.ts`). It comes from `SpanAttributes['SampleRate']` when that is `>= 1`, else the W3C TraceState `th:` threshold, else `1.0`. Sampling-aware aggregations sum `SampleRate` to recover unbiased counts:

```sql
-- WRONG: under-counts when sampled
SELECT count() FROM traces WHERE …

-- RIGHT: scales each sampled span back up
SELECT sum(SampleRate) FROM traces WHERE …
```

See `docs/sampling-throughput.md` for the full pattern.

### Rule

When adding a throughput or count widget on the traces datasource, use `sum(SampleRate)` unless you have a specific reason to under-count. Unweighted span counts drift downward as the sampling ratio drops.

---

## What is not a loop-prevention guard

- **OTLP batch export** keeps export off the request path. Removing it would slow requests; it would not cause a loop.
- **OTLP export does not go through the API.** Each service ships directly to the ingest gateway, so exporting does not create API spans.

The guards above are the whole of Maple's loop-prevention strategy. Changing any of them requires a thought-through replacement.
