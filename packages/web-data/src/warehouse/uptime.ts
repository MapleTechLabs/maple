import { QueryEngineExecuteRequest, type QueryEngineExecuteResponse } from "@maple/query-engine"
import type { TracesFilters } from "@maple/domain/query-engine"
import { UPTIME_MONITOR_ID_ATTRIBUTE, UPTIME_SERVICE_NAME } from "@maple/domain/uptime"
import { Clock, Effect, Schema } from "effect"
import {
	ServiceName,
	type UptimeCheck,
	UptimeChecksRequest,
	UptimePhaseTimingsRequest,
	type UptimePhaseTimingsPoint,
} from "@maple/domain/http"
import type { UptimeMonitorId } from "@maple/domain"
import { buildServiceDetailPoints } from "./custom-charts"
import { executeQueryEngine, runWarehouseQuery } from "./effect-utils"
import { MapleInternalHttp } from "./warehouse-services"
import type { ServiceDetailTimeSeriesPoint } from "./services"
import { computeBucketSeconds, toIsoBucket } from "./timeseries-utils"

// One uptime monitor's checks over a window, read from its check spans: the chart's buckets and
// the window's own percentiles (bucket percentiles cannot be merged into a window's).

export interface UptimeCheckStatsInput {
	readonly monitorId: UptimeMonitorId
	readonly startTime: string
	readonly endTime: string
	/** HTTP monitors: also read the per-bucket phase averages (DNS, connect, TLS, TTFB, transfer). */
	readonly withPhases?: boolean
}

/** Most checks one window lists, past it the newest are kept: 24 hours at a 30s interval fit. */
export const UPTIME_CHECK_LIST_LIMIT = 3000

/** One check from its span, with its phases when it recorded them. */
export type UptimeCheckSample = UptimeCheck

export interface UptimeCheckStats {
	readonly points: ReadonlyArray<ServiceDetailTimeSeriesPoint>
	/** Every check in the window, oldest first, up to `UPTIME_CHECK_LIST_LIMIT`. */
	readonly samples: ReadonlyArray<UptimeCheckSample>
	/** The window held more checks than the list keeps. */
	readonly samplesTruncated: boolean
	/** The check list failed; the rest of the stats still stand. */
	readonly samplesFailed: boolean
	readonly windowStartMs: number
	readonly windowEndMs: number
	readonly checks: number
	readonly failures: number
	readonly p50Ms: number | null
	readonly p95Ms: number | null
	readonly p99Ms: number | null
	/** Buckets with at least one timed check; empty without `withPhases` or before phases were recorded. */
	readonly phases: ReadonlyArray<UptimePhaseTimingsPoint>
	/** The phase read failed; the rest of the stats still stand. */
	readonly phasesFailed: boolean
}

const breakdownValue = (response: QueryEngineExecuteResponse): number | null => {
	if (response.result.kind !== "breakdown") return null
	const value = response.result.data[0]?.value
	return value === undefined || !Number.isFinite(value) ? null : value
}

export const getUptimeCheckStats = Effect.fn("QueryEngine.getUptimeCheckStats")(function* (
	input: UptimeCheckStatsInput,
) {
	// A constant that always decodes; checks are exported under it.
	const serviceName = yield* Schema.decodeUnknownEffect(ServiceName)(UPTIME_SERVICE_NAME).pipe(Effect.orDie)
	const filters: TracesFilters = {
		serviceName,
		rootSpansOnly: true,
		resourceAttributeFilters: [
			{ key: UPTIME_MONITOR_ID_ATTRIBUTE, value: input.monitorId, mode: "equals" },
		],
	}
	const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)
	const window = { startTime: input.startTime, endTime: input.endTime }
	const percentile = (metric: "p50_duration" | "p95_duration" | "p99_duration") =>
		executeQueryEngine(
			`queryEngine.uptimeCheckStats.${metric}`,
			new QueryEngineExecuteRequest({
				...window,
				query: { kind: "breakdown", source: "traces", metric, groupBy: "service", filters, limit: 1 },
			}),
		).pipe(Effect.map(breakdownValue))

	const checkList = runWarehouseQuery("queryEngine.uptimeChecks", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.uptimeChecks({
				payload: new UptimeChecksRequest({
					monitorId: input.monitorId,
					...window,
					limit: UPTIME_CHECK_LIST_LIMIT,
				}),
			})
		}),
	).pipe(
		Effect.map((response) => ({ checks: response.checks, failed: false })),
		// Like the phases, the per-check chart is detail the KPIs must not depend on.
		Effect.catch((error) =>
			Effect.as(Effect.logWarning("uptime check list failed", error), { checks: [], failed: true }),
		),
	)

	const phases =
		input.withPhases === true
			? runWarehouseQuery("queryEngine.uptimePhaseTimings", () =>
					Effect.gen(function* () {
						const client = yield* MapleInternalHttp
						return yield* client.queryEngine.uptimePhaseTimings({
							payload: new UptimePhaseTimingsRequest({
								monitorId: input.monitorId,
								...window,
								bucketSeconds,
							}),
						})
					}),
				).pipe(
					Effect.map((response) => ({ points: response.points, failed: false })),
					// The breakdown is extra detail: its failure must not take the KPIs and charts with it.
					Effect.catch((error) =>
						Effect.as(Effect.logWarning("uptime phase timings failed", error), {
							points: [],
							failed: true,
						}),
					),
				)
			: Effect.succeed({ points: [], failed: false })

	const [series, p50Ms, p95Ms, p99Ms, list, phasePoints] = yield* Effect.all(
		[
			executeQueryEngine(
				"queryEngine.uptimeCheckStats.series",
				new QueryEngineExecuteRequest({
					...window,
					query: {
						kind: "timeseries",
						source: "traces",
						metric: "count",
						allMetrics: true,
						filters,
						bucketSeconds,
					},
				}),
			),
			percentile("p50_duration"),
			percentile("p95_duration"),
			percentile("p99_duration"),
			checkList,
			phases,
		],
		{ concurrency: "unbounded" },
	)

	const nowMs = yield* Clock.currentTimeMillis
	const points = buildServiceDetailPoints(series, input.startTime, input.endTime, bucketSeconds, nowMs)
	// Totals read every bucket the warehouse returned; the chart's points drop a partial first one.
	const buckets = series.result.kind === "timeseries" ? series.result.data : []
	const checks = buckets.reduce((sum, bucket) => sum + (bucket.series.count ?? 0), 0)
	const failures = buckets.reduce(
		(sum, bucket) => sum + Math.round((bucket.series.error_rate ?? 0) * (bucket.series.count ?? 0)),
		0,
	)
	const samples = [...list.checks].reverse()
	return {
		points,
		samples,
		samplesTruncated: list.checks.length >= UPTIME_CHECK_LIST_LIMIT,
		samplesFailed: list.failed,
		windowStartMs: Date.parse(toIsoBucket(input.startTime)),
		windowEndMs: Date.parse(toIsoBucket(input.endTime)),
		checks,
		failures,
		p50Ms: checks === 0 ? null : p50Ms,
		p95Ms: checks === 0 ? null : p95Ms,
		p99Ms: checks === 0 ? null : p99Ms,
		phases: phasePoints.points,
		phasesFailed: phasePoints.failed,
	} satisfies UptimeCheckStats
})
