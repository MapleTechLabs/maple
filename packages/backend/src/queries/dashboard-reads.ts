/**
 * Reads the dashboard's internal transport and the public v2 API both serve, so one function
 * (and one cache key) answers both clients. Perf work on either surface lands on both.
 */
import type {
	ServiceEndpointsRequest,
	ServiceHealthBaselineRequest,
	ServiceHealthSnapshotRequest,
	ServiceOperationsRequest,
} from "@maple/domain/http"
import {
	CH,
	baselineWarehouseCapabilities,
	formatWarehouseDateTime,
	parseWarehouseDateTime,
} from "@maple/query-engine"
import { makeDirectRouteCachePolicy, type QueryEngineDirectError } from "@maple/query-engine/runtime"
import { Queries, type QueryDefinition } from "@maple/query-engine/registry"
import { Cause, Clock, DateTime, type Duration, Effect, Option, Schema } from "effect"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { partitionWindowAround } from "@maple/backend/queries/query-helpers"
import { makeQueryRunners, type QueryRunnerDeps } from "@maple/backend/queries/query-runner"
import {
	isMissingServiceApiColumns,
	isMissingServiceOperationsRollup,
} from "@maple/backend/services/warehouse/missing-table"
import { traceCacheTtlSeconds } from "@maple/backend/services/warehouse/trace-detail-cache"

/** Sets one attribute on a span chosen by the caller. */
export type SpanAnnotator = (key: string, value: string | boolean) => Effect.Effect<void>

const annotateCurrent: SpanAnnotator = (key, value) => Effect.annotateCurrentSpan(key, value)

/**
 * The span current at the call site, so work that later runs inside `cachedDirect` still
 * labels the request's span rather than the cache's.
 */
const callerSpanAnnotator: Effect.Effect<SpanAnnotator> = Effect.option(Effect.currentSpan).pipe(
	Effect.map((span) =>
		Option.match(span, {
			onNone: () => annotateCurrent,
			onSome:
				(current): SpanAnnotator =>
				(key, value) =>
					Effect.sync(() => current.attribute(key, value)),
		}),
	),
)

/**
 * Labels a failed step on the route span. The typed error channel threads through unchanged,
 * so HTTP status mapping stays accurate.
 */
export const mapExecError = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	context: string,
	annotate: SpanAnnotator = annotateCurrent,
): Effect.Effect<A, E, R> =>
	effect.pipe(
		Effect.tapCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.void
				: annotate("maple.query_engine.failed_step", context),
		),
	)

/**
 * Read a rollup table, degrading to the raw-source query on a cluster that does not have it
 * (a BYO cluster whose admin never applied the perf migrations). Error recovery, not a switch.
 * Not an `Effect.fn`: that would add a span, and the fallback annotation belongs on the caller's.
 */
export const makeRollupFallback =
	(detect: (error: QueryEngineDirectError) => boolean, warning: string) =>
	<A, P, E extends QueryEngineDirectError, R>(
		rollup: (tenant: TenantContext, payload: P) => Effect.Effect<A, E, R>,
		raw: (tenant: TenantContext, payload: P) => Effect.Effect<A, E, R>,
		tenant: TenantContext,
		payload: P,
		annotate: SpanAnnotator = annotateCurrent,
	): Effect.Effect<A, E, R> =>
		rollup(tenant, payload).pipe(
			Effect.catch((error) => {
				if (!detect(error)) return Effect.fail(error)
				return Effect.gen(function* () {
					yield* Effect.logWarning(warning).pipe(Effect.annotateLogs({ orgId: tenant.orgId }))
					yield* annotate("query.rollup.fallback", true)
					return yield* raw(tenant, payload)
				})
			}),
		)

/**
 * Run a decoration read under a budget shorter than its request's, so one slow layer
 * cannot fail the whole page. Past it the read is interrupted and `empty` stands in,
 * flagged `timedOut` for the client to say so.
 */
export const withinBudget = <A, E, R>(
	read: Effect.Effect<A, E, R>,
	budget: Duration.Input,
	empty: A,
	context: { readonly orgId: string; readonly layer: string },
): Effect.Effect<{ readonly value: A; readonly timedOut: boolean }, E, R> =>
	read.pipe(
		Effect.timeoutOption(budget),
		Effect.tap((result) =>
			Option.isSome(result)
				? Effect.void
				: Effect.logWarning("Read exceeded its budget; returning it empty").pipe(
						Effect.annotateLogs(context),
						Effect.andThen(Effect.annotateCurrentSpan("maple.read.timed_out", context.layer)),
					),
		),
		Effect.map((result) =>
			Option.isSome(result)
				? { value: result.value, timedOut: false }
				: { value: empty, timedOut: true },
		),
	)

