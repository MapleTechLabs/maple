---
"@maple-dev/browser": minor
---

Move to OpenTelemetry JS 3.0 (`@opentelemetry/api` 1.10, `sdk-trace` 3.0, instrumentations 0.300). `sdk-trace-base` and `sdk-trace-web` are replaced by `@opentelemetry/sdk-trace`; the SDK still registers W3C trace context + baggage propagation and a stack context manager, so tracing behaviour is unchanged.
