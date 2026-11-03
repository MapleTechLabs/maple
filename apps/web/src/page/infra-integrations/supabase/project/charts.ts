import type { MetricChart } from "../../kit/metric-charts"
import type { SupabaseProjectTimeseriesRow } from "../model"

// The Postgres row's two charts; the API requests bars are the page's third chart model.

type Row = SupabaseProjectTimeseriesRow

export const CHART_IDS = ["traffic", "connections", "transactions"] as const

/** Pooler clients and backends, plus Postgres' `max_connections` where a bucket reported it. */
export const CONNECTIONS_CHART: MetricChart<Row> = {
	id: "connections",
	unit: "count",
	series: [
		["Pooler clients", (row) => row.poolerClients],
		["Postgres backends", (row) => row.connectionsAvg],
		["Limit", (row) => row.maxConnections],
	],
}

export const TRANSACTIONS_CHART: MetricChart<Row> = {
	id: "transactions",
	unit: "rate",
	series: [
		["Commits", (row) => row.commitsPerSecond],
		["Rollbacks", (row) => row.rollbacksPerSecond],
	],
}
