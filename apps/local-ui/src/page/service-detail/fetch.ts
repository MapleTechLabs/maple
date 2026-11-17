import { CH } from "@maple/query-engine"
import { parseClickHouseDateTime, type TimeBounds } from "../../lib/time"
import { DateTime, Effect, Option, Array as Arr } from "effect"
import { localParams, queryRows, queryRowsIfTableExists } from "../../data/local-query"
import { toCatalogEntry } from "../services/fetch"
import type { GoldenSignalRow, OperationRow, Overview, SeriesPoint, ServiceProfile } from "./model"

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
		if (row === undefined) return null
		const firstSeenMs = Arr.reduce(overviewRows, null, (earliest: number | null, overview) => {
			const ms = parseClickHouseDateTime(DateTime.formatIso(overview.firstSeen))
			return ms !== null && (earliest === null || ms < earliest) ? ms : earliest
		})
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
			Arr.map(rows, (row) => ({
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
			Arr.map(rows, (row) => ({
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
			Arr.map(rows, (row) => ({
				bucketMs: DateTime.toEpochMillis(row.bucket),
				count: row.count,
				errorRate: row.errorRate,
				p50Ms: row.p50Duration,
				p95Ms: row.p95Duration,
				p99Ms: row.p99Duration,
				apdexScore: row.apdexScore,
			})),
	)

/** The sample type the page opens on: CPU when the service sends it, else its heaviest type. */
const PREFERRED_SAMPLE_TYPE = "cpu"

/**
 * The service's profile in the window: which sample types it sent, then the heaviest stacks of
 * one of them. Null when it sent none, which is every service without a profiler.
 */
export const fetchProfile = (serviceName: string, bounds: TimeBounds, apiBase: string) =>
	Effect.gen(function* () {
		const params = { ...localParams(bounds), serviceName }
		const types = yield* queryRowsIfTableExists(
			CH.compile(CH.profileSampleTypesQuery({ service: true }), params),
			apiBase,
		)
		const chosen = Arr.findFirst(types, (row) => row.sampleType === PREFERRED_SAMPLE_TYPE).pipe(
			Option.orElse(() => Arr.head(types)),
			Option.getOrNull,
		)
		if (chosen === null) return null
		const stacks = yield* queryRows(
			CH.compile(CH.profileStacksQuery({ service: true, unit: true }), {
				...params,
				sampleType: chosen.sampleType,
				sampleUnit: chosen.sampleUnit,
			}),
			apiBase,
		)
		const profile: ServiceProfile = {
			sampleType: chosen.sampleType,
			sampleUnit: chosen.sampleUnit,
			totalValue: Number(stacks[0]?.totalValue ?? 0),
			totalStacks: Number(stacks[0]?.totalStacks ?? 0),
			durationNano: Number(chosen.durationNano),
			stacks: Arr.map(stacks, (row) => ({
				frames: row.frames,
				files: row.files,
				lines: Arr.map(row.lines, Number),
				value: Number(row.value),
			})),
		}
		return profile
	})
