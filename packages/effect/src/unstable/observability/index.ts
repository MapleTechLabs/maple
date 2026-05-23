/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Convenience layers for exporting Effect logs, metrics, and traces over
 * OTLP/HTTP.
 *
 * This module wires the signal-specific OTLP logger, metrics, and tracer
 * exporters together so an application can install full observability with a
 * single layer. It is useful for services that report to an OpenTelemetry
 * Collector, vendor OTLP endpoint, or local collector during development
 * without configuring each signal independently.
 *
 * Pass `baseUrl` as the OTLP/HTTP root URL, such as `http://localhost:4318`;
 * this module appends `/v1/logs`, `/v1/metrics`, and `/v1/traces` itself.
 * Use `layerJson` or `layerProtobuf` when you want the serialization layer
 * provided for you, or use `layer` with a custom `OtlpSerialization`
 * implementation. Configure authentication with `headers`, provide resource
 * metadata explicitly or through the standard OTEL resource environment
 * variables, and tune batch size, export intervals, metric temporality, and
 * shutdown timeout for the target backend so buffered telemetry is accepted
 * and flushed before shutdown.
 *
 * @since 4.0.0
 */
export * as Otlp from "./Otlp.ts"

/**
 * Low-level OTLP/HTTP batch exporter used by the observability modules for
 * logs, metrics, and traces.
 *
 * This module owns the scoped transport loop for already-encoded telemetry
 * payloads: callers provide the OTLP endpoint, request headers, a body encoder,
 * and batching settings, then push records that should be delivered to a
 * collector. It is useful when implementing a concrete signal exporter, such
 * as the OTLP logger or tracer, or when wiring a snapshot-based exporter like
 * metrics into the same lifecycle and retry behavior.
 *
 * The exporter sends HTTP POST requests with the provided `HttpClient`, disables
 * tracer propagation for its own traffic, retries transient failures, and
 * honors numeric `retry-after` values on 429 responses. Exports run on
 * `exportInterval`, flush during scope finalization up to `shutdownTimeout`,
 * and can also be triggered early when the buffered item count reaches
 * `maxBatchSize`.
 *
 * Use `maxBatchSize: "disabled"` only for pull-style exporters whose `body`
 * callback builds a fresh payload without relying on drained buffered items,
 * because pushed data is not cleared in that mode. After an unrecovered export
 * failure the exporter drops the buffered batch and disables exporting for 60
 * seconds, so choose intervals, batch sizes, headers, and shutdown timeouts with
 * collector limits and process shutdown behavior in mind.
 *
 * @since 4.0.0
 */
export * as OtlpExporter from "./OtlpExporter.ts"

/**
 * Exports Effect log records to an OpenTelemetry Protocol (OTLP) logs endpoint.
 *
 * Use this module to send Effect log messages, annotations, fiber identifiers,
 * causes, and active span identifiers to an OpenTelemetry Collector or OTLP
 * compatible observability backend. `make` is useful for custom logger wiring,
 * while `layer` installs the logger for an application and can merge it with
 * any existing loggers.
 *
 * Records are buffered by the shared OTLP exporter. `exportInterval`,
 * `maxBatchSize`, and `shutdownTimeout` control periodic exports, early batch
 * flushes, and how long scope finalization waits for the final flush. Resource
 * options are attached to every export and override OpenTelemetry resource
 * environment variables, so ensure a `service.name` is available through the
 * options, `OTEL_RESOURCE_ATTRIBUTES`, or `OTEL_SERVICE_NAME`; use `headers`
 * for collector authentication and `excludeLogSpans` when log span duration
 * attributes would be too noisy.
 *
 * @since 4.0.0
 */
export * as OtlpLogger from "./OtlpLogger.ts"

/**
 * OTLP/HTTP metrics exporter for Effect's Metric system.
 *
 * This module periodically snapshots the metrics registered in the current
 * Effect context, serializes them as OTLP resource metrics, and posts them to a
 * metrics endpoint such as an OpenTelemetry Collector or vendor OTLP intake.
 * It is typically installed with `layer` in long-running services that already
 * update `Metric` counters, gauges, histograms, frequencies, or summaries and
 * need those values exported without adding instrumentation-specific plumbing
 * to the application code.
 *
 * Pass the concrete `/v1/metrics` endpoint to `make` or `layer`, or use the
 * higher-level `Otlp` module when you want `baseUrl` path construction for all
 * signals. The exporter requires an `HttpClient` and an `OtlpSerialization`
 * implementation, takes resource metadata from explicit options or standard
 * OTEL resource environment variables, and uses the resource `service.name` as
 * the instrumentation scope name. Choose `temporality` for the target backend:
 * cumulative is the default, while delta derives per-export changes from the
 * previous snapshot. Gauges always report their current value, and delta
 * histograms and summaries keep interval counts and sums from previous
 * snapshots, so tune export intervals and shutdown timeouts with backend
 * expectations and process shutdown behavior in mind.
 *
 * @since 4.0.0
 */
export * as OtlpMetrics from "./OtlpMetrics.ts"

