import type { Duration } from "effect"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { type MapleRegion, warnIfKeylessMapleIngest } from "@maple/browser-session/region"
import { type ExportDrop, makeOtlpLayer } from "../shared/otlp-layer.js"
import type { MapleSpanOptions } from "../shared/span-options.js"
import { makeSpanTimeline } from "../shared/span-timeline.js"
import { profilerLayer, type ProfilingOptions } from "./profiling.js"
import { type ResolvedResource, resolveResource } from "./resource.js"
import { SDK_VERSION } from "../version.js"

/** `<sdk>/<version>`, as the other server presets send it. */
const SERVER_SDK_HINT = `maple-effect-sdk-server/${SDK_VERSION}`

/**
 * A warning rather than a no-op: disabling export here would silently break
 * keyless setups against a local `maple start` sink or a self-hosted collector.
 */
const warnIfDoomed = (resolved: ResolvedResource): void =>
	warnIfKeylessMapleIngest({
		logPrefix: "[MapleServerSDK]",
		endpoint: resolved.endpoint,
		hasIngestKey: resolved.ingestKey !== undefined,
		hint: "Set MAPLE_INGEST_KEY, or point MAPLE_ENDPOINT at your own collector.",
	})

export interface MapleConfig extends MapleSpanOptions {
	/**
	 * Service name reported in traces, logs, and metrics. When omitted, falls
	 * back to `OTEL_SERVICE_NAME` env var, then `"unknown"`.
	 */
	readonly serviceName?: string | undefined
	/** Override auto-detected service version (commit SHA). */
	readonly serviceVersion?: string | undefined
	/**
	 * Canonical https URL of the source repository, emitted as
	 * `vcs.repository.url.full`. Falls back to `MAPLE_REPOSITORY_URL`, then
	 * GitHub Actions / Vercel git env metadata.
	 */
	readonly repositoryUrl?: string | undefined
	/**
	 * Logical group this service belongs to, emitted as the OTel
	 * `service.namespace` resource attribute. Optional — only stamped when set.
	 */
	readonly serviceNamespace?: string | undefined
	/** Override auto-detected deployment environment. */
	readonly environment?: string | undefined
	/**
	 * Ingest endpoint URL. When omitted, falls back to `MAPLE_ENDPOINT` then
	 * `OTEL_EXPORTER_OTLP_ENDPOINT` env vars (the latter is what the
	 * maple-k8s-infra chart's operator injects into pods), then to the
	 * region's public ingest.
	 */
	readonly endpoint?: string | undefined
	/**
	 * Region your Maple organization lives in: `"us"` (default) or `"eu"`.
	 * Falls back to `MAPLE_REGION`. Any endpoint, set here or in env, wins.
	 */
	readonly region?: MapleRegion | undefined
	/** Maple ingest key. Overrides MAPLE_INGEST_KEY env var. */
	readonly ingestKey?: string | undefined
	/**
	 * Additional resource attributes merged into the telemetry resource. These
	 * take precedence over `OTEL_RESOURCE_ATTRIBUTES` env-var entries with the
	 * same key.
	 */
	readonly attributes?: Record<string, unknown> | undefined
	/** Skip Effect log spans in OTLP log attributes. Default `false`. */
	readonly excludeLogSpans?: boolean | undefined
	readonly maxBatchSize?: number | undefined
	/**
	 * Spans and log records waiting to export, per signal, before new ones are dropped.
	 * Default `2048`, or `maxBatchSize` if larger. The queue fills only while exports
	 * fail or fall behind, for example when the ingest endpoint is unreachable.
	 */
	readonly maxQueueSize?: number | undefined
	/**
	 * Called when the export queue drops telemetry. Without it the SDK warns on `console`
	 * when a signal's dropped total reaches 1, 10, 100, ...
	 */
	readonly onDrop?: ((drop: ExportDrop) => void) | undefined
	readonly loggerExportInterval?: Duration.Input | undefined
	readonly metricsExportInterval?: Duration.Input | undefined
	readonly tracerExportInterval?: Duration.Input | undefined
	readonly shutdownTimeout?: Duration.Input | undefined
	/**
	 * Continuous CPU profiling on Node and Bun: `true` for the defaults, or the options. Off by
	 * default. Samples are linked to the span that was running, so a span shows its own flame
	 * graph. A runtime without a profiler (Cloudflare Workers) logs one warning and runs without.
	 */
	readonly profiling?: boolean | ProfilingOptions | undefined
}

