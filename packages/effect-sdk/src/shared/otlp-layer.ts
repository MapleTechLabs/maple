// Background-exporting OTLP layer behind `Maple.layer` (server + client).
//
// Mirrors `Otlp.layerJson` signal for signal, except the tracer: Effect's
// stock `OtlpTracer` has no hook to drop or reclassify spans, so traces go
// through the same Maple tracer the flushable presets use, pushed into Effect's
// own `OtlpExporter` (same batching, interval, retry back-off, shutdown flush).
import { Duration, Effect, Layer, Tracer } from "effect"
import { type Headers, HttpClientRequest } from "effect/http"
import type { HttpClient } from "effect/http"
import { OtlpExporter, OtlpLogger, OtlpMetrics, OtlpResource, OtlpSerialization } from "effect/observability"
import type { OtlpTracer } from "effect/observability"
import { makeMapleTracer, makeSpanEncoder } from "./flushable-tracer.js"
import { resolveSpanFilter, type SpanFilterInput } from "./span-options.js"
import type { SpanTimeline } from "./span-timeline.js"

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
	readonly maxQueueSize?: number | undefined
	readonly onDrop?: ((drop: ExportDrop) => void) | undefined
	/** Prefix of the default drop warning, e.g. `"[MapleServerSDK]"`. */
	readonly logPrefix: string
	readonly spans: SpanFilterInput
	/** Set when a profiler links samples to spans: the tracer then records span switches on it. */
	readonly spanTimeline?: SpanTimeline | undefined
}

/** Telemetry the exporter dropped because its pending queue was full. */
export interface ExportDrop {
	readonly signal: "traces" | "logs"
	readonly count: number
	/** Items of this signal dropped since the layer started. */
	readonly total: number
}

/** The order of magnitude of a running total, -1 before anything was dropped. */
const magnitude = (n: number) => (n === 0 ? -1 : Math.floor(Math.log10(n)))

/**
 * The per-signal `onDrop` handed to Effect's exporters. Without a caller hook it warns on
 * `console` (not the Effect logger, whose queue may be the full one) when the running total
 * reaches 1, 10, 100, ... so an outage is reported without a line per dropped batch.
 */
export const makeDropReporter = (options: Pick<OtlpLayerOptions, "onDrop" | "logPrefix">) => {
	const totals = { traces: 0, logs: 0 }
	return (signal: ExportDrop["signal"]) => (count: number) => {
		const before = totals[signal]
		const total = before + count
		totals[signal] = total
		if (options.onDrop !== undefined) return options.onDrop({ signal, count, total })
		if (magnitude(total) > magnitude(before)) {
			console.warn(
				`${options.logPrefix} export queue full: ${signal === "traces" ? "spans" : "log records"} dropped, ${total} so far. Raise \`maxQueueSize\` or check that the ingest endpoint is reachable.`,
			)
		}
	}
}

const tracerLayer = (url: string, options: OtlpLayerOptions, onDrop: (count: number) => void) =>
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
				maxQueueSize: options.maxQueueSize,
				onDrop,
				body(spans: OtlpTracer.ScopeSpan["spans"]) {
					const data: OtlpTracer.TraceData = {
						resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }],
					}
					return [serialization.traces(data), Effect.void]
				},
			})
			const filter = resolveSpanFilter(options.spans)
			const encode = makeSpanEncoder(filter)
			const tracer = makeMapleTracer(filter, (span) => {
				const otlp = encode(span)
				if (otlp !== undefined) exporter.push(otlp)
			})
			return options.spanTimeline === undefined ? tracer : options.spanTimeline.instrument(tracer)
		}),
	).pipe(Layer.provideMerge(OtlpExporter.layerFlusher))

export const makeOtlpLayer = (
	options: OtlpLayerOptions,
): Layer.Layer<OtlpExporter.Flusher, never, HttpClient.HttpClient> => {
	const base = HttpClientRequest.get(options.baseUrl)
	const url = (path: string) => HttpClientRequest.appendUrl(base, path).url
	// Suspended so every build of the layer counts its own drops.
	return Layer.suspend(() => {
		const reportDrop = makeDropReporter(options)
		return Layer.mergeAll(
			OtlpLogger.layer({
				url: url("/v1/logs"),
				resource: options.resource,
				headers: options.headers,
				exportInterval: options.loggerExportInterval,
				maxBatchSize: options.maxBatchSize,
				maxQueueSize: options.maxQueueSize,
				onDrop: reportDrop("logs"),
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
			tracerLayer(url("/v1/traces"), options, reportDrop("traces")),
		).pipe(Layer.provide(OtlpSerialization.layerJson))
	})
}
