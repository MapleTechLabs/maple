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
import type { MetricProducer, MetricReader } from "@opentelemetry/sdk-metrics"
import type * as Arr from "effect/Array"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { LazyArg } from "effect/Function"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { MetricProducerImpl } from "./internal/metrics.ts"
import { Resource } from "./Resource.ts"

/**
 * Determines how metric values relate to the time interval over which they
 * are aggregated.
 *
 * **Details**
 *
 * `cumulative` reports total since a fixed start time. Each data point depends
 * on all previous measurements. This is the default behavior. `delta` reports
 * changes since the last export. Each interval is independent with no
 * dependency on previous measurements.
 *
 * @category models
 * @since 4.0.0
 */
export type TemporalityPreference = "cumulative" | "delta"

/**
 * Creates an OpenTelemetry metric producer from Effect metrics.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeProducer = (temporality?: TemporalityPreference): Effect.Effect<MetricProducer, never, Resource> =>
  Effect.gen(function*() {
    const resource = yield* Resource
    const services = yield* Effect.context<never>()
    return new MetricProducerImpl(resource, services, temporality)
  })

/**
 * Registers a metric producer with one or more metric readers.
 *
 * @category constructors
 * @since 4.0.0
 */
export const registerProducer = (
  self: MetricProducer,
  metricReader: LazyArg<MetricReader | Arr.NonEmptyReadonlyArray<MetricReader>>,
  options?: {
    readonly shutdownTimeout?: Duration.Input | undefined
  }
): Effect.Effect<Array<any>, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const reader = metricReader()
      const readers: Array<MetricReader> = Array.isArray(reader) ? reader : [reader] as any
      readers.forEach((reader) => reader.setMetricProducer(self))
      return readers
    }),
    (readers) =>
      Effect.promise(() =>
        Promise.all(
          readers.map((reader) => reader.shutdown())
        )
      ).pipe(
        Effect.ignore,
        Effect.interruptible,
        Effect.timeoutOption(options?.shutdownTimeout ?? 3000)
      )
  )

/**
 * Creates a Layer that registers a metric producer with metric readers.
 *
 * **Example** (Creating a metrics layer with temporality)
 *
 * ```ts
 * import { Metrics } from "@effect/opentelemetry"
 * import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
 * import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
 *
 * const metricExporter = new OTLPMetricExporter({ url: "<your-otel-url>" })
 *
 * // Use delta temporality for backends like Datadog or Dynatrace
 * const metricsLayer = Metrics.layer(
 *   () => new PeriodicExportingMetricReader({
 *     exporter: metricExporter,
 *     exportIntervalMillis: 10000
 *   }),
 *   { temporality: "delta" }
 * )
 *
 * // Use cumulative temporality for backends like Prometheus (default)
 * const cumulativeLayer = Metrics.layer(
 *   () => new PeriodicExportingMetricReader({ exporter: metricExporter }),
 *   { temporality: "cumulative" }
 * )
 * ```
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  evaluate: LazyArg<MetricReader | Arr.NonEmptyReadonlyArray<MetricReader>>,
  options?: {
    readonly shutdownTimeout?: Duration.Input | undefined
    readonly temporality?: TemporalityPreference | undefined
  }
): Layer.Layer<never, never, Resource> =>
  Layer.effectDiscard(Effect.flatMap(
    makeProducer(options?.temporality),
    (producer) => registerProducer(producer, evaluate, options)
  ))
