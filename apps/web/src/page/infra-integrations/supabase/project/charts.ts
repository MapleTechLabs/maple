import { hasMetricData, type MetricChart } from "../../kit/metric-charts"
import type { SupabaseProjectTimeseriesRow } from "../model"

// The project page's charts. A series picks null for a bucket without a sample, which draws a gap.

type Row = SupabaseProjectTimeseriesRow

export interface SupabaseChart extends MetricChart<Row> {
	/** Shown only once a bucket has a sample: not every project exposes it. */
	readonly isOptional?: boolean
}

const when = (hasSample: (row: Row) => boolean, pick: (row: Row) => number) => (row: Row) =>
	hasSample(row) ? pick(row) : null

const hasMemory = (row: Row) => row.memoryTotal > 0
const hasDisk = (row: Row) => row.diskSize > 0
const hasDbSize = (row: Row) => row.dbSize > 0
const hasAuth = (row: Row) => row.authSamples > 0
const hasPostgrestPool = (row: Row) => row.postgrestPoolMax > 0

export const CHARTS: ReadonlyArray<SupabaseChart> = [
	{ id: "CPU", unit: "percent", series: [["Busy", (row) => row.cpu]] },
	{
		id: "Memory",
		unit: "percent",
		series: [
			["Average", when(hasMemory, (row) => row.memoryAvg)],
			["Peak", when(hasMemory, (row) => row.memoryMax)],
		],
	},
	{
		id: "Disk used",
		unit: "percent",
		series: [["Data volume", when(hasDisk, (row) => row.diskUsed)]],
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
	{ id: "Cache hit ratio", unit: "percent", series: [["Buffer cache hits", (row) => row.cacheHitRatio]] },
	{
		id: "Database size",
		unit: "bytes",
		series: [["Size", when(hasDbSize, (row) => row.dbSize)]],
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
		series: [["Users", when(hasAuth, (row) => row.authUsers)]],
		isOptional: true,
	},
	{
		id: "PostgREST pool",
		unit: "count",
		series: [
			["In use", when(hasPostgrestPool, (row) => row.postgrestPoolInUse)],
			["Waiting", when(hasPostgrestPool, (row) => row.postgrestPoolWaiting)],
		],
		isOptional: true,
	},
]

export const CHART_IDS = CHARTS.map((chart) => chart.id)

/** Every core chart, plus the optional ones the project actually reports. */
export const visibleCharts = (buckets: ReadonlyArray<Row>): ReadonlyArray<SupabaseChart> =>
	CHARTS.filter((chart) => chart.isOptional !== true || hasMetricData(chart, buckets))
