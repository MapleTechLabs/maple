---
"@maple-dev/browser": minor
---

The SDK now depends on `@opentelemetry/api` alone. The OpenTelemetry JS SDK, the fetch and XHR instrumentations, the OTLP transformer, resources and semantic conventions are replaced by in-house code, cutting about 9 kB gzipped from every page load and 4 kB from the deferred chunk. Behaviour and the wire format are unchanged: the same spans, attributes, scopes and OTLP/JSON bodies, the same `traceparent`, `tracestate` and `baggage` propagation rules, and the SDK still registers itself as the global tracer provider, context manager and propagator, so `context.active()` and `context.with()` from your own `@opentelemetry/api` keep working.
