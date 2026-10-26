import { QueryEngineExecuteRequest, type QueryEngineExecuteResponse } from "@maple/query-engine"
import type { TracesFilters } from "@maple/domain/query-engine"
import { UPTIME_SERVICE_NAME } from "@maple/domain/uptime"
import { Clock, Effect, Schema } from "effect"
import { ServiceName } from "@maple/domain/http"
import { buildServiceDetailPoints } from "./custom-charts"
import { executeQueryEngine } from "./effect-utils"
import type { ServiceDetailTimeSeriesPoint } from "./services"
import { computeBucketSeconds } from "./timeseries-utils"

// One uptime monitor's checks over a window, read from its check spans: the chart's buckets and
// the window's own percentiles (bucket percentiles cannot be merged into a window's).

/** The resource attribute every check span of a monitor carries. */
export const UPTIME_MONITOR_ID_ATTRIBUTE = "maple.uptime.monitor_id"

export interface UptimeCheckStatsInput {
	readonly monitorId: string
	readonly startTime: string
	readonly endTime: string
}

export interface UptimeCheckStats {
	readonly points: ReadonlyArray<ServiceDetailTimeSeriesPoint>
	readonly checks: number
	readonly failures: number
	readonly p50Ms: number | null
	readonly p95Ms: number | null
	readonly p99Ms: number | null
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

	const [series, p50Ms, p95Ms, p99Ms] = yield* Effect.all(
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
		],
		{ concurrency: "unbounded" },
	)

	const nowMs = yield* Clock.currentTimeMillis
	const points = buildServiceDetailPoints(series, input.startTime, input.endTime, bucketSeconds, nowMs)
	const checks = points.reduce((sum, point) => sum + point.totalCount, 0)
	const failures = points.reduce((sum, point) => sum + Math.round(point.errorRate * point.totalCount), 0)
	return {
		points,
		checks,
		failures,
		p50Ms: checks === 0 ? null : p50Ms,
		p95Ms: checks === 0 ? null : p95Ms,
		p99Ms: checks === 0 ? null : p99Ms,
	} satisfies UptimeCheckStats
})
