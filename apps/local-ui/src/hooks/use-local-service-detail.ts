import { useCallback } from "react"
import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query"
import { DateTime } from "effect"
import { CH } from "@maple/query-engine"
import { boundsKey, executeLocalCompiledQuery, localParams } from "@/lib/query"
import type { SeriesPoint } from "../lib/chart-series"
import { fillGoldenSignals, type GoldenSignalRow } from "../lib/golden-signals"
import { parseClickHouseDateTime, type ChartWindow, type TimeBounds } from "../lib/time"
import { toCatalogEntry, type ServiceCatalogEntry } from "./use-local-service-catalog"

export interface ServiceOverview {
	readonly stats: ServiceCatalogEntry
	/** Earliest entry-point span in the window, which is where the chart starts. */
	readonly firstSeenMs: number | null
}

/**
 * Golden-signal header stats for one service. Percentiles come from the
 * catalog query, which merges the per-environment t-digests: averaging each
 * environment's p95 is not a p95.
 */
export function useLocalServiceOverview(serviceName: string, bounds: TimeBounds) {
	return useQuery({
		queryKey: ["local", "services", "overview", serviceName, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn: async ({ signal }): Promise<ServiceOverview | null> => {
			const params = localParams(bounds)
			const [catalogRows, overviewRows] = await Promise.all([
				executeLocalCompiledQuery(
					CH.compile(CH.serviceCatalogQuery({ serviceName, limit: 1 }), params),
					signal,
				),
				executeLocalCompiledQuery(
					CH.compile(CH.serviceOverviewQuery({ serviceName }), params),
					signal,
				),
			])
			const row = catalogRows[0]
			if (!row) return null
			const firstSeenMs = overviewRows.reduce<number | null>((earliest, overview) => {
				const ms = parseClickHouseDateTime(DateTime.formatIso(overview.firstSeen))
				return ms !== null && (earliest === null || ms < earliest) ? ms : earliest
			}, null)
			return { stats: toCatalogEntry(row, 0), firstSeenMs }
		},
	})
}

export type ServiceOperationRow = CH.ServiceOperationsSummaryOutput

/** Top operations table for the service detail page. */
export function useLocalServiceOperations(serviceName: string, bounds: TimeBounds) {
	return useQuery({
		queryKey: ["local", "services", "operations", serviceName, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		queryFn: ({ signal }): Promise<ReadonlyArray<ServiceOperationRow>> =>
			executeLocalCompiledQuery(
				CH.compile(CH.serviceOperationsSummaryQuery({ serviceName, limit: 25 }), localParams(bounds)),
				signal,
			),
	})
}

/** Per-bucket span counts for the top operations (drives the detail chart). */
export function useLocalServiceOperationsTimeseries(
	serviceName: string,
	spanNames: ReadonlyArray<string>,
	bounds: TimeBounds,
	window: ChartWindow,
) {
	const { bucketSeconds } = window
	return useQuery({
		queryKey: [
			"local",
			"services",
			"operations-ts",
			serviceName,
			spanNames,
			bucketSeconds,
			boundsKey(bounds),
		],
		placeholderData: keepPreviousData,
		queryFn:
			spanNames.length === 0
				? skipToken
				: async ({ signal }): Promise<ReadonlyArray<SeriesPoint>> => {
						const rows = await executeLocalCompiledQuery(
							CH.compile(
								CH.serviceOperationsTimeseriesQuery({
									serviceName,
									spanNames,
									bucketSeconds,
								}),
								{
									...localParams(bounds),
									bucketSeconds,
								},
							),
							signal,
						)
						return rows.map((r) => ({
							bucket: DateTime.formatIso(r.bucket),
							series: r.spanName,
							// Per bucket: the chart's `requests_per_sec` unit turns it into a rate.
							value: r.count,
						}))
					},
	})
}

/**
 * Latency, throughput, error rate and Apdex over the chart window, from the service's
 * entry spans (the same `rootOnly` scope as the header stats). The cache holds the raw
 * buckets; `select` fills them against the current window, so a window that narrows once
 * the overview's first-seen time lands redraws without a refetch.
 */
export function useLocalServiceGoldenSignals(serviceName: string, bounds: TimeBounds, window: ChartWindow) {
	const { bucketSeconds } = window
	const select = useCallback(
		(rows: ReadonlyArray<GoldenSignalRow>) => fillGoldenSignals(rows, window),
		[window],
	)
	return useQuery({
		queryKey: ["local", "services", "golden-signals", serviceName, bucketSeconds, boundsKey(bounds)],
		placeholderData: keepPreviousData,
		select,
		queryFn: async ({ signal }): Promise<ReadonlyArray<GoldenSignalRow>> => {
			const rows = await executeLocalCompiledQuery(
				CH.compile(
					CH.tracesTimeseriesQuery({
						metric: "count",
						needsSampling: false,
						allMetrics: true,
						serviceName,
						rootOnly: true,
						bucketSeconds,
					}),
					{ ...localParams(bounds), bucketSeconds },
				),
				signal,
			)
			return rows.map((row) => ({
				bucketMs: DateTime.toEpochMillis(row.bucket),
				count: row.count,
				errorRate: row.errorRate,
				p50Ms: row.p50Duration,
				p95Ms: row.p95Duration,
				p99Ms: row.p99Duration,
				apdexScore: row.apdexScore,
			}))
		},
	})
}
