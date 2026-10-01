// Background-exporting OTLP layer behind `Maple.layer` (server + client).
//
// Mirrors `Otlp.layerJson` signal for signal, except the tracer: Effect's
// stock `OtlpTracer` has no hook to drop or reclassify spans, so traces go
// through the same Maple tracer the flushable presets use, pushed into Effect's
// own `OtlpExporter` (same batching, interval, retry back-off, shutdown flush).
import { Duration, Effect, Layer, Tracer } from "effect"
import { type Headers, HttpClientRequest } from "effect/unstable/http"
import type { HttpClient } from "effect/unstable/http"
import {
	OtlpExporter,
	OtlpLogger,
	OtlpMetrics,
	OtlpResource,
	OtlpSerialization,
} from "effect/unstable/observability"
import type { OtlpTracer } from "effect/unstable/observability"
import { makeMapleTracer, makeSpanEncoder } from "./flushable-tracer.js"
import { resolveSpanFilter, type SpanFilterInput } from "./span-options.js"

export interface OtlpLayerOptions {
	readonly baseUrl: string
	readonly resource: {
		readonly serviceName?: string | undefined
		readonly serviceVersion?: string | undefined
		readonly attributes?: Record<string, unknown>
	}
	readonly headers?: Headers.Input | undefined
	readonly maxBatchSize?: number | undefined
	readonly loggerExportInterval?: Duration.Input | undefined
	readonly loggerExcludeLogSpans?: boolean | undefined
	readonly metricsExportInterval?: Duration.Input | undefined
	readonly tracerExportInterval?: Duration.Input | undefined
	readonly shutdownTimeout?: Duration.Input | undefined
	readonly spans: SpanFilterInput
}

const tracerLayer = (url: string, options: OtlpLayerOptions) =>
	Layer.effect(
		Tracer.Tracer,
		Effect.gen(function* () {
			const resource = yield* OtlpResource.fromConfig(options.resource)
			const serialization = yield* OtlpSerialization.OtlpSerialization
			const scope = { name: OtlpResource.serviceNameUnsafe(resource) }
			// Defaults match `OtlpTracer.make`.
			const exporter = yield* OtlpExporter.make({
				label: "OtlpTracer",
				url,
				headers: options.headers,
				exportInterval: options.tracerExportInterval ?? Duration.seconds(5),
				maxBatchSize: options.maxBatchSize ?? 1000,
				shutdownTimeout: options.shutdownTimeout ?? Duration.seconds(3),
				body(spans) {
					const data: OtlpTracer.TraceData = {
						resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }],
					}
					return [serialization.traces(data), Effect.void]
				},
			})
			const filter = resolveSpanFilter(options.spans)
			const encode = makeSpanEncoder(filter)
			return makeMapleTracer(filter, (span) => {
				const otlp = encode(span)
				if (otlp !== undefined) exporter.push(otlp)
			})
		}),
	).pipe(Layer.provideMerge(OtlpExporter.layerFlusher))

export const makeOtlpLayer = (
	options: OtlpLayerOptions,
): Layer.Layer<OtlpExporter.Flusher, never, HttpClient.HttpClient> => {
	const base = HttpClientRequest.get(options.baseUrl)
	const url = (path: string) => HttpClientRequest.appendUrl(base, path).url
	return Layer.mergeAll(
		OtlpLogger.layer({
			url: url("/v1/logs"),
			resource: options.resource,
			headers: options.headers,
			exportInterval: options.loggerExportInterval,
			maxBatchSize: options.maxBatchSize,
			shutdownTimeout: options.shutdownTimeout,
			excludeLogSpans: options.loggerExcludeLogSpans,
		}),
		OtlpMetrics.layer({
			url: url("/v1/metrics"),
			resource: options.resource,
			headers: options.headers,
			exportInterval: options.metricsExportInterval,
			shutdownTimeout: options.shutdownTimeout,
		}),
		tracerLayer(url("/v1/traces"), options),
	).pipe(Layer.provide(OtlpSerialization.layerJson))
}