/**
 * Helpers and data types for describing the OTLP resource attached to exported
 * logs, metrics, and traces.
 *
 * A resource identifies the service that produced telemetry and carries
 * process- or deployment-level attributes that should be shared across every
 * signal sent by the Effect OTLP logger, metrics exporter, and tracer. Use this
 * module when building explicit resource metadata, reading the standard OTEL
 * resource environment variables, or converting application metadata into OTLP
 * `KeyValue` / `AnyValue` shapes before serialization.
 *
 * `service.name` is required because the signal exporters also use it as the
 * instrumentation scope name. Explicit resource options take precedence over
 * `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME`, and
 * `OTEL_SERVICE_VERSION`; `service.name` and `service.version` are normalized
 * through the service metadata inputs and re-added as canonical OTLP
 * attributes rather than left in the custom attribute map. Attribute values are
 * converted to OTLP scalar or array values where possible, with unsupported
 * runtime values formatted as strings.
 *
 * @since 4.0.0
 */
export * as OtlpResource from "./OtlpResource.ts"

/**
 * Defines the serialization boundary used by the OTLP observability layers.
 *
 * `OtlpSerialization` converts Effect's in-memory OTLP trace, metric, and log
 * data into `HttpBody` values so exporters can send them to collectors over
 * OTLP/HTTP. Use this module to choose between the JSON encoding that is useful
 * for debugging and collector endpoints that explicitly accept OTLP/HTTP JSON,
 * and the protobuf encoding commonly expected by production OpenTelemetry
 * collectors.
 *
 * The JSON layer writes the telemetry structures directly with
 * `HttpBody.jsonUnsafe`; the protobuf layer encodes the same structures with
 * the internal OTLP protobuf encoder and sets the `application/x-protobuf`
 * content type. Endpoint paths, authentication headers, batching, retries, and
 * shutdown flushing are handled by the OTLP exporter layers that consume this
 * service, while this module focuses only on preserving the wire format chosen
 * for traces, metrics, and logs.
 *
 * @since 4.0.0
 */
export * as OtlpSerialization from "./OtlpSerialization.ts"

/**
 * Exports Effect spans to an OpenTelemetry Protocol (OTLP) traces endpoint.
 *
 * This module creates a `Tracer.Tracer` backed by the shared OTLP/HTTP batch
 * exporter, so Effect spans created with tracing APIs can be delivered to an
 * OpenTelemetry Collector, vendor OTLP intake, or local development collector.
 * Use `make` when you need to install the tracer manually, or `layer` when an
 * application should provide it through the Effect environment.
 *
 * Pass a concrete traces endpoint, typically `/v1/traces`, or use the
 * higher-level `Otlp` module when you want `baseUrl` path construction for all
 * observability signals. The tracer exports only ended sampled spans, converts
 * span attributes, events, links, status, parent identifiers, and failure
 * causes into OTLP trace data, and groups every batch under the configured
 * resource. Resource options are resolved through `OtlpResource`, so ensure a
 * stable `service.name` is available through options or standard OTEL resource
 * environment variables because it is also used as the instrumentation scope
 * name. Tune `exportInterval`, `maxBatchSize`, and `shutdownTimeout` for the
 * target backend and process shutdown behavior, provide `headers` for
 * authentication or routing, choose an `OtlpSerialization` layer accepted by
 * the endpoint, and use `context` only when a backend needs custom evaluation
 * around the active span.
 *
 * @since 4.0.0
 */
export * as OtlpTracer from "./OtlpTracer.ts"

/**
 * Prometheus metrics exporter for Effect's Metric system.
 *
 * This module snapshots the metrics registered in the current Effect context
 * and renders them in the Prometheus text exposition format. It is intended for
 * services that already record `Metric` counters, gauges, histograms,
 * frequencies, or summaries and need a pull-based `/metrics` endpoint, or for
 * integrations that want the formatted scrape body for a custom HTTP server.
 *
 * Use `format` when you need the current runtime's registry rendered as a
 * string, `formatUnsafe` when you already have the `Context`, and `layerHttp`
 * when an `HttpRouter` should serve `GET /metrics` directly. Formatting happens
 * at scrape time; the module does not push metrics, schedule exports, or start
 * an HTTP server on its own. Make sure the route is installed in the same
 * application context that records the metrics you want to expose.
 *
 * Metric and label names are sanitized for Prometheus, optional prefixes and
 * name mappers are applied before output, and metric attributes become labels.
 * Keep attributes low-cardinality, avoid relying on invalid characters being
 * preserved exactly, and configure Prometheus to scrape the route served by
 * `layerHttp` with the expected `text/plain; version=0.0.4` response.
 *
 * **Example** (Exporting Prometheus metrics)
 *
 * ```ts
 * import { Effect, Metric } from "effect"
 * import { PrometheusMetrics } from "effect/unstable/observability"
 *
 * const program = Effect.gen(function*() {
 *   // Create and update metrics
 *   const counter = Metric.counter("http_requests_total", {
 *     description: "Total HTTP requests"
 *   })
 *   yield* Metric.update(counter, 42)
 *
 *   // Format metrics for Prometheus
 *   const output = yield* PrometheusMetrics.format()
 *   console.log(output)
 *   // # HELP http_requests_total Total HTTP requests
 *   // # TYPE http_requests_total counter
 *   // http_requests_total 42
 * })
 * ```
 *
 * @since 4.0.0
 */
export * as PrometheusMetrics from "./PrometheusMetrics.ts"
