// Server flushable preset — manual `flush()` for Node/Bun/Deno
//
// `Maple.layer` (the `Otlp.layerJson`-based server preset) batches in the
// background and flushes only on a timer, on batch overflow, or on scope close
// — it exposes no way to force an export. This preset trades that background
// fiber for the buffer-backed tracer/logger used by the Cloudflare SDK and adds
// an explicit `flush()`, so a short-lived process can force its spans out at a
// checkpoint (or before exiting) instead of losing them.
//
//   import { MapleFlush } from "@maple-dev/effect-sdk/server"
//   const telemetry = MapleFlush.make({ serviceName: "my-app" })
//   // ...provide telemetry.layer to your runtime...
//   await telemetry.flush()        // force an export now
//   await telemetry.dispose()      // stop the auto-flush timer + final flush
//
// Traces, logs, and Effect metric snapshots are flushed together.

import { Cause, Duration, Effect, Layer, Option, Scope, Tracer } from "effect"
import { FetchHttpClient } from "effect/http"
import {
	buildResolved,
	fetchTransport,
	guardFlush,
	makeSerializedFlush,
	type Resolved,
	runFlush,
	makeSignalState,
} from "../shared/flush-core.js"
import { type LogBuffer, makeLogBuffer } from "../shared/flushable-logger.js"
import { makeMetricBuffer } from "../shared/flushable-metrics.js"
import { makeSpanBuffer, type SpanBuffer } from "../shared/flushable-tracer.js"
import type { MapleSpanOptions } from "../shared/span-options.js"
import { closeWithin } from "../shared/close-within.js"
import { makeNoOpNotice } from "../shared/no-op-notice.js"
import { makeSpanTimeline, type SpanTimeline } from "../shared/span-timeline.js"
import { SDK_VERSION } from "../version.js"
import { profilerLayer, type ProfilingOptions } from "./profiling.js"
import { resolveResource } from "./resource.js"
import type { MapleRegion } from "@maple/browser-session/region"

/** Default auto-flush cadence (ms), matching `Otlp.layerJson`'s 5s export interval. */
const DEFAULT_AUTO_FLUSH_MS = 5_000

export interface MapleFlushableConfig extends MapleSpanOptions {
	/**
	 * Service name reported in traces, logs, and metrics. Falls back to `OTEL_SERVICE_NAME`,
	 * then `"unknown"`.
	 */
	readonly serviceName?: string | undefined
	/** Override auto-detected service version (commit SHA). */
	readonly serviceVersion?: string | undefined
	/**
	 * Logical group this service belongs to, emitted as the OTel
	 * `service.namespace` resource attribute. Optional — only stamped when set.
	 */
	readonly serviceNamespace?: string | undefined
	/** Override auto-detected deployment environment. */
	readonly environment?: string | undefined
	/**
	 * Ingest endpoint URL. Falls back to `MAPLE_ENDPOINT`, then
	 * `OTEL_EXPORTER_OTLP_ENDPOINT`, then the public Maple ingest.
	 */
	readonly endpoint?: string | undefined
	/**
	 * Region your Maple organization lives in: `"us"` (default) or `"eu"`.
	 * Falls back to `MAPLE_REGION`. Any endpoint, set here or in env, wins.
	 */
	readonly region?: MapleRegion | undefined
	/**
	 * Maple ingest key. Falls back to `MAPLE_INGEST_KEY`. When unset, exports
	 * without `Authorization` to a custom endpoint, and runs in no-op mode
	 * against Maple's hosted ingest.
	 */
	readonly ingestKey?: string | undefined
	/** Additional resource attributes (highest precedence). */
	readonly attributes?: Record<string, unknown> | undefined
	/** Skip Effect log spans in OTLP log attributes. Default `false`. */
	readonly excludeLogSpans?: boolean | undefined
	/** OTLP traces path appended to `endpoint`. Default `/v1/traces`. */
	readonly tracesPath?: string | undefined
	/** OTLP logs path appended to `endpoint`. Default `/v1/logs`. */
	readonly logsPath?: string | undefined
	/** OTLP metrics path appended to `endpoint`. Default `/v1/metrics`. */
	readonly metricsPath?: string | undefined
	/**
	 * Background auto-flush cadence in milliseconds. Default `5000`. Set to `0`
	 * or `false` to disable and flush purely on demand (note: the in-memory
	 * buffer caps at 10k items and drops new spans past that, so a long-running
	 * process that never flushes will lose data).
	 */
	readonly autoFlushInterval?: number | false | undefined
	/**
	 * Continuous CPU profiling on Node and Bun: `true` for the defaults, or the options. Off by
	 * default. It runs while `layer` is built and exports its own windows, apart from `flush`; a
	 * second build of `layer` while one is running starts no second profiler, the last build to
	 * close stops it, and so does `dispose`. Off, with no warning, wherever export is off (no ingest key against Maple's
	 * hosted ingest).
	 */
	readonly profiling?: boolean | ProfilingOptions | undefined
}

