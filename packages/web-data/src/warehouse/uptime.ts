import { QueryEngineExecuteRequest, type QueryEngineExecuteResponse } from "@maple/query-engine"
import type { TracesFilters } from "@maple/domain/query-engine"
import { UPTIME_MONITOR_ID_ATTRIBUTE, UPTIME_SERVICE_NAME } from "@maple/domain/uptime"
import { Clock, Effect, Schema } from "effect"
import { ServiceName, UptimePhaseTimingsRequest, type UptimePhaseTimingsPoint } from "@maple/domain/http"
import type { UptimeMonitorId } from "@maple/domain"
import { buildServiceDetailPoints } from "./custom-charts"
import { listTraces } from "./traces"
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

/** Checks one list page reads (the traces list caps `limit` at 200), and the pages read. */
const CHECK_PAGE = 200
/** Offsets 0 to 2000, the list's offset cap: 24 hours at a 1m interval fit. */
const CHECK_PAGES = 11
/** Pages read at once after the first. */
const CHECK_WAVE = 4
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
	/** Buckets with at least one timed check; empty without `withPhases` or before phases were recorded. */
	readonly phases: ReadonlyArray<UptimePhaseTimingsPoint>
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
	const readPage = (offset: number) =>
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
		})
	type Page = Effect.Success<ReturnType<typeof readPage>>
	// The first page alone, then the rest a few at a time, stopping after a short page: a monitor
	// with a few checks reads one page, not all of them.
	const readFrom = (
		page: number,
	): Effect.Effect<
		ReadonlyArray<Page>,
		Effect.Error<ReturnType<typeof readPage>>,
		Effect.Services<ReturnType<typeof readPage>>
	> => {
		const wave = Array.from(
			{ length: Math.min(page === 0 ? 1 : CHECK_WAVE, CHECK_PAGES - page) },
			(_, index) => (page + index) * CHECK_PAGE,
		)
		return Effect.forEach(wave, readPage, { concurrency: CHECK_WAVE }).pipe(
			Effect.flatMap((pages) => {
				const next = page + pages.length
				const exhausted = pages.some((read) => read.meta.scannedCount < CHECK_PAGE)
				return exhausted || next >= CHECK_PAGES
					? Effect.succeed(pages)
					: Effect.map(readFrom(next), (rest) => [...pages, ...rest])
			}),
		)
	}
	const checkList = readFrom(0)

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
				).pipe(Effect.map((response) => response.points))
			: Effect.succeed([])

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
		phases: phasePoints,
	} satisfies UptimeCheckStats
})
