import type { Duration } from "effect"
import { Effect, Layer, Tracer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Otlp } from "effect/unstable/observability"

/**
 * Key the `@maple/browser` SDK publishes its replay session sink under. Looked up
 * lazily per span so init ordering between the SDKs does not matter; absent on
 * non-replay pages and during SSR, where the decorator below no-ops.
 */
const SESSION_SINK_KEY = "__MAPLE_BROWSER_SESSION__"

interface SessionSink {
	readonly sessionId: string
	readonly recordTraceId: (traceId: string) => void
}

/**
 * Decorate the OTLP tracer so every span it creates reports its trace id to the
 * active browser replay session (when one exists) and carries `session.id`. This
 * is what links a replay session to the Effect HTTP traces it produced — instead
 * of the redundant auto-instrumented fetch spans `@maple/browser` would otherwise
 * collect. `provideMerge` keeps the base layer's logger/metrics while overriding
 * only the Tracer reference. No-ops cleanly when no session sink is published.
 */
const withSessionLink = <ROut, E, RIn>(base: Layer.Layer<ROut, E, RIn>) =>
	Layer.effect(
		Tracer.Tracer,
		Effect.map(Effect.tracer, (inner): Tracer.Tracer =>
			Tracer.make({
				context: inner.context,
				span(options) {
					const span = inner.span(options)
					const sink = (globalThis as Record<string, unknown>)[SESSION_SINK_KEY] as
						| SessionSink
						| undefined
					if (sink) {
						sink.recordTraceId(span.traceId)
						span.attribute("session.id", sink.sessionId)
					}
					return span
				},
			}),
		),
	).pipe(Layer.provideMerge(base))

export interface MapleClientConfig {
	/** The service name reported in traces, logs, and metrics. */
	readonly serviceName: string
	/** Maple ingest endpoint URL. */
	readonly endpoint: string
	/** Maple ingest key for authentication. */
	readonly ingestKey?: string | undefined
	/** Service version or commit SHA. */
	readonly serviceVersion?: string | undefined
	/** Deployment environment (e.g. "production", "staging"). */
	readonly environment?: string | undefined
	/** Additional resource attributes merged into the telemetry resource. */
	readonly attributes?: Record<string, unknown> | undefined
	readonly maxBatchSize?: number | undefined
	readonly loggerExportInterval?: Duration.Input | undefined
	readonly metricsExportInterval?: Duration.Input | undefined
	readonly tracerExportInterval?: Duration.Input | undefined
	readonly shutdownTimeout?: Duration.Input | undefined
}

/**
 * Create an Effect Layer that provides OpenTelemetry traces, logs, and metrics
 * configured for Maple in browser environments.
 *
 * Unlike the server layer, all configuration must be provided programmatically
 * since browsers don't have access to environment variables.
 *
 * @example
 * ```typescript
 * import { Maple } from "@maple-dev/effect-sdk/client"
 * import { Effect } from "effect"
 *
 * const TracerLive = Maple.layer({
 *   serviceName: "my-frontend",
 *   endpoint: "https://ingest.maple.dev",
 *   ingestKey: "maple_pk_...",
 * })
 *
 * const program = Effect.log("Hello!").pipe(Effect.withSpan("hello"))
 * Effect.runPromise(program.pipe(Effect.provide(TracerLive)))
 * ```
 */
export const layer = (config: MapleClientConfig) => {
	const attributes: Record<string, unknown> = {
		"maple.sdk.type": "client",
	}
	const g = globalThis as Record<string, any>
	if (typeof g["navigator"] !== "undefined") {
		const nav = g["navigator"]
		if (nav.userAgent) attributes["browser.user_agent"] = nav.userAgent
		if (nav.language) attributes["browser.language"] = nav.language
	}
	if (typeof Intl !== "undefined") {
		try {
			attributes["browser.timezone"] = Intl.DateTimeFormat().resolvedOptions().timeZone
		} catch {}
	}
	if (config.environment) attributes["deployment.environment"] = config.environment
	if (config.serviceVersion) attributes["deployment.commit_sha"] = config.serviceVersion
	if (config.attributes) Object.assign(attributes, config.attributes)

	const base = Otlp.layerJson({
		baseUrl: config.endpoint,
		resource: {
			serviceName: config.serviceName,
			serviceVersion: config.serviceVersion,
			attributes,
		},
		headers: config.ingestKey ? { Authorization: `Bearer ${config.ingestKey}` } : undefined,
		maxBatchSize: config.maxBatchSize,
		loggerExportInterval: config.loggerExportInterval,
		metricsExportInterval: config.metricsExportInterval,
		tracerExportInterval: config.tracerExportInterval,
		shutdownTimeout: config.shutdownTimeout,
	}).pipe(Layer.provide(FetchHttpClient.layer))

	return withSessionLink(base)
}