export interface FlushableTelemetry {
	/**
	 * Effect Layer installing the buffer-backed OTLP tracer + Effect logger.
	 * Must live in the same runtime as your instrumented code (same caveat as
	 * the Cloudflare preset's `layer`).
	 */
	readonly layer: Layer.Layer<never>
	/** Drain the buffers and POST them now. Never rejects (errors are logged + cooled down). */
	readonly flush: () => Promise<void>
	/**
	 * Stop the auto-flush timer, then do one final flush. Afterwards `flush` and
	 * `layer` do nothing, and a second call returns the first.
	 */
	readonly dispose: () => Promise<void>
}

const USER_AGENT = `maple-effect-sdk-server/${SDK_VERSION}`

/** The buffer's tracer, recording span switches on `timeline` so profile samples link to spans. */
const instrumentedTracer = (spans: SpanBuffer, timeline: SpanTimeline | undefined) =>
	timeline === undefined
		? spans.tracerLayer
		: Layer.effect(Tracer.Tracer, Effect.map(Effect.tracer, timeline.instrument)).pipe(
				Layer.provide(spans.tracerLayer),
			)

interface Profiler {
	readonly layer: Layer.Layer<never>
	/** Stops a running profiler, sending its last window, and keeps any later build from starting one. */
	readonly stop: () => Promise<void>
}

/**
 * Bounds the whole profiler stop at shutdown, its last export included, under a typical 3 s
 * dispose budget so the final trace, log and metric flush still has time.
 */
const PROFILER_SHUTDOWN_TIMEOUT = Duration.millis(1500)

/**
 * The profiler, sending to the endpoint and with the key the flushes use. One per telemetry: every
 * build of `layer` holds it, the first starts it and the last to close stops it, so build the
 * layer once for a long-lived runtime (a per-request provide starts and stops it each request).
 * It runs in its own scope, so `dispose` can end it while a runtime lives on.
 */
const makeProfiler = (
	config: MapleFlushableConfig,
	profiling: ProfilingOptions,
	timeline: SpanTimeline | undefined,
): Profiler => {
	let holders = 0
	let active: Scope.Closeable | undefined
	let stopped = false
	const stopActive = Effect.suspend(() => {
		const scope = active
		active = undefined
		// Bounded from outside: a rotation command still waiting out its own timeout when shutdown
		// starts must not stretch the stop past the budget.
		return scope === undefined ? Effect.void : closeWithin(scope, PROFILER_SHUTDOWN_TIMEOUT)
	})
	const release = Effect.suspend(() => {
		holders -= 1
		return holders === 0 ? stopActive : Effect.void
	})
	const layer = Layer.effectDiscard(
		Effect.gen(function* () {
			if (stopped) return
			// The hold and its release are one uninterruptible step, and the build that took the
			// first hold is decided in it: an interrupted build leaves no hold behind, and two
			// builds at once start exactly one profiler.
			const first = yield* Effect.acquireRelease(
				Effect.sync(() => {
					holders += 1
					return holders === 1
				}),
				() => release,
			)
			if (!first) return
			// A resource that cannot be resolved turns profiling off, as it turns the flushes off.
			const resource = yield* resolveResource({ ...config, sdkType: "server" }).pipe(
				Effect.asSome,
				Effect.catchCause((cause) =>
					Effect.as(
						Effect.logWarning(
							"[MapleServerSDK] profiling is off: the resource could not be resolved",
							Cause.squash(cause),
						),
						Option.none(),
					),
				),
			)
			if (Option.isNone(resource)) return
			const resolved = buildResolved(resource.value, {
				userAgent: USER_AGENT,
				keyless: "disable-at-maple-ingest",
			})
			// Checked again after the resolve yielded: `dispose`, or the last holder closing, may have
			// run meanwhile, and nothing would stop a profiler started after it.
			if (resolved.noOp || stopped || holders === 0 || active !== undefined) return
			const scope = yield* Scope.make()
			active = scope
			yield* Layer.buildWithScope(
				profilerLayer({
					baseUrl: resource.value.endpoint,
					resource: resource.value.resource,
					headers: resolved.headers,
					profiling,
					timeline,
					shutdownTimeout: PROFILER_SHUTDOWN_TIMEOUT,
				}).pipe(Layer.provide(FetchHttpClient.layer)),
				scope,
			)
		}),
	)
	return {
		layer,
		stop: () => {
			stopped = true
			return Effect.runPromise(stopActive)
		},
	}
}