const withServiceOperationsFallback = makeRollupFallback(
	isMissingServiceOperationsRollup,
	"service_operations rollup is absent on this cluster; reading raw traces. Apply ClickHouse schema to restore the fast path.",
)

// The API tab's reads also degrade when the rollups exist but predate migration 0048.
export const withServiceApiFallback = makeRollupFallback(
	(error) => isMissingServiceOperationsRollup(error) || isMissingServiceApiColumns(error),
	"service_operations rollup lacks migration 0048; reading raw traces. Apply ClickHouse schema to restore the fast path.",
)

/** Operation rows are cached this long, keyed on the request payload. */
const SERVICE_OPERATIONS_CACHE_SECONDS = 30

const HOUR_MS = 3_600_000
// Most traces opened without a timestamp are still recent, so the last 48h are probed first
// (~2 daily partitions); only older traces fall back to the every-partition probe.
const PROBE_RECENT_WINDOW_MS = 48 * HOUR_MS
/** A trace not found yet may be ingesting, so its empty answer is barely cached. */
const EMPTY_TRACE_TTL_SECONDS = 1

/** Bumped when the cached span-hierarchy value changed: it now holds the sentinel row too. */
const SPAN_HIERARCHY_CACHE_VERSION = 2

export interface SparklinePoint {
	readonly bucket: string
	readonly count: number
}

export interface OperationRow {
	readonly spanName: string
	readonly spanCount: number
	readonly estimatedSpanCount: number
	readonly errorCount: number
	readonly estimatedErrorCount: number
	readonly errorRate: number
	readonly avgDurationMs: number
	readonly p50DurationMs: number
	readonly p95DurationMs: number
	readonly p99DurationMs: number
	readonly sparkline: ReadonlyArray<SparklinePoint>
}

export interface SpanHierarchyInput {
	readonly traceId: string
	readonly spanId?: string | undefined
	readonly startTime?: string | undefined
	readonly endTime?: string | undefined
}

/** The minute-grain sparkline bucket the dashboard derives for a window (about 50 buckets). */
export const operationsSparklineBucketSeconds = (startTime: string, endTime: string): number => {
	const windowSeconds = Math.max(
		0,
		(parseWarehouseDateTime(endTime) - parseWarehouseDateTime(startTime)) / 1000,
	)
	return Math.max(1, Math.round(windowSeconds / 50 / 60)) * 60
}

const lastSpanEndMs = (
	rows: ReadonlyArray<{ readonly startTime: DateTime.Utc; readonly durationMs: number }>,
): number =>
	rows.reduce((latest, row) => Math.max(latest, DateTime.toEpochMillis(row.startTime) + row.durationMs), 0)