/**
 * Create an Effect Layer that provides OpenTelemetry traces, logs, and metrics
 * configured for Maple.
 *
 * Auto-detects commit SHA and deployment environment from common platform
 * env vars (Railway, Vercel, Cloudflare Pages, Render).
 *
 * This layer **always exports** — there is no disable switch. The endpoint
 * defaults to the public Maple ingest, and a missing ingest key does not turn
 * export off, so a keyless app pointed at a local `maple start` sink or a
 * self-hosted collector still ships telemetry. Keyless against the public
 * ingest is the one futile combination and logs a one-shot warning.
 *
 * Note the contrast with `MapleFlush.make` and the Cloudflare `make`, which DO
 * no-op without an ingest key. If you want telemetry to switch itself off in
 * local dev, use one of those, or leave `MAPLE_ENDPOINT` pointed at a sink you
 * control.
 *
 * For Cloudflare Workers, prefer `@maple-dev/effect-sdk/cloudflare`'s `make()`
 * — it has no background fiber and exposes an explicit `flush` Effect that
 * `@maple/infra/worker-runtime`'s `withRequestRuntime` schedules in
 * `ctx.waitUntil`. This layer's background-export fiber
 * doesn't tick on Workers between invocations.
 *
 * Accepts the same span options as the flushable presets (`dropSpanNames`,
 * `dropSpanSubtrees`, `dropSpan`, `anticipatedErrorIdentifiers`,
 * `isAnticipatedError`); see `MapleSpanOptions`.
 *
 * @example
 * ```typescript
 * import { Maple } from "@maple-dev/effect-sdk/server"
 * import { Effect } from "effect"
 *
 * const TracerLive = Maple.layer({ serviceName: "my-app" })
 *
 * const program = Effect.log("Hello!").pipe(Effect.withSpan("hello"))
 * Effect.runPromise(program.pipe(Effect.provide(TracerLive)))
 * ```
 */
export const layer = (config: MapleConfig = {}) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const resolved = yield* resolveResource({ ...config, sdkType: "server" })
			// Always export. A missing ingest key is NOT a disable signal here:
			// pointing a keyless app at a local `maple start` sink or a self-hosted
			// OTLP collector is a supported setup, and those accept unauthenticated
			// writes. Only the keyless-to-public-ingest combination is futile, and
			// that one gets a warning rather than silence — see `warnIfDoomed`.
			warnIfDoomed(resolved)

			const headers = {
				// The exporter appends its own agent to this one.
				"user-agent": SERVER_SDK_HINT,
				"x-maple-sdk": SERVER_SDK_HINT,
				...(resolved.ingestKey
					? { Authorization: `Bearer ${Redacted.value(resolved.ingestKey)}` }
					: undefined),
			}
			const profiling =
				config.profiling === true ? {} : config.profiling === false ? undefined : config.profiling
			const spanTimeline =
				profiling !== undefined && profiling.linkSpans !== false ? makeSpanTimeline() : undefined

			const signals = makeOtlpLayer({
				baseUrl: resolved.endpoint,
				resource: resolved.resource,
				headers,
				spanTimeline,
				maxBatchSize: config.maxBatchSize,
				maxQueueSize: config.maxQueueSize,
				onDrop: config.onDrop,
				logPrefix: "[MapleServerSDK]",
				loggerExportInterval: config.loggerExportInterval,
				metricsExportInterval: config.metricsExportInterval,
				tracerExportInterval: config.tracerExportInterval,
				shutdownTimeout: config.shutdownTimeout,
				loggerExcludeLogSpans: config.excludeLogSpans,
				// Matches the stock `OtlpTracer` this layer used before, so existing
				// stack traces (and the error fingerprints hashed from them) don't move.
				spans: { ...config, includeCauseInStack: true },
			})
			const exported =
				profiling === undefined
					? signals
					: Layer.merge(
							signals,
							profilerLayer({
								baseUrl: resolved.endpoint,
								resource: resolved.resource,
								headers,
								profiling,
								timeline: spanTimeline,
								shutdownTimeout: config.shutdownTimeout,
							}),
						)
			return exported.pipe(Layer.provide(FetchHttpClient.layer))
		}),
	)