export const make = (config: MapleFlushableConfig = {}): FlushableTelemetry => {
	const spans: SpanBuffer = makeSpanBuffer(config)
	const logs: LogBuffer = makeLogBuffer({ excludeLogSpans: config.excludeLogSpans })
	const metrics = makeMetricBuffer()
	const profiling =
		config.profiling === true ? {} : config.profiling === false ? undefined : config.profiling
	const timeline = profiling !== undefined && profiling.linkSpans !== false ? makeSpanTimeline() : undefined
	const profiler = profiling === undefined ? undefined : makeProfiler(config, profiling, timeline)
	const layer = Layer.mergeAll(
		instrumentedTracer(spans, timeline),
		logs.loggerLayer,
		metrics.layer,
		profiler?.layer ?? Layer.empty,
	)

	const tracesState = makeSignalState()
	const logsState = makeSignalState()
	const metricsState = makeSignalState()
	const noOpNotice = makeNoOpNotice(
		"[MapleServerSDK]",
		"set MAPLE_INGEST_KEY, or point MAPLE_ENDPOINT at your own collector",
	)

	// Resolve the resource once, lazily, on first flush. Memoize the PROMISE (not
	// the result) so a manual flush racing the auto-flush timer can't kick off two
	// `resolveResource` runs. `resolveResource` reads env via the default
	// ConfigProvider, so this keeps commit-SHA/environment auto-detection without
	// making `make()` async or reading env at module scope.
	//
	// The memo is cleared on rejection. `resolveResource` is `Effect.orDie`, so a
	// defect (e.g. a runtime without `crypto.randomUUID`) surfaces as a rejected
	// promise — caching that would disable telemetry for the process lifetime and
	// turn the auto-flush timer into a recurring unhandled rejection. Dropping it
	// lets the next flush retry.
	let resolvedPromise: Promise<Resolved> | undefined
	const ensureResolved = (): Promise<Resolved> => {
		if (resolvedPromise === undefined) {
			const pending = Effect.runPromise(resolveResource({ ...config, sdkType: "server" })).then((r) =>
				buildResolved(r, {
					tracesPath: config.tracesPath,
					logsPath: config.logsPath,
					metricsPath: config.metricsPath,
					userAgent: USER_AGENT,
					keyless: "disable-at-maple-ingest",
				}),
			)
			resolvedPromise = pending
			pending.catch(() => {
				if (resolvedPromise === pending) resolvedPromise = undefined
			})
		}
		return resolvedPromise
	}

	// `guardFlush` is what makes `flush` documented-never-rejects hold: callers
	// `await` it at shutdown and the auto-flush timer fires it as `void flush()`.
	// It covers resource resolution, which runs before `runFlush` absorbs the
	// per-signal transport errors.
	const serialized = makeSerializedFlush(
		guardFlush("[MapleServerSDK]", async (): Promise<void> => {
			const resolved = await ensureResolved()
			await runFlush({
				resolved,
				spans,
				logs,
				metrics,
				tracesState,
				logsState,
				metricsState,
				transport: fetchTransport,
				logPrefix: "[MapleServerSDK]",
				onNoOp: noOpNotice,
			})
		}),
	)

	/** Set by the first `dispose()`: later flushes and disposes do nothing more. */
	let disposal: Promise<void> | undefined
	const flush = (): Promise<void> => (disposal === undefined ? serialized() : Promise.resolve())

	const intervalMs =
		config.autoFlushInterval === undefined
			? DEFAULT_AUTO_FLUSH_MS
			: config.autoFlushInterval === false
				? 0
				: config.autoFlushInterval
	let timer: ReturnType<typeof setInterval> | undefined
	if (intervalMs > 0) {
		timer = setInterval(() => {
			void flush()
		}, intervalMs)
		// Node only: a flush timer must never keep the process alive on its own.
		;(timer as { unref?: () => void }).unref?.()
	}

	const finalize = async (): Promise<void> => {
		// First, so its last window goes out before the final flush.
		await profiler?.stop()
		if (timer !== undefined) {
			clearInterval(timer)
			timer = undefined
		}
		await serialized()
		// Spans ended through `layer` after this are dropped rather than buffered for good.
		spans.setDisabled(true)
		logs.setDisabled(true)
		metrics.setDisabled(true)
	}
	const dispose = (): Promise<void> => (disposal ??= finalize())

	return { layer, flush, dispose }
}