export const makeDashboardReads = (deps: QueryRunnerDeps) => {
	const { queryEngine } = deps
	const { runQuery, runQueryFirst } = makeQueryRunners(deps)

	/**
	 * Summary + per-row sparkline for the operation rollup, shared by the Operations tab (every
	 * span) and the API tab (HTTP endpoints only). Both reads degrade per-org on UNKNOWN_TABLE.
	 */
	const operationRowsWithSparklines = (
		tenant: TenantContext,
		payload: ServiceOperationsRequest,
		queries: {
			readonly summary: QueryDefinition<ServiceOperationsRequest, CH.ServiceOperationsSummaryOutput>
			readonly summaryRaw: QueryDefinition<ServiceOperationsRequest, CH.ServiceOperationsSummaryOutput>
			readonly label: string
			/** The API tab draws no sparkline, so it skips the second warehouse query. */
			readonly sparklines: boolean
		},
		annotate: SpanAnnotator,
	) =>
		Effect.gen(function* () {
			const toNumber = (value: unknown) => Number(value ?? 0)
			const summaryRows = yield* mapExecError(
				withServiceOperationsFallback(
					(t, pl) => runQuery(queries.summary, t, pl),
					(t, pl) => runQuery(queries.summaryRaw, t, pl),
					tenant,
					payload,
					annotate,
				),
				`${queries.label} query failed`,
				annotate,
			)
			if (summaryRows.length === 0) return []

			const toRow = (
				row: (typeof summaryRows)[number],
				sparkline: ReadonlyArray<SparklinePoint>,
			): OperationRow => ({
				spanName: row.spanName,
				spanCount: toNumber(row.spanCount),
				estimatedSpanCount: toNumber(row.estimatedSpanCount),
				errorCount: toNumber(row.errorCount),
				estimatedErrorCount: toNumber(row.estimatedErrorCount),
				errorRate: toNumber(row.errorRate),
				avgDurationMs: toNumber(row.avgDurationMs),
				p50DurationMs: toNumber(row.p50DurationMs),
				p95DurationMs: toNumber(row.p95DurationMs),
				p99DurationMs: toNumber(row.p99DurationMs),
				sparkline,
			})

			if (!queries.sparklines) return summaryRows.map((row) => toRow(row, []))

			const spanNames = summaryRows.map((row) => row.spanName)
			// The rollup is minute-grain, so every sparkline interval must be a whole-minute multiple.
			const requestedBucketSeconds = "bucketSeconds" in payload ? payload.bucketSeconds : undefined
			const bucketSeconds =
				requestedBucketSeconds === undefined
					? operationsSparklineBucketSeconds(payload.startTime, payload.endTime)
					: Math.max(1, Math.round(requestedBucketSeconds / 60)) * 60
			const timeseriesRows = yield* mapExecError(
				withServiceOperationsFallback(
					(t, pl) => runQuery(Queries.serviceOperationsTimeseries, t, pl),
					(t, pl) => runQuery(Queries.serviceOperationsTimeseriesRaw, t, pl),
					tenant,
					{ ...payload, spanNames, bucketSeconds },
					annotate,
				),
				"serviceOperationsTimeseries query failed",
				annotate,
			)

			const sparklines = timeseriesRows.reduce((map, row) => {
				const points = map.get(row.spanName) ?? []
				points.push({ bucket: DateTime.formatIso(row.bucket), count: toNumber(row.count) })
				return map.set(row.spanName, points)
			}, new Map<string, SparklinePoint[]>())

			return summaryRows.map((row) => toRow(row, sparklines.get(row.spanName) ?? []))
		})

	const operationsQueries = {
		summary: Queries.serviceOperationsSummary,
		summaryRaw: Queries.serviceOperationsSummaryRaw,
		label: "serviceOperations",
	} as const

	/** The service detail Operations list, edge-cached for 30s on the request payload. */
	const serviceOperations = (tenant: TenantContext, payload: ServiceOperationsRequest) =>
		Effect.flatMap(callerSpanAnnotator, (annotate) =>
			queryEngine.cachedDirect(
				tenant,
				"serviceOperations",
				payload,
				operationRowsWithSparklines(
					tenant,
					payload,
					{ ...operationsQueries, sparklines: true },
					annotate,
				),
				SERVICE_OPERATIONS_CACHE_SECONDS,
			),
		)

	/** The Operations summary alone, uncached: the fallback when the sparkline read fails. */
	const serviceOperationsSummary = (tenant: TenantContext, payload: ServiceOperationsRequest) =>
		Effect.flatMap(callerSpanAnnotator, (annotate) =>
			operationRowsWithSparklines(
				tenant,
				payload,
				{ ...operationsQueries, sparklines: false },
				annotate,
			),
		)

	/**
	 * The service detail API tab: HTTP endpoints with their status and body counters, no
	 * sparklines. Its own cache key: the rows gained fields, so older cached rows never serve.
	 */
	const serviceEndpoints = (tenant: TenantContext, payload: ServiceEndpointsRequest) =>
		Effect.flatMap(callerSpanAnnotator, (annotate) =>
			queryEngine.cachedDirect(
				tenant,
				"serviceEndpointsHttp",
				payload,
				mapExecError(
					withServiceApiFallback(
						(t, pl) => runQuery(Queries.serviceEndpointsSummary, t, pl),
						(t, pl) => runQuery(Queries.serviceEndpointsSummaryRaw, t, pl),
						tenant,
						payload,
						annotate,
					),
					"serviceEndpoints query failed",
					annotate,
				).pipe(
					Effect.map((rows) =>
						rows.map((row) => ({
							spanName: row.spanName,
							spanCount: row.spanCount,
							estimatedSpanCount: row.estimatedSpanCount,
							errorCount: row.errorCount,
							estimatedErrorCount: row.estimatedErrorCount,
							errorRate: row.errorRate,
							avgDurationMs: row.avgDurationMs,
							p50DurationMs: row.p50DurationMs,
							p95DurationMs: row.p95DurationMs,
							p99DurationMs: row.p99DurationMs,
							httpClassifiedSpanCount: row.httpClassifiedSpanCount,
							httpStatusCount: row.httpStatusCount,
							http4xxCount: row.http4xxCount,
							http5xxCount: row.http5xxCount,
							requestBodyBytes: row.requestBodyBytes,
							requestBodyCount: row.requestBodyCount,
						})),
					),
				),
				SERVICE_OPERATIONS_CACHE_SECONDS,
			),
		)

	/**
	 * `traces` is partitioned by day, so a hierarchy read with no time predicate seeks every
	 * retained partition. Without a caller window, a probe finds the trace's first and last span
	 * and the read covers them with an hour either side.
	 */
	const probedWindow = (tenant: TenantContext, payload: SpanHierarchyInput, nowMs: number) =>
		Effect.gen(function* () {
			if (payload.startTime != null && payload.endTime != null) {
				return { startTime: payload.startTime, endTime: payload.endTime }
			}
			const cutoffMs = nowMs - PROBE_RECENT_WINDOW_MS
			const recent = yield* runQueryFirst(Queries.spanHierarchyProbeRecent, tenant, {
				traceId: payload.traceId,
				startTime: formatWarehouseDateTime(cutoffMs),
			})
			// The recent probe cannot see rows before its cutoff, so a start near it may be late.
			const settledRecent =
				recent !== null && DateTime.toEpochMillis(recent.timestamp) >= cutoffMs + HOUR_MS
					? recent
					: null
			const probe = settledRecent ?? (yield* runQueryFirst(Queries.spanHierarchyProbe, tenant, payload))
			if (probe === null) return { startTime: undefined, endTime: undefined }
			return {
				startTime: partitionWindowAround(DateTime.formatIso(probe.timestamp)).startTime,
				endTime: partitionWindowAround(DateTime.formatIso(probe.endTimestamp)).endTime,
			}
		})

	/**
	 * Every span of one trace, up to `SPAN_HIERARCHY_MAX_SPANS`, and whether the trace had more.
	 * The probe runs inside the cache's compute, so a hit costs no warehouse read at all.
	 */
	const spanHierarchy = (tenant: TenantContext, payload: SpanHierarchyInput) =>
		Effect.gen(function* () {
			const nowMs = yield* Clock.currentTimeMillis
			// The cache stores rows through the query's row codec, so a hit returns the same
			// `DateTime.Utc` start times a miss does.
			const rowSchema = yield* Queries.spanHierarchy
				.compile(payload, tenant.orgId, baselineWarehouseCapabilities())
				.pipe(
					Effect.map((compiled) => compiled.rowSchema),
					Effect.orElseSucceed(() => undefined),
				)
			const rows = yield* queryEngine.cachedDirect(
				tenant,
				"spanHierarchy",
				payload,
				Effect.gen(function* () {
					const window = yield* probedWindow(tenant, payload, nowMs)
					return yield* runQuery(Queries.spanHierarchy, tenant, {
						traceId: payload.traceId,
						spanId: payload.spanId,
						...window,
					})
				}),
				makeDirectRouteCachePolicy({
					ttlSeconds: traceCacheTtlSeconds(payload.endTime, nowMs),
					version: SPAN_HIERARCHY_CACHE_VERSION,
				}),
				rowSchema === undefined ? undefined : Schema.Array(rowSchema),
				// Settled by the trace's own last span, not the caller's window; empty may be ingesting.
				(found) =>
					found.length === 0
						? EMPTY_TRACE_TTL_SECONDS
						: traceCacheTtlSeconds(formatWarehouseDateTime(lastSpanEndMs(found)), nowMs),
			)
			return {
				rows: rows.slice(0, CH.SPAN_HIERARCHY_MAX_SPANS),
				truncated: rows.length > CH.SPAN_HIERARCHY_MAX_SPANS,
			}
		})

	/** The overview's service-health section: golden signals per (service, environment). */
	const serviceHealthSnapshot = (tenant: TenantContext, payload: ServiceHealthSnapshotRequest) =>
		runQuery(Queries.serviceHealthSnapshot, tenant, payload)

	/** Trailing p95 per (service, namespace, environment), cached for an hour by its definition. */
	const serviceHealthBaseline = (tenant: TenantContext, payload: ServiceHealthBaselineRequest) =>
		runQuery(Queries.serviceHealthBaseline, tenant, payload)

	return {
		runQuery,
		runQueryFirst,
		serviceOperations,
		serviceOperationsSummary,
		serviceEndpoints,
		spanHierarchy,
		serviceHealthSnapshot,
		serviceHealthBaseline,
	} as const
}
