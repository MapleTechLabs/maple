import { QueryEngineExecuteRequest, type QueryEngineExecuteResponse } from "@maple/query-engine"
import type { TracesFilters } from "@maple/domain/query-engine"
import { UPTIME_SERVICE_NAME } from "@maple/domain/uptime"
import { Clock, Effect, Schema } from "effect"
import { ServiceName } from "@maple/domain/http"
import { buildServiceDetailPoints } from "./custom-charts"
import { executeQueryEngine } from "./effect-utils"
import { listTraces } from "./traces"
import type { ServiceDetailTimeSeriesPoint } from "./services"
import { computeBucketSeconds, toIsoBucket } from "./timeseries-utils"

// One uptime monitor's checks over a window, read from its check spans: the chart's buckets and
// the window's own percentiles (bucket percentiles cannot be merged into a window's).

/** The resource attribute every check span of a monitor carries. */
export const UPTIME_MONITOR_ID_ATTRIBUTE = "maple.uptime.monitor_id"

export interface UptimeCheckStatsInput {
	readonly monitorId: string
	readonly startTime: string
	readonly endTime: string
}

/** Checks one list page reads, and the pages read at once: 24 hours at a 30s interval fit. */
const CHECK_PAGE = 1000
const CHECK_PAGES = 3
/** Most checks one window lists; past it the newest are kept. */
export const UPTIME_CHECK_LIST_LIMIT = CHECK_PAGE * CHECK_PAGES

/** One check, from its span. */
export interface UptimeCheckSample {
	readonly at: string
	readonly durationMs: number
	readonly ok: boolean
	readonly statusCode: number | null
	readonly traceId: string
}

export interface UptimeCheckStats {
	readonly points: ReadonlyArray<ServiceDetailTimeSeriesPoint>
	/** Every check in the window, oldest first, up to `UPTIME_CHECK_LIST_LIMIT`. */
	readonly samples: ReadonlyArray<UptimeCheckSample>
	/** The window held more checks than the list keeps. */
	readonly samplesTruncated: boolean
	readonly windowStartMs: number
	readonly windowEndMs: number
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

	// Span-level, so the check span itself is the row; the noise filter would drop lone Client spans.
	const checkList = Effect.forEach(
		Array.from({ length: CHECK_PAGES }, (_, page) => page * CHECK_PAGE),
		(offset) =>
			listTraces({
				data: {
					startTime: input.startTime,
					endTime: input.endTime,
					services: [serviceName],
					resourceAttributeFilters: [{ key: UPTIME_MONITOR_ID_ATTRIBUTE, value: input.monitorId }],
					rootOnly: false,
					hideNoise: false,
					sortBy: "timestamp",
					sortDir: "desc",
					limit: CHECK_PAGE,
					offset,
				},
			}),
		{ concurrency: "unbounded" },
	)

	const [series, p50Ms, p95Ms, p99Ms, list] = yield* Effect.all(
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
		],
		{ concurrency: "unbounded" },
	)

	const nowMs = yield* Clock.currentTimeMillis
	const points = buildServiceDetailPoints(series, input.startTime, input.endTime, bucketSeconds, nowMs)
	const checks = points.reduce((sum, point) => sum + point.totalCount, 0)
	const failures = points.reduce((sum, point) => sum + Math.round(point.errorRate * point.totalCount), 0)
	const samples = list
		.flatMap((page) => page.data)
		.map((row): UptimeCheckSample => ({
			at: toIsoBucket(row.startTime),
			durationMs: row.durationMs,
			ok: !row.hasError,
			statusCode: row.rootSpan.http?.statusCode ?? null,
			traceId: row.traceId,
		}))
		.reverse()
	return {
		points,
		samples,
		samplesTruncated: (list.at(-1)?.meta.scannedCount ?? 0) >= CHECK_PAGE,
		windowStartMs: Date.parse(toIsoBucket(input.startTime)),
		windowEndMs: Date.parse(toIsoBucket(input.endTime)),
		checks,
		failures,
		p50Ms: checks === 0 ? null : p50Ms,
		p95Ms: checks === 0 ? null : p95Ms,
		p99Ms: checks === 0 ? null : p99Ms,
	} satisfies UptimeCheckStats
})
