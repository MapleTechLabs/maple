import type { ChartUnit, LongRow } from "../../../../charts/infra-metric-series"
import type { SupabaseProjectTimeseriesRow } from "../model"

// The project page's charts: which series each draws, and which buckets count as data.

type Row = SupabaseProjectTimeseriesRow

export interface SupabaseChart {
	readonly id: string
	readonly unit: ChartUnit
	readonly series: ReadonlyArray<readonly [string, (row: Row) => number]>
	/** Buckets without a sample of the metric are left out instead of drawn as zero. */
	readonly hasSample?: (row: Row) => boolean
	/** Shown only once a bucket has a sample: not every project exposes it. */
	readonly isOptional?: boolean
}

export const CHARTS: ReadonlyArray<SupabaseChart> = [
	{ id: "CPU", unit: "percent", series: [["Busy", (row) => row.cpu]] },
	{
		id: "Memory",
		unit: "percent",
		series: [
			["Average", (row) => row.memoryAvg],
			["Peak", (row) => row.memoryMax],
		],
		hasSample: (row) => row.memoryTotal > 0,
	},
	{
		id: "Disk used",
		unit: "percent",
		series: [["Data volume", (row) => row.diskUsed]],
		hasSample: (row) => row.diskSize > 0,
	},
	{
		id: "Connections",
		unit: "count",
		series: [
			["Postgres backends", (row) => row.connectionsAvg],
			["Pooler clients", (row) => row.poolerClients],
		],
	},
	{
		id: "Transactions",
		unit: "rate",
		series: [
			["Commits", (row) => row.commitsPerSecond],
			["Rollbacks", (row) => row.rollbacksPerSecond],
		],
	},
	{
		id: "Cache hit ratio",
		unit: "percent",
		series: [["Buffer cache hits", (row) => row.cacheHitRatio]],
		hasSample: (row) => row.cacheReads > 0,
	},
	{
		id: "Database size",
		unit: "bytes",
		series: [["Size", (row) => row.dbSize]],
		hasSample: (row) => row.dbSize > 0,
	},
	{
		id: "Network",
		unit: "bytes_per_second",
		series: [
			["Received", (row) => row.networkRxPerSecond],
			["Sent", (row) => row.networkTxPerSecond],
		],
	},
	{
		id: "Disk I/O",
		unit: "bytes_per_second",
		series: [
			["Read", (row) => row.diskReadPerSecond],
			["Written", (row) => row.diskWritePerSecond],
		],
	},
	{
		id: "Auth users",
		unit: "count",
		series: [["Users", (row) => row.authUsers]],
		hasSample: (row) => row.authSamples > 0,
		isOptional: true,
	},
	{
		id: "PostgREST pool",
		unit: "count",
		series: [
			["In use", (row) => row.postgrestPoolInUse],
			["Waiting", (row) => row.postgrestPoolWaiting],
		],
		hasSample: (row) => row.postgrestPoolMax > 0,
		isOptional: true,
	},
]

export const CHART_IDS = CHARTS.map((chart) => chart.id)

/** One long row per (bucket, series), skipping buckets the chart has no sample for. */
export const chartRows = (chart: SupabaseChart, buckets: ReadonlyArray<Row>): ReadonlyArray<LongRow> =>
	buckets
		.filter((row) => chart.hasSample?.(row) ?? true)
		.flatMap((row) =>
			chart.series.map(([label, pick]) => ({
				bucket: row.bucket,
				attributeValue: label,
				value: pick(row),
			})),
		)

/** Every core chart, plus the optional ones the project actually reports. */
export const visibleCharts = (buckets: ReadonlyArray<Row>): ReadonlyArray<SupabaseChart> =>
	CHARTS.filter(
		(chart) => chart.isOptional !== true || buckets.some((row) => chart.hasSample?.(row) ?? true),
	)
