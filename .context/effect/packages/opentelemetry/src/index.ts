/**
 * @since 4.0.0
 */

// @barrel: Auto-generated exports. Do not edit manually.

/**
 * Connects Effect's logging system to the OpenTelemetry Logs SDK.
 *
 * This module provides a logger provider service, an Effect `Logger` that
 * emits OpenTelemetry log records, and layers for installing that logger in an
 * application. It is commonly used to send Effect logs to OTLP, console, or
 * vendor-specific exporters through OpenTelemetry `LogRecordProcessor`s while
 * keeping logs correlated with Effect fibers and spans. Emitted records include
 * the current fiber id, span identifiers when a parent span is present, log
 * annotations, log spans, severity text, and the matching OpenTelemetry
 * severity number.
 *
 * Log export depends on the configured OpenTelemetry processors and exporters;
 * this module creates the provider and logger, but does not choose an exporter.
 * Use the `Resource` layer to attach service and deployment metadata to the
 * provider rather than repeating that data on every log record. When using
 * `layerLoggerProvider`, the provider is scoped and is force-flushed and shut
 * down when the layer is released, with a configurable shutdown timeout. If you
 * supply or manage an OpenTelemetry provider yourself, make sure it is flushed
 * and shut down during application shutdown, especially when using batching
 * processors that may otherwise drop buffered logs.
 *
 * @since 4.0.0
 */
export * as Logger from "./Logger.ts"

/**
 * Bridges Effect metrics into OpenTelemetry by exposing the current Effect
 * metric snapshot as an OpenTelemetry `MetricProducer` and registering it with
 * one or more SDK `MetricReader`s. Use this module when an application already
 * records metrics with Effect and needs those counters, gauges, histograms,
 * frequencies, or summaries exported through OTLP, Prometheus, or another
 * OpenTelemetry-compatible reader/exporter.
 *
 * The `layer` constructor is the usual entry point, and is also used by the
 * Node and Web SDK layers when `metricReader` configuration is supplied. Metric
 * readers are acquired inside the layer scope and shut down when the scope is
 * released, so periodic exporters need the runtime to stay alive long enough to
 * collect and export data. The exporter or backend determines whether
 * cumulative or delta aggregation is expected; this module defaults to
 * cumulative temporality and can be configured with `temporality: "delta"` for
 * backends that require interval-based values.
 *
 * @since 4.0.0
 */
export * as Metrics from "./Metrics.ts"

/**
 * Provides an Effect layer for configuring OpenTelemetry in Node.js
 * processes. The module wires the Effect tracer, metrics producer, and logger
 * into OpenTelemetry SDK providers when span processors, metric readers, or log
 * record processors are supplied, and it builds the shared resource from
 * `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, and optional explicit
 * service metadata.
 *
 * Use this module in Node services, workers, CLIs, or server runtimes that need
 * Effect spans, metrics, and logs exported through OpenTelemetry processors and
 * exporters. Telemetry is enabled only for the configured signal types, so an
 * application can install tracing alone, metrics alone, logging alone, or any
 * combination of them from the same layer.
 *
 * The layer is scoped. Tracer and logger providers are force-flushed and shut
 * down when the scope is released, metric readers are shut down with the same
 * lifecycle, and all shutdown waits are bounded by `shutdownTimeout` with a
 * default of three seconds. Keep the layer scope alive for the lifetime of the
 * process and release it during graceful shutdown so batched exporters have a
 * chance to export final telemetry. When combining this layer with Node
 * auto-instrumentations, register instrumentation before importing modules that
 * should be patched, because many Node instrumentations hook module loading.
 *
 * @since 4.0.0
 */
export * as NodeSdk from "./NodeSdk.ts"

/**
 * Provides the OpenTelemetry resource used by the Effect OpenTelemetry layers.
 *
 * A resource describes the entity that produces telemetry, such as a service,
 * process, deployment, or browser application. The tracing, metrics, logging,
 * and SDK layers use this module's `Resource` service to configure providers
 * and identify emitted telemetry with service-level metadata.
 *
 * Use `layer` when service metadata is known in code, `layerFromEnv` when
 * deploying with `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES`, and
 * `layerEmpty` when no resource attributes should be provided. Resource
 * attributes are for stable process or service metadata, not per-span or
 * per-log data. The explicit `layer` helper sets `service.name` and the
 * `telemetry.sdk.*` attributes after merging custom attributes, so those keys
 * are controlled by this integration. With `layerFromEnv`, `OTEL_SERVICE_NAME`
 * overrides `service.name` from `OTEL_RESOURCE_ATTRIBUTES`, and additional
 * attributes passed to the layer are merged last.
 *
 * @since 4.0.0
 */
export * as Resource from "./Resource.ts"

/**
 * Bridges Effect tracing into OpenTelemetry by installing an Effect `Tracer`
 * that creates OpenTelemetry spans, records attributes, events, links, errors,
 * and status, and keeps OpenTelemetry context active while traced effects run.
 * Use this module when an application already has an OpenTelemetry
 * `TracerProvider`, or when the Node and Web SDK layers should expose Effect
 * spans to OTLP, console, or other OpenTelemetry-compatible exporters.
 *
 * The layer constructors wire Effect's tracer service to either the global
 * OpenTelemetry tracer provider or an explicitly provided `OtelTracer`. This
 * module does not create exporters or span processors by itself, so spans are
 * exported only when the provider has been configured by the application or by
 * the Node/Web SDK layers. Parentage is taken from Effect spans first and can
 * also attach to the active OpenTelemetry context, while `makeExternalSpan` and
 * `withSpanContext` are the entry points for continuing an incoming remote
 * trace. Preserve `traceFlags` and `traceState` when building external spans;
 * otherwise sampling defaults to sampled and trace state cannot be propagated.
 *
 * @since 4.0.0
 */
export * as Tracer from "./Tracer.ts"

/**
 * Provides an Effect layer for configuring OpenTelemetry in browser
 * applications. The module builds a shared resource from explicit service
 * metadata and wires Effect tracing, metrics, and logging into OpenTelemetry
 * SDK providers when span processors, metric readers, or log record processors
 * are supplied.
 *
 * Use this module in client-side applications that need Effect spans, metrics,
 * and logs exported from browser runtimes, such as single-page apps,
 * multi-page apps with hydrated Effect code, frontend workers, or UI flows
 * that should be correlated with backend traces. Telemetry is enabled only for
 * the configured signal types, so tracing, metrics, and logging can be
 * installed independently from the same layer.
 *
 * Browser SDKs cannot rely on process environment resource configuration, so
 * provide stable service metadata explicitly and use resource attributes for
 * application, release, deployment, or page-shell identity rather than
 * per-event data. This module does not create exporters; supply
 * browser-compatible processors, readers, and exporters yourself, and make sure
 * their endpoints are reachable from the browser with the required CORS and
 * authentication behavior. The layer is scoped: tracer providers are
 * force-flushed and shut down when the scope is released, while metric readers
 * and logger providers follow their respective layer lifecycles. Keep the
 * scope alive for the lifetime of the browser application and release it during
 * application teardown when possible so batched exporters and periodic metric
 * readers can deliver buffered telemetry before the page is unloaded.
 *
 * @since 4.0.0
 */
export * as WebSdk from "./WebSdk.ts"
