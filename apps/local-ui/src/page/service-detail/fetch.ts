import { CH } from "@maple/query-engine"
import { parseClickHouseDateTime, type TimeBounds } from "../../lib/time"
import { DateTime, Effect } from "effect"
import { localParams, queryRows } from "../../data/local-query"
import { toCatalogEntry } from "../services/fetch"
import type { GoldenSignalRow, OperationRow, Overview, SeriesPoint } from "./model"

// The service detail page's queries.

/** Header stats from the catalog (merged t-digests) and the earliest entry span in the window. */
export const fetchOverview = (serviceName: string, bounds: TimeBounds, apiBase: string) =>
	Effect.gen(function* () {
		const params = localParams(bounds)
		const [catalogRows, overviewRows] = yield* Effect.all(
			[
				queryRows(CH.compile(CH.serviceCatalogQuery({ serviceName, limit: 1 }), params), apiBase),
				queryRows(CH.compile(CH.serviceOverviewQuery({ serviceName }), params), apiBase),
			],
			{ concurrency: "unbounded" },
		)
		const row = catalogRows[0]
		if (!row) return null
		const firstSeenMs = overviewRows.reduce<number | null>((earliest, overview) => {
			const ms = parseClickHouseDateTime(DateTime.formatIso(overview.firstSeen))
			return ms !== null && (earliest === null || ms < earliest) ? ms : earliest
		}, null)
		const overview: Overview = { stats: toCatalogEntry(row, 0), firstSeenMs }
		return overview
	})

export const fetchOperations = (serviceName: string, bounds: TimeBounds, apiBase: string) =>
	Effect.map(
		queryRows(
			CH.compile(CH.serviceOperationsSummaryQuery({ serviceName, limit: 25 }), localParams(bounds)),
			apiBase,
		),
		// A null average renders as legacy's null does: the empty value (`formatLatency`, `formatErrorRate`).
		(rows): ReadonlyArray<OperationRow> =>
			rows.map((row) => ({
				...row,
				errorRate: row.errorRate ?? Number.NaN,
				avgDurationMs: row.avgDurationMs ?? Number.NaN,
			})),
	)

/** Per-bucket span counts for the top operations: the chart's `requests_per_sec` makes them a rate. */
export const fetchOperationsTimeseries = (
	serviceName: string,
	spanNames: ReadonlyArray<string>,
	bucketSeconds: number,
	bounds: TimeBounds,
	apiBase: string,
) =>
	Effect.map(
		queryRows(
			CH.compile(CH.serviceOperationsTimeseriesQuery({ serviceName, spanNames, bucketSeconds }), {
				...localParams(bounds),
				bucketSeconds,
			}),
			apiBase,
		),
		(rows): ReadonlyArray<SeriesPoint> =>
			rows.map((row) => ({
				bucket: DateTime.formatIso(row.bucket),
				series: row.spanName,
				value: row.count,
			})),
	)

/** Latency, throughput, error rate and Apdex from the service's entry spans (`rootOnly`). */
export const fetchGoldenSignals = (
	serviceName: string,
	bucketSeconds: number,
	bounds: TimeBounds,
	apiBase: string,
) =>
	Effect.map(
		queryRows(
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
			apiBase,
		),
		(rows): ReadonlyArray<GoldenSignalRow> =>
			rows.map((row) => ({
				bucketMs: DateTime.toEpochMillis(row.bucket),
				count: row.count,
				errorRate: row.errorRate,
				p50Ms: row.p50Duration,
				p95Ms: row.p95Duration,
				p99Ms: row.p99Duration,
				apdexScore: row.apdexScore,
			})),
	)
